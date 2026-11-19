require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Base Middlewares
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 2. Multer File Upload Setup (Photo & Identity Doc)
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });
const admUploads = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'aadhaar_doc', maxCount: 1 }
]);

// 3. Session Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key_here',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// 4. Expose user to EJS views
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.status(204).end();
});

// ================= GOOGLE SHEETS SETUP =================
function formatPrivateKey(key) {
  if (!key) return '';
  return key
    .replace(/^["']|["']$/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .trim();
}

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: formatPrivateKey(process.env.GOOGLE_PRIVATE_KEY),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);

async function getSheet(sheetTitle) {
  await doc.loadInfo();
  return doc.sheetsByTitle[sheetTitle];
}

// Generate next permanent Admission Number (ADM1001, ADM1002...)
function generateNextAdmissionNo(admRows, stuRows = []) {
  let maxNum = 1000;
  [...admRows, ...stuRows].forEach(r => {
    const adm = String(r.get('admission_no') || '').trim();
    const num = parseInt(adm.replace(/\D/g, ''));
    if (!isNaN(num) && num > maxNum) {
      maxNum = num;
    }
  });
  return `ADM${maxNum + 1}`;
}

// Password Hash & Verify Helpers
async function hashPassword(plainPassword) {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(String(plainPassword).trim(), salt);
}

async function verifyPassword(inputPassword, storedPassword) {
  const cleanInput = String(inputPassword || '').trim();
  const cleanStored = String(storedPassword || '').trim();
  if (!cleanStored) return false;
  if (cleanStored.startsWith('$2a$') || cleanStored.startsWith('$2b$')) {
    return await bcrypt.compare(cleanInput, cleanStored);
  }
  return cleanInput === cleanStored;
}

// ================= PERMISSION MIDDLEWARES =================
function requireAuth(req, res, next) {
  if (req.session && req.session.user) next();
  else res.redirect('/login');
}

function checkManage(req, res, next) {
  if (req.session.user && req.session.user.can_manage == 1) next();
  else res.status(403).send("Access Denied: You do not have permission to view this page.");
}

function checkStudent(req, res, next) {
  if (req.session.user && req.session.user.can_studet == 1) next();
  else res.status(403).send("Access Denied: You do not have permission to manage students.");
}

function checkAttendance(req, res, next) {
  if (req.session.user && req.session.user.can_attendance == 1) next();
  else res.status(403).send("Access Denied: You do not have permission to mark attendance.");
}

function checkAttendanceView(req, res, next) {
  if (req.session.user && req.session.user.can_attendanceveiw == 1) next();
  else res.status(403).send("Access Denied: You do not have permission to view attendance reports.");
}

// ================= AUTH ROUTES =================
app.get('/', (req, res) => res.redirect('/login'));

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const studentSheet = await getSheet('students');
    const subjectSheet = await getSheet('subjects');
    const attSheet = await getSheet('attendance');

    const [studentRows, subjectRows, attRows] = await Promise.all([
      studentSheet.getRows(),
      subjectSheet.getRows(),
      attSheet.getRows()
    ]);

    const totalStudents = studentRows.filter(r => (r.get('status') || '').trim().toLowerCase() === 'active').length;
    const totalSubjects = subjectRows.filter(r => (r.get('name') || '').trim() !== '').length;

    const conductedSessions = new Set();
    attRows.forEach(r => {
      const d = String(r.get('date') || '').trim();
      const b = String(r.get('batch_id') || '').trim();
      const s = String(r.get('subject_id') || '').trim();
      if (d && s) conductedSessions.add(`${d}_${b}_${s}`);
    });
    const totalClassesConducted = conductedSessions.size;

    res.render('dashboard', { totalStudents, totalSubjects, totalClassesConducted });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const sheet = await getSheet('users');
    const rows = await sheet.getRows();

    const matchedUser = rows.find(r => String(r.get('username')).trim() === String(username).trim());

    if (matchedUser && await verifyPassword(password, matchedUser.get('password'))) {
      req.session.user = {
        id: matchedUser.get('id'),
        username: matchedUser.get('username'),
        can_attendance: parseInt(matchedUser.get('can_attendance') || 0),
        can_manage: parseInt(matchedUser.get('can_manage') || 0),
        can_attendanceveiw: parseInt(matchedUser.get('can_attendanceveiw') || 0),
        can_studet: parseInt(matchedUser.get('can_studet') || 0),
        role: String(matchedUser.get('role') || 'admin').trim(),
        allowed_batch: String(matchedUser.get('allowed_batch') || 'all').trim(),
        allowed_subject: String(matchedUser.get('allowed_subject') || 'all').trim(),
        can_update: matchedUser.get('can_update') !== undefined && matchedUser.get('can_update') !== '' 
          ? parseInt(matchedUser.get('can_update')) 
          : 1
      };
      res.redirect('/dashboard');
    } else {
      res.render('login', { error: 'Invalid username or password!' });
    }
  } catch (err) {
    res.status(500).render('login', { error: 'Server Error: ' + err.message });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ================= 2. SETTINGS & CLEAR ALL =================
app.get('/settings', requireAuth, checkManage, async (req, res) => {
  try {
    const batchSheet = await getSheet('batches');
    const subjectSheet = await getSheet('subjects');
    const userSheet = await getSheet('users');

    const [bRows, sRows, uRows] = await Promise.all([
      batchSheet.getRows(),
      subjectSheet.getRows(),
      userSheet.getRows()
    ]);

    const batches = bRows.map(r => ({ id: r.get('id'), name: r.get('name') })).reverse();
    const subjects = sRows.map(r => ({ id: r.get('id'), name: r.get('name'), batch_id: r.get('batch_id') })).reverse();
    const users = uRows.map(r => ({ id: r.get('id'), username: r.get('username'), role: r.get('role') || 'admin' })).reverse();

    res.render('add', { batches, subjects, users });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

app.post('/api/batches', requireAuth, checkManage, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Batch name is required!' });
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

app.post('/api/subjects', requireAuth, checkManage, async (req, res) => {
  try {
    const { name, batch_id } = req.body;
    if (!name || !batch_id) return res.status(400).json({ success: false, error: 'Subject name and batch are required!' });
    const sheet = await getSheet('subjects');
    await sheet.addRow({ id: Date.now().toString(), name: name.trim(), batch_id: String(batch_id).trim() });
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

app.post('/api/users', requireAuth, checkManage, async (req, res) => {
  const { 
    username, password, role, allowed_batch, allowed_subject,
    can_attendance, can_update, can_manage, can_attendanceveiw, can_studet 
  } = req.body;

  if (!username || !password) return res.status(400).json({ success: false, error: 'Username and password are required!' });

  let finalBatch = 'all';
  let finalSubject = 'all';

  if (role === 'batch_leader' && allowed_batch) finalBatch = String(allowed_batch).trim();
  else if (role === 'subject_leader' && allowed_batch && allowed_subject) {
    finalBatch = String(allowed_batch).trim();
    finalSubject = String(allowed_subject).trim();
  }

  try {
    const sheet = await getSheet('users');
    const hashedPassword = await hashPassword(password);

    await sheet.addRow({
      id: Date.now().toString(),
      username: username.trim(),
      password: hashedPassword,
      role: role || 'admin',
      allowed_batch: finalBatch,
      allowed_subject: finalSubject,
      can_attendance: can_attendance ? '1' : '0',
      can_update: can_update ? '1' : '0',
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

// Clear All Data Route (Attendance, Students, Subjects, Batches, Users)
app.delete('/api/clear/:target', requireAuth, checkManage, async (req, res) => {
  const target = req.params.target;
  const allowedTargets = ['attendance', 'students', 'subjects', 'batches', 'users'];

  if (!allowedTargets.includes(target)) {
    return res.status(400).json({ success: false, error: 'Invalid clear target!' });
  }

  try {
    const sheet = await getSheet(target);
    if (!sheet) return res.status(404).json({ success: false, error: `Sheet "${target}" not found!` });

    const rows = await sheet.getRows();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (target === 'users' && String(rows[i].get('username')).trim() === req.session.user.username) {
        continue; // Keep currently logged-in admin safe
      }
      await rows[i].delete();
    }

    if (target === 'students') {
      const admSheet = await getSheet('admissions');
      if (admSheet) {
        const admRows = await admSheet.getRows();
        for (let i = admRows.length - 1; i >= 0; i--) {
          await admRows[i].delete();
        }
      }
    }

    res.json({ success: true, message: `All ${target} records have been cleared successfully!` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to clear records: ' + err.message });
  }
});

// ================= 3. ADMISSIONS (Controlled by admission_no) =================
app.get('/admissions', requireAuth, checkStudent, async (req, res) => {
  try {
    const admSheet = await getSheet('admissions');
    const stuSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');

    if (!admSheet) return res.status(500).send('Please create the "admissions" tab in your Google Sheet.');

    const [aRows, sRows, bRows] = await Promise.all([
      admSheet.getRows(),
      stuSheet.getRows(),
      batchSheet.getRows()
    ]);

    const batchMap = {};
    const batches = bRows.map(r => {
      batchMap[r.get('id')] = r.get('name');
      return { id: r.get('id'), name: r.get('name') };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const nextAdmissionNo = generateNextAdmissionNo(aRows, sRows);

    const allStudents = aRows
      .filter(r => (r.get('full_name') || '').trim() !== '')
      .map(r => {
        const rawBatchIds = String(r.get('batch_id') || '').split(',').map(id => id.trim()).filter(Boolean);
        const batchNames = rawBatchIds.map(id => batchMap[id]).filter(Boolean).join(', ');
        return {
          admission_no: String(r.get('admission_no') || '').trim(),
          roll_no: r.get('roll_no') || '',
          full_name: r.get('full_name'),
          dob: r.get('dob') || '',
          father_name: r.get('father_name') || '',
          phone: r.get('phone') || '',
          aadhaar_no: r.get('aadhaar_no') || '',
          aadhaar_file: r.get('aadhaar_file') || '',
          photo_file: r.get('photo_file') || '',
          address: r.get('address') || '',
          batch_id: r.get('batch_id') || '',
          batch_name: batchNames || 'No Batch',
          status: (r.get('status') || 'pending').trim().toLowerCase()
        };
      })
      .reverse();

    res.render('admission', { batches, allStudents, nextAdmissionNo });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

// Create Admission / Draft
app.post('/api/admissions', requireAuth, checkStudent, admUploads, async (req, res) => {
  try {
    const { full_name, dob, roll_no, father_name, phone, aadhaar_no, address, batch_id, password, status } = req.body;
    if (!full_name || !dob) {
      return res.status(400).json({ success: false, error: 'Full Name and Date of Birth are required!' });
    }

    const admSheet = await getSheet('admissions');
    const stuSheet = await getSheet('students');
    const [aRows, sRows] = await Promise.all([admSheet.getRows(), stuSheet.getRows()]);

    const permanentAdmNo = generateNextAdmissionNo(aRows, sRows);
    const rawPass = password ? String(password).trim() : permanentAdmNo;
    const hashedPassword = await hashPassword(rawPass);

    const photoPath = req.files?.photo?.[0] ? `/uploads/${req.files.photo[0].filename}` : '';
    const aadhaarPath = req.files?.aadhaar_doc?.[0] ? `/uploads/${req.files.aadhaar_doc[0].filename}` : '';

    await admSheet.addRow({
      admission_no: permanentAdmNo,
      roll_no: roll_no ? String(roll_no).trim() : '',
      full_name: full_name.trim(),
      dob: String(dob).trim(),
      father_name: father_name ? father_name.trim() : '',
      address: address ? address.trim() : '',
      aadhaar_no: aadhaar_no ? String(aadhaar_no).trim() : '',
      aadhaar_file: aadhaarPath,
      photo_file: photoPath,
      phone: phone ? String(phone).trim() : '',
      batch_id: batch_id ? String(batch_id).trim() : '',
      password: hashedPassword,
      status: status === 'draft' ? 'draft' : 'pending',
      created_at: new Date().toISOString().split('T')[0]
    });

    res.json({ success: true, admission_no: permanentAdmNo });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Edit Admission by admission_no
app.put('/api/admissions/:admNo', requireAuth, checkStudent, admUploads, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const { full_name, dob, roll_no, father_name, phone, aadhaar_no, address, batch_id, password, status } = req.body;

    const admSheet = await getSheet('admissions');
    const aRows = await admSheet.getRows();
    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);

    if (!admRow) return res.status(404).json({ success: false, error: 'Admission record not found!' });

    const photoPath = req.files?.photo?.[0] ? `/uploads/${req.files.photo[0].filename}` : admRow.get('photo_file');
    const aadhaarPath = req.files?.aadhaar_doc?.[0] ? `/uploads/${req.files.aadhaar_doc[0].filename}` : admRow.get('aadhaar_file');

    admRow.set('full_name', full_name.trim());
    admRow.set('dob', String(dob).trim());
    admRow.set('roll_no', roll_no ? String(roll_no).trim() : '');
    admRow.set('father_name', father_name ? father_name.trim() : '');
    admRow.set('phone', phone ? String(phone).trim() : '');
    admRow.set('aadhaar_no', aadhaar_no ? String(aadhaar_no).trim() : '');
    admRow.set('address', address ? address.trim() : '');
    admRow.set('batch_id', batch_id ? String(batch_id).trim() : '');
    if (password && password.trim() !== '') {
      admRow.set('password', await hashPassword(password));
    }
    if (status) admRow.set('status', status);
    admRow.set('photo_file', photoPath || '');
    admRow.set('aadhaar_file', aadhaarPath || '');
    await admRow.save();

    if (admRow.get('status') === 'active') {
      const stuSheet = await getSheet('students');
      const sRows = await stuSheet.getRows();
      const stuRow = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
      if (stuRow) {
        stuRow.set('full_name', admRow.get('full_name'));
        stuRow.set('dob', admRow.get('dob'));
        stuRow.set('roll_no', admRow.get('roll_no'));
        stuRow.set('father_name', admRow.get('father_name'));
        stuRow.set('phone', admRow.get('phone'));
        stuRow.set('batch_id', admRow.get('batch_id'));
        stuRow.set('password', admRow.get('password'));
        stuRow.set('photo_file', admRow.get('photo_file'));
        await stuRow.save();
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Make Active / Deactivate by admission_no
app.put('/api/admissions/:admNo/status', requireAuth, checkStudent, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const { status } = req.body;

    const admSheet = await getSheet('admissions');
    const stuSheet = await getSheet('students');
    const [aRows, sRows] = await Promise.all([admSheet.getRows(), stuSheet.getRows()]);

    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (!admRow) return res.status(404).json({ success: false, error: 'Admission record not found!' });

    if (status === 'active') {
      if (!admRow.get('batch_id')) {
        return res.status(400).json({ success: false, error: 'Please assign at least one batch via Edit before activating!' });
      }

      admRow.set('status', 'active');
      await admRow.save();

      const defaultPass = admRow.get('password') || await hashPassword(targetAdmNo);
      const existingStu = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);

      if (existingStu) {
        existingStu.set('status', 'active');
        existingStu.set('full_name', admRow.get('full_name'));
        existingStu.set('roll_no', admRow.get('roll_no') || '');
        existingStu.set('dob', admRow.get('dob') || '');
        existingStu.set('father_name', admRow.get('father_name') || '');
        existingStu.set('phone', admRow.get('phone') || '');
        existingStu.set('batch_id', admRow.get('batch_id') || '');
        existingStu.set('password', defaultPass);
        existingStu.set('photo_file', admRow.get('photo_file') || '');
        await existingStu.save();
      } else {
        await stuSheet.addRow({
          admission_no: targetAdmNo,
          roll_no: admRow.get('roll_no') || '',
          full_name: admRow.get('full_name'),
          dob: admRow.get('dob') || '',
          father_name: admRow.get('father_name') || '',
          phone: admRow.get('phone') || '',
          batch_id: admRow.get('batch_id') || '',
          password: defaultPass,
          photo_file: admRow.get('photo_file') || '',
          status: 'active'
        });
      }
    } else {
      admRow.set('status', 'pending');
      await admRow.save();

      const existingStu = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
      if (existingStu) await existingStu.delete();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Admission by admission_no
app.delete('/api/admissions/:admNo', requireAuth, checkStudent, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const admSheet = await getSheet('admissions');
    const stuSheet = await getSheet('students');
    const [aRows, sRows] = await Promise.all([admSheet.getRows(), stuSheet.getRows()]);

    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (admRow) await admRow.delete();

    const stuRow = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (stuRow) await stuRow.delete();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 4. ACTIVE STUDENTS LIST (Controlled by admission_no) =================
app.get('/students', requireAuth, checkStudent, async (req, res) => {
  try {
    const studentSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');

    const [sRows, bRows] = await Promise.all([studentSheet.getRows(), batchSheet.getRows()]);

    const batchMap = {};
    const batches = bRows.map(r => {
      batchMap[r.get('id')] = r.get('name');
      return { id: r.get('id'), name: r.get('name') };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const students = sRows
      .filter(r => (r.get('status') || '').trim().toLowerCase() === 'active' && (r.get('full_name') || '').trim() !== '')
      .map(r => {
        const rawBatchIds = String(r.get('batch_id') || '').split(',').map(id => id.trim()).filter(Boolean);
        const batchNames = rawBatchIds.map(id => batchMap[id]).filter(Boolean).join(', ');
        const admNo = String(r.get('admission_no') || '').trim();

        return {
          admission_no: admNo,
          roll_no: r.get('roll_no') || '',
          full_name: r.get('full_name'),
          dob: r.get('dob') || r.get('age') || '',
          father_name: r.get('father_name') || '',
          phone: r.get('phone') || '',
          batch_id: r.get('batch_id') || '',
          batch_name: batchNames || 'N/A',
          status: r.get('status')
        };
      })
      .sort((a, b) => {
        const rollA = parseInt(String(a.roll_no || a.admission_no).replace(/\D/g, '')) || 0;
        const rollB = parseInt(String(b.roll_no || b.admission_no).replace(/\D/g, '')) || 0;
        return rollA - rollB;
      });

    res.render('studet', { students, batches });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

// Set Hashed Password by admission_no
app.put('/api/students/:admNo/password', requireAuth, checkStudent, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, error: 'Password is required!' });

    const stuSheet = await getSheet('students');
    const admSheet = await getSheet('admissions');
    await stuSheet.loadHeaderRow();
    if (!stuSheet.headerValues.includes('password')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Column "password" is missing in the "students" sheet!' 
      });
    }

    const [sRows, aRows] = await Promise.all([stuSheet.getRows(), admSheet.getRows()]);
    const stuRow = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (!stuRow) return res.status(404).json({ success: false, error: 'Student not found!' });

    const hashedPassword = await hashPassword(password);

    stuRow.set('password', hashedPassword);
    await stuRow.save();

    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (admRow) {
      admRow.set('password', hashedPassword);
      await admRow.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Student by admission_no
app.put('/api/students/:admNo', requireAuth, checkStudent, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const { full_name, dob, phone, batch_id, roll_no, password } = req.body;

    const stuSheet = await getSheet('students');
    const admSheet = await getSheet('admissions');
    const [sRows, aRows] = await Promise.all([stuSheet.getRows(), admSheet.getRows()]);

    const hashedPassword = (password && password.trim() !== '') ? await hashPassword(password) : null;

    const row = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (row) {
      row.set('full_name', full_name ? full_name.trim() : '');
      row.set('roll_no', roll_no ? String(roll_no).trim() : '');
      if (dob !== undefined) row.set('dob', String(dob).trim());
      row.set('phone', phone ? String(phone).trim() : '');
      row.set('batch_id', batch_id ? String(batch_id) : '');
      if (hashedPassword) row.set('password', hashedPassword);
      await row.save();
    }

    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (admRow) {
      admRow.set('full_name', full_name ? full_name.trim() : '');
      admRow.set('roll_no', roll_no ? String(roll_no).trim() : '');
      if (dob !== undefined) admRow.set('dob', String(dob).trim());
      admRow.set('phone', phone ? String(phone).trim() : '');
      admRow.set('batch_id', batch_id ? String(batch_id) : '');
      if (hashedPassword) admRow.set('password', hashedPassword);
      await admRow.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Remove from Active Students by admission_no
app.delete('/api/students/:admNo', requireAuth, checkStudent, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const stuSheet = await getSheet('students');
    const admSheet = await getSheet('admissions');
    const [sRows, aRows] = await Promise.all([stuSheet.getRows(), admSheet.getRows()]);

    const row = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (!row) return res.status(404).json({ success: false, error: 'Student not found!' });
    await row.delete();

    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (admRow) {
      admRow.set('status', 'pending');
      await admRow.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 5. ATTENDANCE (Controlled by admission_no) =================
app.get('/attendance', requireAuth, checkAttendance, async (req, res) => {
  try {
    const batchSheet = await getSheet('batches');
    const subjectSheet = await getSheet('subjects');

    const [bRows, sRows] = await Promise.all([batchSheet.getRows(), subjectSheet.getRows()]);

    let batches = bRows.map(r => ({ id: r.get('id'), name: r.get('name') })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    let subjects = sRows.map(r => ({ id: r.get('id'), name: r.get('name'), batch_id: r.get('batch_id') })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const currentUser = req.session?.user || {};
    if (currentUser.allowed_batch && currentUser.allowed_batch !== 'all') {
      batches = batches.filter(b => String(b.id).trim() === String(currentUser.allowed_batch).trim());
    }
    if (currentUser.allowed_subject && currentUser.allowed_subject !== 'all') {
      subjects = subjects.filter(s => String(s.id).trim() === String(currentUser.allowed_subject).trim());
    }

    res.render('attanten', { batches, subjects, user: currentUser });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

app.get('/api/attendance-data', requireAuth, checkAttendance, async (req, res) => {
  const { batch_id, subject_id, date } = req.query;
  if (!batch_id || !subject_id || !date) return res.status(400).json({ success: false, error: 'Missing required parameters!' });

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
      .filter(r => (r.get('status') || '').trim().toLowerCase() === 'active' && (r.get('full_name') || '').trim() !== '')
      .map(r => {
        const admNo = String(r.get('admission_no') || '').trim();
        return {
          admission_no: admNo,
          roll_no: r.get('roll_no') || admNo,
          full_name: r.get('full_name'),
          batch_id: r.get('batch_id'),
          batch_name: batchMap[r.get('batch_id')] || 'N/A'
        };
      });

    if (batch_id !== 'all') {
      students = students.filter(s => {
        const studentBatches = String(s.batch_id || '').split(',').map(id => id.trim());
        return studentBatches.includes(String(batch_id).trim());
      });
    }

    students.sort((a, b) => {
      const admA = parseInt(String(a.roll_no || a.admission_no).replace(/\D/g, '')) || 0;
      const admB = parseInt(String(b.roll_no || b.admission_no).replace(/\D/g, '')) || 0;
      return admA - admB;
    });

    const statusMap = {};
    let savedBy = '';

    attRows.forEach(r => {
      const matchDate = String(r.get('date') || '').trim() === String(date).trim();
      const matchBatch = batch_id === 'all' || String(r.get('batch_id') || '').trim() === String(batch_id).trim();
      const matchSub = subject_id === 'all' || String(r.get('subject_id') || '').trim() === String(subject_id).trim();

      if (matchDate && matchBatch && matchSub) {
        const admKey = String(r.get('admission_no') || r.get('student_id') || '').trim();
        statusMap[admKey] = r.get('status');
        if (r.get('user')) savedBy = String(r.get('user')).trim();
      }
    });

    res.json({ success: true, students, statusMap, savedBy });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/save-attendance', requireAuth, checkAttendance, async (req, res) => {
  const { subject_id, date, records, user_name } = req.body;
  const sessionUser = req.session?.user || {};
  const loggedInUser = sessionUser.username || user_name || 'Admin';

  if (!subject_id || !date || !records || records.length === 0) {
    return res.status(400).json({ success: false, error: 'Incomplete attendance data!' });
  }

  if (sessionUser.allowed_subject && sessionUser.allowed_subject !== 'all') {
    if (String(subject_id).trim() !== String(sessionUser.allowed_subject).trim()) {
      return res.status(403).json({ success: false, error: 'Permission Denied: You are not authorized for this subject!' });
    }
  }

  if (sessionUser.allowed_batch && sessionUser.allowed_batch !== 'all') {
    const unauthorizedBatch = records.some(r => String(r.batch_id).trim() !== String(sessionUser.allowed_batch).trim());
    if (unauthorizedBatch) {
      return res.status(403).json({ success: false, error: 'Permission Denied: You are not authorized for this batch!' });
    }
  }

  try {
    const attSheet = await getSheet('attendance');
    await attSheet.loadHeaderRow();
    const useAdmHeader = attSheet.headerValues.includes('admission_no');
    const existingRows = await attSheet.getRows();

    const rowMap = new Map();
    existingRows.forEach(row => {
      const admNo = String(row.get('admission_no') || row.get('student_id') || '').trim();
      const rDate = String(row.get('date') || '').trim();
      const subId = String(row.get('subject_id') || '').trim();
      const bId = String(row.get('batch_id') || '').trim();
      if (admNo && rDate && subId) rowMap.set(`${admNo}_${rDate}_${subId}_${bId}`, row);
    });

    const alreadyMarked = records.some(r => {
      const admVal = String(r.admission_no || r.student_id || '').trim();
      const searchKey = `${admVal}_${String(date).trim()}_${String(subject_id).trim()}_${String(r.batch_id || '').trim()}`;
      return rowMap.has(searchKey);
    });

    if (alreadyMarked && sessionUser.can_update != 1) {
      return res.status(403).json({ 
        success: false, 
        error: 'Attendance for this session has already been recorded. You do not have update permission.' 
      });
    }

    const rowsToAdd = [];
    const rowsToUpdate = [];
    const cleanDate = String(date).trim();
    const cleanSubId = String(subject_id).trim();
    const timestamp = Date.now();

    records.forEach((r, index) => {
      const cleanStudentAdm = String(r.admission_no || r.student_id || '').trim();
      const cleanBatchId = String(r.batch_id || '').trim();
      const searchKey = `${cleanStudentAdm}_${cleanDate}_${cleanSubId}_${cleanBatchId}`;
      const matchedRow = rowMap.get(searchKey);

      if (matchedRow) {
        const currentStatus = String(matchedRow.get('status') || '').trim();
        const currentBatch = String(matchedRow.get('batch_id') || '').trim();

        if (currentStatus !== r.status || currentBatch !== cleanBatchId) {
          matchedRow.set('status', r.status);
          matchedRow.set('batch_id', cleanBatchId);
          matchedRow.set('user', loggedInUser);
          rowsToUpdate.push(matchedRow);
        }
      } else {
        const newRowObj = {
          id: `${timestamp}_${index}`,
          batch_id: cleanBatchId,
          subject_id: cleanSubId,
          date: cleanDate,
          user: loggedInUser,
          status: r.status
        };
        if (useAdmHeader) newRowObj.admission_no = cleanStudentAdm;
        else newRowObj.student_id = cleanStudentAdm;

        rowsToAdd.push(newRowObj);
      }
    });

    if (rowsToAdd.length > 0) await attSheet.addRows(rowsToAdd);
    if (rowsToUpdate.length > 0) {
      const chunkSize = 10;
      for (let i = 0; i < rowsToUpdate.length; i += chunkSize) {
        const chunk = rowsToUpdate.slice(i, i + chunkSize);
        await Promise.all(chunk.map(row => row.save()));
      }
    }

    return res.json({ 
      success: true, 
      message: `Attendance saved successfully! (New: ${rowsToAdd.length}, Updated: ${rowsToUpdate.length})` 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to save attendance: ' + err.message });
  }
});

// ================= 6. MONTHLY MATRIX (Controlled by admission_no) =================
app.get('/monthly-report', requireAuth, checkAttendanceView, async (req, res) => {
  try {
    const batchSheet = await getSheet('batches');
    const subjectSheet = await getSheet('subjects');

    const [bRows, sRows] = await Promise.all([batchSheet.getRows(), subjectSheet.getRows()]);

    const batches = bRows.map(r => ({ id: r.get('id'), name: r.get('name') })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const subjects = sRows.map(r => ({ id: r.get('id'), name: r.get('name'), batch_id: r.get('batch_id') })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.render('attveiw', { batches, subjects });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

app.get('/api/monthly-matrix', requireAuth, checkAttendanceView, async (req, res) => {
  const { batch_id, subject_id, month, year } = req.query;
  if (!batch_id || !month || !year) return res.status(400).json({ success: false, error: 'Missing filter parameters!' });

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
      .filter(r => (r.get('status') || '').trim().toLowerCase() === 'active' && (r.get('full_name') || '').trim() !== '')
      .map(r => {
        const admNo = String(r.get('admission_no') || '').trim();
        return {
          admission_no: admNo,
          roll_no: r.get('roll_no') || admNo,
          full_name: r.get('full_name'),
          batch_id: r.get('batch_id'),
          batch_name: batchMap[r.get('batch_id')] || 'N/A'
        };
      });

    if (batch_id !== 'all') {
      students = students.filter(s => {
        const studentBatches = String(s.batch_id || '').split(',').map(id => id.trim());
        return studentBatches.includes(String(batch_id).trim());
      });
    }

    students.sort((a, b) => {
      const admA = parseInt(String(a.roll_no || a.admission_no).replace(/\D/g, '')) || 0;
      const admB = parseInt(String(b.roll_no || b.admission_no).replace(/\D/g, '')) || 0;
      return admA - admB;
    });

    const attMap = {};
    const teachersSet = new Set();

    attRows.forEach(r => {
      const rDateStr = String(r.get('date') || '').trim();
      if (!rDateStr) return;

      const [rYear, rMonth, rDay] = rDateStr.split('-').map(Number);
      const matchMonth = rMonth === parseInt(month);
      const matchYear = rYear === parseInt(year);
      const matchBatch = batch_id === 'all' || String(r.get('batch_id')).trim() === String(batch_id).trim();
      const matchSub = !subject_id || subject_id === 'all' || String(r.get('subject_id')).trim() === String(subject_id).trim();

      if (matchMonth && matchYear && matchBatch && matchSub) {
        const studentAdm = String(r.get('admission_no') || r.get('student_id') || '').trim();
        const st = String(r.get('status') || '').trim().toLowerCase();
        const markedBy = String(r.get('user') || '').trim();

        if (markedBy) teachersSet.add(markedBy);
        if (!attMap[studentAdm]) attMap[studentAdm] = {};
        if (!attMap[studentAdm][rDay] || st === 'present') attMap[studentAdm][rDay] = st;
      }
    });

    res.json({ 
      success: true, 
      students, 
      attMap, 
      daysInMonth,
      markedTeachers: Array.from(teachersSet).join(', ') || '-'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/student-day-details', requireAuth, checkAttendanceView, async (req, res) => {
  const { admission_no, date } = req.query;
  if (!admission_no || !date) return res.status(400).json({ success: false, error: 'Admission Number and Date are required!' });

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

    const targetAdmNo = String(admission_no).trim();
    const studentRow = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (!studentRow) return res.status(404).json({ success: false, error: 'Student not found!' });

    const rawBatchIds = String(studentRow.get('batch_id') || '').split(',').map(id => id.trim()).filter(Boolean);
    const batchNames = rawBatchIds.map(id => batchMap[id]).filter(Boolean).join(', ');

    const student = {
      admission_no: targetAdmNo,
      full_name: studentRow.get('full_name'),
      batch_name: batchNames || 'N/A'
    };

    const sessions = attRows
      .filter(r => String(r.get('admission_no') || r.get('student_id')).trim() === targetAdmNo && String(r.get('date')).trim() === String(date).trim())
      .map(r => ({
        subject_name: subjectMap[r.get('subject_id')] || 'General',
        user: r.get('user') || '-',
        status: r.get('status'),
        created_at: r.get('date')
      }));

    res.json({ success: true, student, sessions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 7. STUDENT PORTAL (Controlled by admission_no) =================
app.get('/student-login', (req, res) => {
  if (req.session && req.session.student) return res.redirect('/my-attendance');
  res.render('student_login', { error: null });
});

app.post('/student-login', async (req, res) => {
  const { admission_no, password } = req.body;
  if (!admission_no || !password) {
    return res.render('student_login', { error: 'Admission Number and Password are required!' });
  }

  try {
    const studentSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');

    const [sRows, bRows] = await Promise.all([studentSheet.getRows(), batchSheet.getRows()]);

    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    const matchedStudent = sRows.find(r => {
      const status = (r.get('status') || '').trim().toLowerCase();
      const adm = String(r.get('admission_no') || '').trim().toLowerCase();
      return status === 'active' && adm === String(admission_no).trim().toLowerCase();
    });

    if (!matchedStudent) {
      return res.render('student_login', { error: 'Invalid Admission Number or account is not active!' });
    }

    const storedPass = matchedStudent.get('password') || matchedStudent.get('admission_no');
    const isValidPass = await verifyPassword(password, storedPass);

    if (!isValidPass) {
      return res.render('student_login', { error: 'Invalid Admission Number or Password!' });
    }

    const rawBatchIds = String(matchedStudent.get('batch_id') || '').split(',').map(id => id.trim()).filter(Boolean);
    const batchNames = rawBatchIds.map(id => batchMap[id]).filter(Boolean).join(', ');
    const admNo = String(matchedStudent.get('admission_no')).trim();

    req.session.student = {
      admission_no: admNo,
      full_name: matchedStudent.get('full_name'),
      batch_name: batchNames || 'N/A'
    };

    res.redirect('/my-attendance');
  } catch (err) {
    res.render('student_login', { error: 'Server Error: ' + err.message });
  }
});

app.get('/my-attendance', async (req, res) => {
  if (!req.session || !req.session.student) return res.redirect('/student-login');

  const student = req.session.student;
  const now = new Date();
  const selectedMonth = parseInt(req.query.month) || (now.getMonth() + 1);
  const selectedYear = parseInt(req.query.year) || now.getFullYear();

  try {
    const attSheet = await getSheet('attendance');
    const subjectSheet = await getSheet('subjects');

    const [attRows, subRows] = await Promise.all([attSheet.getRows(), subjectSheet.getRows()]);

    const subjectMap = {};
    subRows.forEach(r => { subjectMap[r.get('id')] = r.get('name'); });

    let presentCount = 0;
    let absentCount = 0;
    let leaveCount = 0;
    const records = [];

    attRows.forEach(r => {
      const admKey = String(r.get('admission_no') || r.get('student_id') || '').trim().toLowerCase();
      if (admKey !== student.admission_no.toLowerCase()) return;

      const rDateStr = String(r.get('date') || '').trim();
      if (!rDateStr) return;

      const [rYear, rMonth] = rDateStr.split('-').map(Number);
      if (rYear !== selectedYear || rMonth !== selectedMonth) return;

      const status = String(r.get('status') || '').trim().toLowerCase();
      if (status === 'present') presentCount++;
      else if (status === 'absent') absentCount++;
      else if (status === 'leave') leaveCount++;

      records.push({
        date: rDateStr,
        subject: subjectMap[r.get('subject_id')] || 'General',
        teacher: r.get('user') || '-',
        status: status
      });
    });

    records.sort((a, b) => b.date.localeCompare(a.date));
    const totalWorking = presentCount + absentCount;
    const percentage = totalWorking > 0 ? Math.round((presentCount / totalWorking) * 100) : 0;

    res.render('student_attendance', {
      student,
      records,
      stats: { present: presentCount, absent: absentCount, leave: leaveCount, percentage },
      selectedMonth,
      selectedYear
    });
  } catch (err) {
    res.status(500).send('Database Error: ' + err.message);
  }
});

app.get('/student-logout', (req, res) => {
  delete req.session.student;
  res.redirect('/student-login');
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));