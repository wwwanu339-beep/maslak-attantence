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

// 2. Multer File Upload Setup (Photo, Identity Doc & Print Branding)
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

// Print Header & Footer Upload Setup
const brandingUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `${file.fieldname}${ext}`);
    }
  })
}).fields([
  { name: 'print_header', maxCount: 1 },
  { name: 'print_footer', maxCount: 1 }
]);

function getBrandingUrls() {
  const files = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : [];
  const headerFile = files.find(f => f.startsWith('print_header.'));
  const footerFile = files.find(f => f.startsWith('print_footer.'));
  return {
    headerUrl: headerFile ? `/uploads/${headerFile}?v=${Date.now()}` : '',
    footerUrl: footerFile ? `/uploads/${footerFile}?v=${Date.now()}` : ''
  };
}

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

let serviceAccountAuth;
if (process.env.GOOGLE_CREDENTIALS_BASE64) {
  const creds = JSON.parse(
    Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf8')
  );
  serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
} else {
  serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: formatPrivateKey(process.env.GOOGLE_PRIVATE_KEY),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);

async function getSheet(sheetTitle) {
  await doc.loadInfo();
  return doc.sheetsByTitle[sheetTitle];
}

// Identify Protected Accounts: 'super_admin' (Developer) & 'admin' (Main Admin)
function isProtectedAdmin(row) {
  if (!row) return false;
  const role = String(row.get('role') || '').trim().toLowerCase();
  return role === 'super_admin' || role === 'admin';
}

// Generate next Admission Number based on the bottom-most row in 'admissions'
function generateNextAdmissionNo(admRows, stuRows = []) {
  for (let i = admRows.length - 1; i >= 0; i--) {
    const adm = String(admRows[i].get('admission_no') || '').trim();
    const num = parseInt(adm.replace(/\D/g, ''), 10);
    if (!isNaN(num)) {
      return `ADM${num + 1}`;
    }
  }
  for (let i = stuRows.length - 1; i >= 0; i--) {
    const adm = String(stuRows[i].get('admission_no') || '').trim();
    const num = parseInt(adm.replace(/\D/g, ''), 10);
    if (!isNaN(num)) {
      return `ADM${num + 1}`;
    }
  }
  return 'ADM1001';
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

function checkAdmission(req, res, next) {
  if (req.session.user && req.session.user.can_admission == 1) next();
  else res.status(403).send("Access Denied: You do not have permission to manage admissions.");
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
        name: matchedUser.get('name') || matchedUser.get('username'),
        username: matchedUser.get('username'),
        phone: matchedUser.get('phone') || '',
        can_attendance: parseInt(matchedUser.get('can_attendance') || 0),
        can_manage: parseInt(matchedUser.get('can_manage') || 0),
        can_attendanceveiw: parseInt(matchedUser.get('can_attendanceveiw') || 0),
        can_studet: parseInt(matchedUser.get('can_studet') || 0),
        can_admission: parseInt(matchedUser.get('can_admission') || 0),
        role: String(matchedUser.get('role') || 'sub_admin').trim(),
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

    const users = uRows
      .filter(r => !isProtectedAdmin(r))
      .map(r => ({
        id: r.get('id'),
        name: r.get('name') || '',
        phone: r.get('phone') || '',
        username: r.get('username'),
        role: r.get('role') || 'sub_admin'
      }))
      .reverse();

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
    name, phone, username, password, role, allowed_batch, allowed_subject,
    can_attendance, can_update, can_manage, can_attendanceveiw, can_studet, can_admission 
  } = req.body;

  if (!username || !password) return res.status(400).json({ success: false, error: 'Username and password are required!' });

  let finalRole = String(role || 'sub_admin').trim().toLowerCase();
  if (finalRole === 'super_admin' || finalRole === 'admin') {
    finalRole = 'sub_admin';
  }

  let finalBatch = 'all';
  let finalSubject = 'all';

  if (finalRole === 'batch_leader' && allowed_batch) finalBatch = String(allowed_batch).trim();
  else if (finalRole === 'subject_leader' && allowed_batch && allowed_subject) {
    finalBatch = String(allowed_batch).trim();
    finalSubject = String(allowed_subject).trim();
  }

  try {
    const sheet = await getSheet('users');
    const rows = await sheet.getRows();

    if (rows.some(r => String(r.get('username')).trim().toLowerCase() === username.trim().toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Username already exists!' });
    }

    const hashedPassword = await hashPassword(password);

    await sheet.addRow({
      id: Date.now().toString(),
      name: (name || username).trim(),
      phone: (phone || '').trim(),
      username: username.trim(),
      password: hashedPassword,
      role: finalRole,
      allowed_batch: finalBatch,
      allowed_subject: finalSubject,
      can_attendance: can_attendance ? '1' : '0',
      can_update: can_update ? '1' : '0',
      can_manage: can_manage ? '1' : '0',
      can_attendanceveiw: can_attendanceveiw ? '1' : '0',
      can_studet: can_studet ? '1' : '0',
      can_admission: can_admission ? '1' : '0'
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
    const targetId = String(req.params.id).trim();

    const row = rows.find(r => String(r.get('id')).trim() === targetId);
    if (!row) {
      return res.status(404).json({ success: false, error: 'User not found!' });
    }

    if (isProtectedAdmin(row)) {
      return res.status(403).json({ success: false, error: 'Protected Admin account cannot be deleted!' });
    }

    await row.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'Both current and new passwords are required!' });
  }

  try {
    const sheet = await getSheet('users');
    const rows = await sheet.getRows();
    const userRow = rows.find(r => String(r.get('username')).trim() === String(req.session.user.username).trim());

    if (!userRow) {
      return res.status(404).json({ success: false, error: 'User record not found!' });
    }

    const isMatch = await verifyPassword(currentPassword, userRow.get('password'));
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect!' });
    }

    userRow.set('password', await hashPassword(newPassword));
    await userRow.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/clear/:target', requireAuth, checkManage, async (req, res) => {
  const target = req.params.target;
  const { adminPassword } = req.body;
  const allowedTargets = ['attendance', 'students', 'subjects', 'batches', 'users'];

  if (!allowedTargets.includes(target)) {
    return res.status(400).json({ success: false, error: 'Invalid clear target!' });
  }

  if (!adminPassword) {
    return res.status(400).json({ success: false, error: 'Main Admin password is required!' });
  }

  try {
    const userSheet = await getSheet('users');
    const uRows = await userSheet.getRows();

    const protectedAdmins = uRows.filter(r => isProtectedAdmin(r));
    if (protectedAdmins.length === 0) {
      return res.status(404).json({ success: false, error: 'Main Admin account not found!' });
    }

    let isPasswordValid = false;
    for (const adm of protectedAdmins) {
      if (await verifyPassword(adminPassword, adm.get('password'))) {
        isPasswordValid = true;
        break;
      }
    }

    if (!isPasswordValid) {
      return res.status(401).json({ success: false, error: 'Incorrect Main Admin password!' });
    }

    const sheet = await getSheet(target);
    if (!sheet) return res.status(404).json({ success: false, error: `Sheet "${target}" not found!` });

    const rows = await sheet.getRows();

    for (let i = rows.length - 1; i >= 0; i--) {
      if (target === 'users') {
        if (isProtectedAdmin(rows[i])) {
          continue;
        }
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

// ================= 3. ADMISSIONS =================
app.post('/api/admission-branding', requireAuth, checkAdmission, brandingUpload, (req, res) => {
  try {
    if (req.files?.print_header?.[0]) {
      fs.readdirSync(uploadDir)
        .filter(f => f.startsWith('print_header.') && f !== req.files.print_header[0].filename)
        .forEach(f => fs.unlinkSync(path.join(uploadDir, f)));
    }
    if (req.files?.print_footer?.[0]) {
      fs.readdirSync(uploadDir)
        .filter(f => f.startsWith('print_footer.') && f !== req.files.print_footer[0].filename)
        .forEach(f => fs.unlinkSync(path.join(uploadDir, f)));
    }
    res.json({ success: true, ...getBrandingUrls() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/admissions', requireAuth, checkAdmission, async (req, res) => {
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
        const batchNamesList = rawBatchIds.map(id => batchMap[id]).filter(Boolean);

        return {
          admission_no: String(r.get('admission_no') || '').trim(),
          roll_no: r.get('roll_no') || '',
          full_name: r.get('full_name'),
          dob: r.get('dob') || '',
          father_name: r.get('father_name') || '',
          phone: r.get('phone') || '',
          guardian_phone: r.get('guardian_phone') || '',
          aadhaar_no: r.get('aadhaar_no') || '',
          aadhaar_file: r.get('aadhaar_file') || '',
          photo_file: r.get('photo_file') || '',
          address: r.get('address') || '',
          place: r.get('place') || '',
          pin: r.get('pin') || '',
          district: r.get('district') || '',
          state: r.get('state') || '',
          is_muthallim: r.get('is_muthallim') || 'no',
          prev_institution: r.get('prev_institution') || '',
          prev_place: r.get('prev_place') || '',
          school_class: r.get('school_class') || '',
          madrasa_class: r.get('madrasa_class') || '',
          batch_id: r.get('batch_id') || '',
          batch_name: batchNamesList.join(', ') || 'No Batch',
          status: (r.get('status') || 'pending').trim().toLowerCase()
        };
      })
      .reverse();

    const branding = getBrandingUrls();
    res.render('admission', { batches, allStudents, nextAdmissionNo, branding });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

// Create Admission / Draft
app.post('/api/admissions', requireAuth, checkAdmission, admUploads, async (req, res) => {
  try {
    const {
      full_name, dob, roll_no, father_name, phone, guardian_phone, aadhaar_no,
      address, place, pin, district, state, is_muthallim, prev_institution, prev_place,
      school_class, madrasa_class, batch_id, password, status
    } = req.body;

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
      place: place ? place.trim() : '',
      pin: pin ? String(pin).trim() : '',
      district: district ? district.trim() : '',
      state: state ? state.trim() : '',
      is_muthallim: is_muthallim === 'yes' ? 'yes' : 'no',
      prev_institution: (is_muthallim === 'yes' && prev_institution) ? prev_institution.trim() : '',
      prev_place: (is_muthallim === 'yes' && prev_place) ? prev_place.trim() : '',
      school_class: school_class ? String(school_class).trim() : '',
      madrasa_class: madrasa_class ? String(madrasa_class).trim() : '',
      aadhaar_no: aadhaar_no ? String(aadhaar_no).trim() : '',
      aadhaar_file: aadhaarPath,
      photo_file: photoPath,
      phone: phone ? String(phone).trim() : '',
      guardian_phone: guardian_phone ? String(guardian_phone).trim() : '',
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

// Edit Admission by admission_no (with Cascade Roll Reorder)
app.put('/api/admissions/:admNo', requireAuth, checkAdmission, admUploads, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const {
      full_name, dob, roll_no, father_name, phone, guardian_phone, aadhaar_no,
      address, place, pin, district, state, is_muthallim, prev_institution, prev_place,
      school_class, madrasa_class, batch_id, password, status
    } = req.body;

    const admSheet = await getSheet('admissions');
    const stuSheet = await getSheet('students');
    const [aRows, sRows] = await Promise.all([admSheet.getRows(), stuSheet.getRows()]);

    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (!admRow) return res.status(404).json({ success: false, error: 'Admission record not found!' });

    const photoPath = req.files?.photo?.[0] ? `/uploads/${req.files.photo[0].filename}` : admRow.get('photo_file');
    const aadhaarPath = req.files?.aadhaar_doc?.[0] ? `/uploads/${req.files.aadhaar_doc[0].filename}` : admRow.get('aadhaar_file');
    const cleanRoll = roll_no ? String(roll_no).trim() : '';

    admRow.set('full_name', full_name.trim());
    admRow.set('dob', String(dob).trim());
    admRow.set('roll_no', cleanRoll);
    admRow.set('father_name', father_name ? father_name.trim() : '');
    admRow.set('phone', phone ? String(phone).trim() : '');
    admRow.set('guardian_phone', guardian_phone ? String(guardian_phone).trim() : '');
    admRow.set('aadhaar_no', aadhaar_no ? String(aadhaar_no).trim() : '');
    admRow.set('address', address ? address.trim() : '');
    admRow.set('place', place ? place.trim() : '');
    admRow.set('pin', pin ? String(pin).trim() : '');
    admRow.set('district', district ? district.trim() : '');
    admRow.set('state', state ? state.trim() : '');
    admRow.set('is_muthallim', is_muthallim === 'yes' ? 'yes' : 'no');
    admRow.set('prev_institution', (is_muthallim === 'yes' && prev_institution) ? prev_institution.trim() : '');
    admRow.set('prev_place', (is_muthallim === 'yes' && prev_place) ? prev_place.trim() : '');
    admRow.set('school_class', school_class ? String(school_class).trim() : '');
    admRow.set('madrasa_class', madrasa_class ? String(madrasa_class).trim() : '');
    if (batch_id !== undefined) admRow.set('batch_id', String(batch_id).trim());
    if (password && password.trim() !== '') {
      admRow.set('password', await hashPassword(password));
    }
    if (status) admRow.set('status', status);
    admRow.set('photo_file', photoPath || '');
    admRow.set('aadhaar_file', aadhaarPath || '');
    await admRow.save();

    if (admRow.get('status') === 'active') {
      const stuRow = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
      if (stuRow) {
        stuRow.set('full_name', admRow.get('full_name'));
        stuRow.set('dob', admRow.get('dob'));
        stuRow.set('roll_no', cleanRoll);
        stuRow.set('phone', admRow.get('phone'));
        stuRow.set('batch_id', admRow.get('batch_id'));
        stuRow.set('password', admRow.get('password'));
        await stuRow.save();
      }
    }

    if (cleanRoll) {
      await syncAndReorderRolls(targetAdmNo, cleanRoll, stuSheet, admSheet, sRows, aRows);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cascade Shift & Gap-Free Sequential Reorder across 'students' and 'admissions'
async function syncAndReorderRolls(targetAdmNo, desiredRollStr, stuSheet, admSheet, sRows, aRows) {
  const newRoll = parseInt(desiredRollStr, 10);
  if (isNaN(newRoll) || newRoll < 1) return;

  const items = [];
  const processedAdms = new Set();

  [...sRows, ...aRows].forEach(r => {
    const adm = String(r.get('admission_no') || '').trim();
    if (!adm || adm === targetAdmNo || processedAdms.has(adm)) return;
    processedAdms.add(adm);

    const rNum = parseInt(String(r.get('roll_no') || '').trim(), 10);
    if (!isNaN(rNum) && rNum > 0) {
      items.push({ adm, roll: rNum });
    }
  });

  items.sort((a, b) => a.roll - b.roll);

  const targetIndex = Math.min(Math.max(0, newRoll - 1), items.length);
  items.splice(targetIndex, 0, { adm: targetAdmNo, roll: newRoll });

  const finalRollMap = new Map();
  items.forEach((item, idx) => {
    finalRollMap.set(item.adm, String(idx + 1));
  });

  async function batchUpdateRollColumn(sheet) {
    if (!sheet) return;
    await sheet.loadHeaderRow();
    const admColIdx = sheet.headerValues.indexOf('admission_no');
    const rollColIdx = sheet.headerValues.indexOf('roll_no');
    if (admColIdx === -1 || rollColIdx === -1 || sheet.rowCount < 2) return;

    await sheet.loadCells({
      startRowIndex: 1,
      endRowIndex: sheet.rowCount,
      startColumnIndex: Math.min(admColIdx, rollColIdx),
      endColumnIndex: Math.max(admColIdx, rollColIdx) + 1
    });

    let hasChanges = false;
    for (let r = 1; r < sheet.rowCount; r++) {
      const admCell = sheet.getCell(r, admColIdx);
      const admVal = String(admCell.value || '').trim();
      if (admVal && finalRollMap.has(admVal)) {
        const newRollVal = finalRollMap.get(admVal);
        const rollCell = sheet.getCell(r, rollColIdx);
        if (String(rollCell.value || '').trim() !== newRollVal) {
          rollCell.value = newRollVal;
          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      await sheet.saveUpdatedCells();
    }
  }

  await Promise.all([
    batchUpdateRollColumn(stuSheet),
    batchUpdateRollColumn(admSheet)
  ]);
}

// Make Active / Not Active by admission_no
app.put('/api/admissions/:admNo/status', requireAuth, checkAdmission, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const { status } = req.body;

    const admSheet = await getSheet('admissions');
    const stuSheet = await getSheet('students');
    const [aRows, sRows] = await Promise.all([admSheet.getRows(), stuSheet.getRows()]);

    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (!admRow) return res.status(404).json({ success: false, error: 'Admission record not found!' });

    if (status === 'active') {
      const existingStu = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
      const effectiveBatchId = admRow.get('batch_id') || (existingStu ? existingStu.get('batch_id') : '');

      if (!effectiveBatchId) {
        return res.status(400).json({ success: false, error: 'Please assign at least one batch via Edit before activating!' });
      }

      if (!admRow.get('batch_id')) admRow.set('batch_id', effectiveBatchId);
      admRow.set('status', 'active');
      await admRow.save();

      const defaultPass = admRow.get('password') || await hashPassword(targetAdmNo);

      if (existingStu) {
        existingStu.set('status', 'active');
        existingStu.set('full_name', admRow.get('full_name'));
        existingStu.set('roll_no', admRow.get('roll_no') || existingStu.get('roll_no') || '');
        existingStu.set('dob', admRow.get('dob') || '');
        existingStu.set('phone', admRow.get('phone') || '');
        existingStu.set('batch_id', effectiveBatchId);
        existingStu.set('password', defaultPass);
        await existingStu.save();
      } else {
        await stuSheet.addRow({
          admission_no: targetAdmNo,
          roll_no: admRow.get('roll_no') || '',
          full_name: admRow.get('full_name'),
          dob: admRow.get('dob') || '',
          phone: admRow.get('phone') || '',
          batch_id: effectiveBatchId,
          password: defaultPass,
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
app.delete('/api/admissions/:admNo', requireAuth, checkAdmission, async (req, res) => {
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

// ================= 4. ACTIVE STUDENTS LIST =================
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
        const batchNamesList = rawBatchIds.map(id => batchMap[id]).filter(Boolean);
        const mainBatchName = batchNamesList[0] || 'N/A';
        const admNo = String(r.get('admission_no') || '').trim();

        return {
          admission_no: admNo,
          roll_no: r.get('roll_no') || '',
          full_name: r.get('full_name'),
          dob: r.get('dob') || r.get('age') || '',
          phone: r.get('phone') || '',
          batch_id: r.get('batch_id') || '',
          main_batch_name: mainBatchName,
          batch_name: batchNamesList.join(', ') || 'N/A',
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

app.post('/api/students/bulk-assign-batch', requireAuth, checkStudent, async (req, res) => {
  try {
    const { batch_id, from_roll, to_roll } = req.body;
    const targetBatch = String(batch_id || '').trim();
    const startRoll = parseInt(from_roll);
    const endRoll = parseInt(to_roll);

    if (!targetBatch || isNaN(startRoll) || isNaN(endRoll) || startRoll > endRoll) {
      return res.status(400).json({ success: false, error: 'Please select a valid batch and roll number range!' });
    }

    const stuSheet = await getSheet('students');
    const admSheet = await getSheet('admissions');

    async function updateBatchInSheet(sheet, onlyActive = false) {
      if (!sheet) return 0;
      await sheet.loadHeaderRow();
      const rollIdx = sheet.headerValues.indexOf('roll_no');
      const batchIdx = sheet.headerValues.indexOf('batch_id');
      const statusIdx = sheet.headerValues.indexOf('status');
      if (rollIdx === -1 || batchIdx === -1 || sheet.rowCount < 2) return 0;

      const cols = [rollIdx, batchIdx];
      if (statusIdx !== -1) cols.push(statusIdx);

      await sheet.loadCells({
        startRowIndex: 1,
        endRowIndex: sheet.rowCount,
        startColumnIndex: Math.min(...cols),
        endColumnIndex: Math.max(...cols) + 1
      });

      let updatedCount = 0;
      for (let r = 1; r < sheet.rowCount; r++) {
        if (onlyActive && statusIdx !== -1) {
          const st = String(sheet.getCell(r, statusIdx).value || '').trim().toLowerCase();
          if (st !== 'active') continue;
        }

        const rollVal = parseInt(String(sheet.getCell(r, rollIdx).value || '').trim());
        if (!isNaN(rollVal) && rollVal >= startRoll && rollVal <= endRoll) {
          const batchCell = sheet.getCell(r, batchIdx);
          const existingBatches = String(batchCell.value || '')
            .split(',')
            .map(b => b.trim())
            .filter(Boolean);

          if (!existingBatches.includes(targetBatch)) {
            existingBatches.push(targetBatch);
            batchCell.value = existingBatches.join(',');
            updatedCount++;
          }
        }
      }

      if (updatedCount > 0) {
        await sheet.saveUpdatedCells();
      }
      return updatedCount;
    }

    const [stuUpdated] = await Promise.all([
      updateBatchInSheet(stuSheet, true),
      updateBatchInSheet(admSheet, false)
    ]);

    res.json({
      success: true,
      message: `Batch assigned successfully to ${stuUpdated} student(s) (Roll ${startRoll} to ${endRoll})!`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

app.put('/api/students/:admNo', requireAuth, checkStudent, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const { full_name, dob, phone, batch_id, roll_no, password } = req.body;

    const stuSheet = await getSheet('students');
    const admSheet = await getSheet('admissions');
    const [sRows, aRows] = await Promise.all([stuSheet.getRows(), admSheet.getRows()]);

    const hashedPassword = (password && password.trim() !== '') ? await hashPassword(password) : null;
    const cleanRoll = roll_no ? String(roll_no).trim() : '';

    const row = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (row) {
      row.set('full_name', full_name ? full_name.trim() : '');
      row.set('roll_no', cleanRoll);
      if (dob !== undefined) row.set('dob', String(dob).trim());
      row.set('phone', phone ? String(phone).trim() : '');
      row.set('batch_id', batch_id ? String(batch_id) : '');
      if (hashedPassword) row.set('password', hashedPassword);
      await row.save();
    }

    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (admRow) {
      admRow.set('full_name', full_name ? full_name.trim() : '');
      admRow.set('roll_no', cleanRoll);
      if (dob !== undefined) admRow.set('dob', String(dob).trim());
      admRow.set('phone', phone ? String(phone).trim() : '');
      admRow.set('batch_id', batch_id ? String(batch_id) : '');
      if (hashedPassword) admRow.set('password', hashedPassword);
      await admRow.save();
    }

    if (cleanRoll) {
      await syncAndReorderRolls(targetAdmNo, cleanRoll, stuSheet, admSheet, sRows, aRows);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

// ================= 5. ATTENDANCE =================
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

// ================= 6. MONTHLY MATRIX =================
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

// ================= 7. STUDENT PORTAL =================
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

// ID Card Dedicated Page
app.get('/id-cards', requireAuth, checkAdmission, async (req, res) => {
  try {
    const admSheet = await getSheet('admissions');
    const batchSheet = await getSheet('batches');

    const [aRows, bRows] = await Promise.all([admSheet.getRows(), batchSheet.getRows()]);

    const batchMap = {};
    const batches = bRows.map(r => {
      batchMap[r.get('id')] = r.get('name');
      return { id: r.get('id'), name: r.get('name') };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const allStudents = aRows
      .filter(r => (r.get('full_name') || '').trim() !== '')
      .map(r => {
        const rawBatchIds = String(r.get('batch_id') || '').split(',').map(id => id.trim()).filter(Boolean);
        const batchNamesList = rawBatchIds.map(id => batchMap[id]).filter(Boolean);
        return {
          admission_no: String(r.get('admission_no') || '').trim(),
          roll_no: r.get('roll_no') || '',
          full_name: r.get('full_name'),
          dob: r.get('dob') || '',
          father_name: r.get('father_name') || '',
          phone: r.get('phone') || '',
          guardian_phone: r.get('guardian_phone') || '',
          photo_file: r.get('photo_file') || '',
          address: r.get('address') || '',
          place: r.get('place') || '',
          batch_id: r.get('batch_id') || '',
          main_batch_name: batchNamesList[0] || 'No Batch',
          status: (r.get('status') || 'pending').trim().toLowerCase()
        };
      })
      .reverse();

    const files = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : [];
    const idHeaderFile = files.find(f => f.startsWith('id_card_header.'));
    const idFooterFile = files.find(f => f.startsWith('id_card_footer.'));
    const idBranding = {
      headerUrl: idHeaderFile ? `/uploads/${idHeaderFile}?v=${Date.now()}` : '',
      footerUrl: idFooterFile ? `/uploads/${idFooterFile}?v=${Date.now()}` : ''
    };

    res.render('id_cards', { batches, allStudents, idBranding });
  } catch (err) {
    res.status(500).send('Database Error: ' + err.message);
  }
});

// Upload Dedicated ID Card Header & Footer
const idBrandingUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `${file.fieldname}${ext}`);
    }
  })
}).fields([
  { name: 'id_card_header', maxCount: 1 },
  { name: 'id_card_footer', maxCount: 1 }
]);

app.post('/api/id-card-branding', requireAuth, checkAdmission, idBrandingUpload, (req, res) => {
  try {
    if (req.files?.id_card_header?.[0]) {
      fs.readdirSync(uploadDir)
        .filter(f => f.startsWith('id_card_header.') && f !== req.files.id_card_header[0].filename)
        .forEach(f => fs.unlinkSync(path.join(uploadDir, f)));
    }
    if (req.files?.id_card_footer?.[0]) {
      fs.readdirSync(uploadDir)
        .filter(f => f.startsWith('id_card_footer.') && f !== req.files.id_card_footer[0].filename)
        .forEach(f => fs.unlinkSync(path.join(uploadDir, f)));
    }
    const files = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : [];
    const hFile = files.find(f => f.startsWith('id_card_header.'));
    const fFile = files.find(f => f.startsWith('id_card_footer.'));
    res.json({
      success: true,
      headerUrl: hFile ? `/uploads/${hFile}?v=${Date.now()}` : '',
      footerUrl: fFile ? `/uploads/${fFile}?v=${Date.now()}` : ''
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));