require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. അടിസ്ഥാന മിഡിൽവെയറുകൾ
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 2. സെഷൻ മിഡിൽവെയർ
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key_here',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 1000 * 60 * 60 * 24 // 1 ദിവസം
  }
}));

// 3. EJS പേജുകളിൽ user വേരിയബിൾ ലഭ്യമാക്കാൻ
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// വ്യൂ എഞ്ചിൻ
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ================= GOOGLE SHEETS SETUP =================

// Private Key ഫോർമാറ്റ് കൃത്യമാക്കാനുള്ള ഫംഗ്ഷൻ (DECODER routines::unsupported എറർ ഒഴിവാക്കാൻ)
function formatPrivateKey(key) {
  if (!key) return '';
  return key
    .replace(/^["']|["']$/g, '')          // ചുറ്റുമുള്ള ഇരട്ട/ഒറ്റ ഉദ്ധരണികൾ ഒഴിവാക്കുന്നു
    .replace(/\\n/g, '\n')                 // ലിറ്ററൽ \n മാറ്റി ശരിയായ ന്യൂലൈൻ ആക്കുന്നു
    .trim();
}

// ================= GOOGLE SHEETS SETUP =================
const creds = require('./google-creds.json');

const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);

async function getSheet(sheetTitle) {
  await doc.loadInfo();
  return doc.sheetsByTitle[sheetTitle];
}

// ================= പെർമിഷൻ ഫംഗ്ഷനുകൾ (Middlewares) =================

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
}

function checkManage(req, res, next) {
  if (req.session.user && req.session.user.can_manage == 1) {
    next();
  } else {
    res.status(403).send("ഈ പേജ് തുറക്കാൻ നിങ്ങൾക്ക് അനുമതിയില്ല!");
  }
}

function checkStudent(req, res, next) {
  if (req.session.user && req.session.user.can_studet == 1) {
    next();
  } else {
    res.status(403).send("ഈ പേജ് തുറക്കാൻ നിങ്ങൾക്ക് അനുമതിയില്ല!");
  }
}

function checkAttendance(req, res, next) {
  if (req.session.user && req.session.user.can_attendance == 1) {
    next();
  } else {
    res.status(403).send("ഈ പേജ് തുറക്കാൻ നിങ്ങൾക്ക് അനുമതിയില്ല!");
  }
}

function checkAttendanceView(req, res, next) {
  if (req.session.user && req.session.user.can_attendanceveiw == 1) {
    next();
  } else {
    res.status(403).send("ഈ പേജ് തുറക്കാൻ നിങ്ങൾക്ക് അനുമതിയില്ല!");
  }
}

// ================= AUTH ROUTES =================
app.get('/', (req, res) => {
  res.redirect('/login');
});

// ഡാഷ്‌ബോർഡ്
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const studentSheet = await getSheet('students');
    const userSheet = await getSheet('users');
    const attSheet = await getSheet('attendance');

    const studentRows = await studentSheet.getRows();
    const userRows = await userSheet.getRows();
    const attRows = await attSheet.getRows();

    const totalStudents = studentRows.filter(r => (r.get('status') || '').trim().toLowerCase() === 'active').length;
    const totalUsers = userRows.length;
    const totalAttendance = attRows.length;

    res.render('dashboard', { totalStudents, totalUsers, totalAttendance });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

// ലോഗിൻ പേജ്
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

// ലോഗിൻ പരിശോധന
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const sheet = await getSheet('users');
    const rows = await sheet.getRows();

    const matchedUser = rows.find(r => 
      String(r.get('username')).trim() === String(username).trim() && 
      String(r.get('password')).trim() === String(password).trim()
    );

    if (matchedUser) {
      req.session.user = {
        id: matchedUser.get('id'),
        username: matchedUser.get('username'),
        can_attendance: parseInt(matchedUser.get('can_attendance') || 0),
        can_manage: parseInt(matchedUser.get('can_manage') || 0),
        can_attendanceveiw: parseInt(matchedUser.get('can_attendanceveiw') || 0),
        can_studet: parseInt(matchedUser.get('can_studet') || 0)
      };
      res.redirect('/dashboard');
    } else {
      res.render('login', { error: 'Username അല്ലെങ്കിൽ Password തെറ്റാണ്!' });
    }
  } catch (err) {
    res.status(500).render('login', { error: 'സെർവർ എറർ: ' + err.message });
  }
});

// ലോഗ് ഔട്ട്
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// ================= 2. SETTINGS =================
app.get('/settings', requireAuth, checkManage, async (req, res) => {
  try {
    const batchSheet = await getSheet('batches');
    const subjectSheet = await getSheet('subjects');
    const userSheet = await getSheet('users');

    const bRows = await batchSheet.getRows();
    const sRows = await subjectSheet.getRows();
    const uRows = await userSheet.getRows();

    const batches = bRows.map(r => ({ id: r.get('id'), name: r.get('name') })).reverse();
    const subjects = sRows.map(r => ({ id: r.get('id'), name: r.get('name') })).reverse();
    const users = uRows.map(r => ({ id: r.get('id'), username: r.get('username') })).reverse();

    res.render('add', { batches, subjects, users });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Batch APIs
app.post('/api/batches', requireAuth, checkManage, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name required' });
    const sheet = await getSheet('batches');
    await sheet.addRow({ id: Date.now().toString(), name: name.trim() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/batches/:id', requireAuth, checkManage, async (req, res) => {
  try {
    const sheet = await getSheet('batches');
    const rows = await sheet.getRows();
    const row = rows.find(r => String(r.get('id')) === String(req.params.id));
    if (row) await row.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Subject APIs
app.post('/api/subjects', requireAuth, checkManage, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name required' });
    const sheet = await getSheet('subjects');
    await sheet.addRow({ id: Date.now().toString(), name: name.trim() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/subjects/:id', requireAuth, checkManage, async (req, res) => {
  try {
    const sheet = await getSheet('subjects');
    const rows = await sheet.getRows();
    const row = rows.find(r => String(r.get('id')) === String(req.params.id));
    if (row) await row.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// User APIs
app.post('/api/users', requireAuth, checkManage, async (req, res) => {
  const { username, password, can_attendance, can_manage, can_attendanceveiw, can_studet } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: 'All fields required' });
  try {
    const sheet = await getSheet('users');
    await sheet.addRow({
      id: Date.now().toString(),
      username: username.trim(),
      password: password.trim(),
      can_attendance: can_attendance ? '1' : '0',
      can_manage: can_manage ? '1' : '0',
      can_attendanceveiw: can_attendanceveiw ? '1' : '0',
      can_studet: can_studet ? '1' : '0'
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/users/:id', requireAuth, checkManage, async (req, res) => {
  try {
    const sheet = await getSheet('users');
    const rows = await sheet.getRows();
    const row = rows.find(r => String(r.get('id')) === String(req.params.id));
    if (row) await row.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 3. STUDENTS =================
app.get('/students', requireAuth, checkStudent, async (req, res) => {
  try {
    const studentSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');

    const sRows = await studentSheet.getRows();
    const bRows = await batchSheet.getRows();

    const batchMap = {};
    const batches = bRows.map(r => {
      batchMap[r.get('id')] = r.get('name');
      return { id: r.get('id'), name: r.get('name') };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const students = sRows
      .filter(r => (r.get('status') || '').trim().toLowerCase() === 'active')
      .map(r => ({
        id: r.get('id'),
        admission_no: r.get('admission_no'),
        full_name: r.get('full_name'),
        age: r.get('age'),
        phone: r.get('phone'),
        batch_id: r.get('batch_id'),
        batch_name: batchMap[r.get('batch_id')] || 'N/A',
        status: r.get('status')
      }))
      .sort((a, b) => {
        if (a.batch_id !== b.batch_id) return (a.batch_id || '').localeCompare(b.batch_id || '');
        const admA = parseInt(String(a.admission_no).replace(/\D/g, '')) || 0;
        const admB = parseInt(String(b.admission_no).replace(/\D/g, '')) || 0;
        return admA - admB;
      });

    res.render('studet', { students, batches });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

app.post('/api/students', requireAuth, checkStudent, async (req, res) => {
  try {
    const { full_name, age, phone, batch_id, admission_no } = req.body;
    const sheet = await getSheet('students');
    await sheet.addRow({
      id: Date.now().toString(),
      full_name: full_name ? full_name.trim() : '',
      admission_no: admission_no ? admission_no.trim() : '',
      age: age ? String(age) : '',
      phone: phone ? String(phone) : '',
      batch_id: batch_id ? String(batch_id) : '',
      status: 'active'
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/students/:id', requireAuth, checkStudent, async (req, res) => {
  try {
    const { full_name, age, phone, batch_id, admission_no } = req.body;
    const sheet = await getSheet('students');
    const rows = await sheet.getRows();
    const row = rows.find(r => String(r.get('id')) === String(req.params.id));

    if (row) {
      row.set('full_name', full_name ? full_name.trim() : '');
      row.set('admission_no', admission_no ? admission_no.trim() : '');
      row.set('age', age ? String(age) : '');
      row.set('phone', phone ? String(phone) : '');
      row.set('batch_id', batch_id ? String(batch_id) : '');
      await row.save();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 4. ATTENDANCE =================
app.get('/attendance', requireAuth, checkAttendance, async (req, res) => {
  try {
    const batchSheet = await getSheet('batches');
    const subjectSheet = await getSheet('subjects');

    const bRows = await batchSheet.getRows();
    const sRows = await subjectSheet.getRows();

    const batches = bRows.map(r => ({ id: r.get('id'), name: r.get('name') })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const subjects = sRows.map(r => ({ id: r.get('id'), name: r.get('name') })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.render('attanten', { batches, subjects });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

app.get('/api/attendance-data', requireAuth, checkAttendance, async (req, res) => {
  const { batch_id, subject_id, date } = req.query;

  if (!batch_id || !subject_id || !date) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  try {
    const studentSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');
    const attSheet = await getSheet('attendance');

    const [sRows, bRows, attRows] = await Promise.all([
      studentSheet.getRows(),
      batchSheet.getRows(),
      attSheet.getRows()
    ]);

    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    let students = sRows
      .filter(r => (r.get('status') || '').trim().toLowerCase() === 'active')
      .map(r => ({
        id: r.get('id'),
        admission_no: r.get('admission_no'),
        full_name: r.get('full_name'),
        batch_id: r.get('batch_id'),
        batch_name: batchMap[r.get('batch_id')] || 'N/A'
      }));

    if (batch_id !== 'all') {
      students = students.filter(s => String(s.batch_id) === String(batch_id));
    }

    students.sort((a, b) => {
      if (a.batch_id !== b.batch_id) return (a.batch_id || '').localeCompare(b.batch_id || '');
      const admA = parseInt(String(a.admission_no).replace(/\D/g, '')) || 0;
      const admB = parseInt(String(b.admission_no).replace(/\D/g, '')) || 0;
      return admA - admB;
    });

    const statusMap = {};
    attRows.forEach(r => {
      const matchDate = String(r.get('date')).trim() === String(date).trim();
      const matchBatch = batch_id === 'all' || String(r.get('batch_id')) === String(batch_id);
      const matchSub = subject_id === 'all' || String(r.get('subject_id')) === String(subject_id);

      if (matchDate && matchBatch && matchSub) {
        statusMap[r.get('student_id')] = r.get('status');
      }
    });

    res.json({ success: true, students, statusMap });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/save-attendance', requireAuth, checkAttendance, async (req, res) => {
  const { subject_id, date, records } = req.body;

  if (!subject_id || !date || !records || records.length === 0) {
    return res.status(400).json({ success: false, error: 'വിവരങ്ങൾ അപൂർണ്ണമാണ്!' });
  }

  try {
    const attSheet = await getSheet('attendance');
    const existingRows = await attSheet.getRows();

    for (const r of records) {
      const matchedRow = existingRows.find(row => 
        String(row.get('student_id')) === String(r.student_id) &&
        String(row.get('date')).trim() === String(date).trim() &&
        String(row.get('subject_id')) === String(subject_id)
      );

      if (matchedRow) {
        matchedRow.set('status', r.status);
        matchedRow.set('batch_id', r.batch_id);
        await matchedRow.save();
      } else {
        await attSheet.addRow({
          id: Date.now().toString() + Math.floor(Math.random() * 1000),
          student_id: r.student_id,
          batch_id: r.batch_id,
          subject_id: subject_id,
          date: date,
          status: r.status
        });
      }
    }

    res.json({ success: true, message: 'ഹാജർ വിജയകരമായി സേവ് ചെയ്തു!' });
  } catch (err) {
    console.error("Save Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 5. MONTHLY MATRIX =================
app.get('/monthly-report', requireAuth, checkAttendanceView, async (req, res) => {
  try {
    const batchSheet = await getSheet('batches');
    const subjectSheet = await getSheet('subjects');

    const [bRows, sRows] = await Promise.all([batchSheet.getRows(), subjectSheet.getRows()]);

    const batches = bRows.map(r => ({ id: r.get('id'), name: r.get('name') })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const subjects = sRows.map(r => ({ id: r.get('id'), name: r.get('name') })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.render('attveiw', { batches, subjects });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

app.get('/api/monthly-matrix', requireAuth, checkAttendanceView, async (req, res) => {
  const { batch_id, subject_id, month, year } = req.query;

  if (!batch_id || !month || !year) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  try {
    const daysInMonth = new Date(year, month, 0).getDate();

    const studentSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');
    const attSheet = await getSheet('attendance');

    const [sRows, bRows, attRows] = await Promise.all([
      studentSheet.getRows(),
      batchSheet.getRows(),
      attSheet.getRows()
    ]);

    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    let students = sRows
      .filter(r => (r.get('status') || '').trim().toLowerCase() === 'active')
      .map(r => ({
        id: r.get('id'),
        admission_no: r.get('admission_no'),
        full_name: r.get('full_name'),
        batch_id: r.get('batch_id'),
        batch_name: batchMap[r.get('batch_id')] || 'N/A'
      }));

    if (batch_id !== 'all') {
      students = students.filter(s => String(s.batch_id) === String(batch_id));
    }

    students.sort((a, b) => {
      if (a.batch_id !== b.batch_id) return (a.batch_id || '').localeCompare(b.batch_id || '');
      const admA = parseInt(String(a.admission_no).replace(/\D/g, '')) || 0;
      const admB = parseInt(String(b.admission_no).replace(/\D/g, '')) || 0;
      return admA - admB;
    });

    const attMap = {};
    attRows.forEach(r => {
      const rowDate = new Date(r.get('date'));
      if (isNaN(rowDate.getTime())) return;

      const rMonth = rowDate.getMonth() + 1;
      const rYear = rowDate.getFullYear();
      const rDay = rowDate.getDate();

      const matchMonth = rMonth === parseInt(month);
      const matchYear = rYear === parseInt(year);
      const matchBatch = batch_id === 'all' || String(r.get('batch_id')) === String(batch_id);
      const matchSub = !subject_id || subject_id === 'all' || String(r.get('subject_id')) === String(subject_id);

      if (matchMonth && matchYear && matchBatch && matchSub) {
        const studentId = r.get('student_id');
        if (!attMap[studentId]) attMap[studentId] = {};
        attMap[studentId][rDay] = r.get('status');
      }
    });

    res.json({ success: true, students, attMap, daysInMonth });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/student-day-details', requireAuth, checkAttendanceView, async (req, res) => {
  const { student_id, date } = req.query;
  if (!student_id || !date) {
    return res.status(400).json({ success: false, error: 'Student ID and Date required' });
  }

  try {
    const studentSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');
    const subjectSheet = await getSheet('subjects');
    const attSheet = await getSheet('attendance');

    const [sRows, bRows, subRows, attRows] = await Promise.all([
      studentSheet.getRows(),
      batchSheet.getRows(),
      subjectSheet.getRows(),
      attSheet.getRows()
    ]);

    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    const subjectMap = {};
    subRows.forEach(r => { subjectMap[r.get('id')] = r.get('name'); });

    const studentRow = sRows.find(r => String(r.get('id')) === String(student_id));
    if (!studentRow) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    const student = {
      id: studentRow.get('id'),
      admission_no: studentRow.get('admission_no'),
      full_name: studentRow.get('full_name'),
      batch_name: batchMap[studentRow.get('batch_id')] || 'N/A'
    };

    const sessions = attRows
      .filter(r => String(r.get('student_id')) === String(student_id) && String(r.get('date')).trim() === String(date).trim())
      .map(r => ({
        subject_name: subjectMap[r.get('subject_id')] || 'General',
        status: r.get('status'),
        created_at: r.get('date')
      }));

    res.json({ success: true, student, sessions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));