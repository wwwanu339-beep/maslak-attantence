const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { getSheet } = require('../config/sheets');
const { getBrandingUrls } = require('../config/upload');
const { requireAuth, checkAdmission } = require('../middleware/auth');

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads')),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});
const studentPhotoUpload = multer({ storage: photoStorage });

const DEFAULT_PORTAL_CFG = {
  globalShowForm: true,
  globalShowIdCard: true,
  globalAllowEdit: false,
  globalAllowPasswordChange: false,
  allowedFields: ['phone', 'guardian_phone', 'address', 'place', 'pin', 'district', 'state'],
  studentOverrides: {}
};

async function getPortalConfig() {
  try {
    const sheet = await getSheet('portal_config');
    if (!sheet) return { ...DEFAULT_PORTAL_CFG };
    const rows = await sheet.getRows();
    if (rows.length > 0 && rows[0].get('config_json')) {
      const parsed = JSON.parse(rows[0].get('config_json'));
      return { ...DEFAULT_PORTAL_CFG, ...parsed };
    }
  } catch (e) {}
  return { ...DEFAULT_PORTAL_CFG };
}

function getEffectiveStudentPerms(cfg, admNo) {
  const ov = (cfg.studentOverrides && cfg.studentOverrides[admNo]) || {};
  return {
    showForm: ov.showForm !== undefined ? ov.showForm : cfg.globalShowForm,
    showIdCard: ov.showIdCard !== undefined ? ov.showIdCard : cfg.globalShowIdCard,
    allowEdit: ov.allowEdit !== undefined ? ov.allowEdit : cfg.globalAllowEdit,
    allowPasswordChange: ov.allowPasswordChange !== undefined ? ov.allowPasswordChange : Boolean(cfg.globalAllowPasswordChange),
    allowedFields: cfg.allowedFields || []
  };
}

// ==========================================
// 1. STUDENT LOGIN ROUTES (/student-login)
// ==========================================
router.get('/student-login', (req, res) => {
  if (req.session && req.session.student) return res.redirect('/my-attendance');
  res.render('student_login', { error: null });
});

router.post('/student-login', async (req, res) => {
  const admNo = String(req.body.admission_no || '').trim();
  const password = String(req.body.password || '').trim();

  if (!admNo || !password) {
    return res.render('student_login', { error: 'Please enter Admission No and Password.' });
  }

  try {
    const admSheet = await getSheet('admissions');
    const rows = await admSheet.getRows();
    const stuRow = rows.find(r => String(r.get('admission_no') || '').trim().toLowerCase() === admNo.toLowerCase());

    if (!stuRow) {
      return res.render('student_login', { error: 'Invalid Admission Number!' });
    }

    const actualAdmNo = String(stuRow.get('admission_no') || '').trim();
    const colPass = String(stuRow.get('password') || '').trim();
    const colHash = String(stuRow.get('password_hash') || '').trim();
    const savedSecret = colHash || colPass;

    let isMatch = false;
    if (savedSecret.startsWith('$2a$') || savedSecret.startsWith('$2b$') || savedSecret.startsWith('$2y$')) {
      isMatch = await bcrypt.compare(password, savedSecret);
    } else if (savedSecret !== '') {
      isMatch = (password === savedSecret);
    } else {
      isMatch = (password.toLowerCase() === actualAdmNo.toLowerCase());
    }

    if (!isMatch) {
      return res.render('student_login', { error: 'Incorrect Password! (If not set, try your Admission Number)' });
    }

    req.session.student = {
      admission_no: actualAdmNo,
      full_name: stuRow.get('full_name') || '',
      batch_id: stuRow.get('batch_id') || ''
    };

    res.redirect('/my-attendance');
  } catch (err) {
    res.render('student_login', { error: 'Login Error: ' + err.message });
  }
});

// ==========================================
// 2. STUDENT ATTENDANCE & PORTAL (/my-attendance)
// ==========================================
router.get('/my-attendance', async (req, res) => {
  if (!req.session || !req.session.student) return res.redirect('/student-login');
  const targetAdmNo = String(req.session.student.admission_no || '').trim();

  const now = new Date();
  const selectedDate = String(req.query.date || '').trim();
  let selectedMonth = parseInt(req.query.month, 10) || (now.getMonth() + 1);
  let selectedYear = parseInt(req.query.year, 10) || now.getFullYear();

  if (selectedDate && selectedDate.includes('-')) {
    const [dY, dM] = selectedDate.split('-');
    if (dY && dM) {
      selectedYear = parseInt(dY, 10);
      selectedMonth = parseInt(dM, 10);
    }
  }

  try {
    const [admSheet, attSheet, batchSheet, subSheet, userSheet, portalCfg] = await Promise.all([
      getSheet('admissions'),
      getSheet('attendance'),
      getSheet('batches'),
      getSheet('subjects'),
      getSheet('users'),
      getPortalConfig()
    ]);

    const [aRows, attRows, bRows, sRows, uRows] = await Promise.all([
      admSheet.getRows(),
      attSheet ? attSheet.getRows() : [],
      batchSheet ? batchSheet.getRows() : [],
      subSheet ? subSheet.getRows() : [],
      userSheet ? userSheet.getRows() : []
    ]);

    const batchMap = {};
    bRows.forEach(r => {
      const id = String(r.get('id') || r.get('batch_id') || '').trim();
      const name = String(r.get('name') || r.get('batch_name') || '').trim();
      if (id) batchMap[id] = name;
    });

    const subjectMap = {};
    sRows.forEach(r => {
      const id = String(r.get('id') || r.get('subject_id') || '').trim();
      const subName = String(r.get('name') || r.get('subject_name') || r.get('subject') || r.get('title') || '').trim();
      if (id && subName) subjectMap[id] = subName;
    });

    const teacherMap = {};
    uRows.forEach(r => {
      const uname = String(r.get('username') || r.get('user') || '').trim().toLowerCase();
      const actualName = String(r.get('name') || r.get('full_name') || r.get('teacher_name') || '').trim();
      if (uname && actualName) teacherMap[uname] = actualName;

      const uid = String(r.get('id') || r.get('user_id') || '').trim().toLowerCase();
      if (uid && actualName) teacherMap[uid] = actualName;
    });

    const admRow = aRows.find(r => String(r.get('admission_no') || '').trim().toLowerCase() === targetAdmNo.toLowerCase());
    if (!admRow) {
      delete req.session.student;
      return res.redirect('/student-login');
    }

    const rawB = String(admRow.get('batch_id') || '').split(',').map(x => x.trim()).filter(Boolean);
    const batchNames = rawB.map(id => batchMap[id]).filter(Boolean);

    const student = {
      admission_no: admRow.get('admission_no') || '',
      roll_no: admRow.get('roll_no') || '',
      full_name: admRow.get('full_name') || '',
      father_name: admRow.get('father_name') || '',
      dob: admRow.get('dob') || '',
      phone: admRow.get('phone') || '',
      place: admRow.get('place') || '-',
      photo_url: admRow.get('photo_file') || '',
      photo_file: admRow.get('photo_file') || '',
      main_batch_name: batchNames[0] || 'No Batch',
      batch_name: batchNames.join(', ') || 'No Batch',
      status: admRow.get('status') || ''
    };

    const records = attRows
      .filter(r => {
        const savedAdm = String(r.get('student_id') || '').trim().toLowerCase();
        if (savedAdm !== targetAdmNo.toLowerCase()) return false;

        const dStr = String(r.get('date') || '').trim();
        if (!dStr) return false;

        const parts = dStr.split(/[-/\s]/);
        if (parts.length < 3) return false;

        let d = 0, m = 0, y = 0;
        if (parts[0].length === 4) {
          y = parseInt(parts[0], 10);
          m = parseInt(parts[1], 10);
          d = parseInt(parts[2], 10);
        } else {
          d = parseInt(parts[0], 10);
          m = parseInt(parts[1], 10);
          y = parseInt(parts[2], 10);
        }

        if (selectedDate) {
          const normRowDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          return normRowDate === selectedDate;
        }

        return m === selectedMonth && y === selectedYear;
      })
      .map(r => {
        const rawSt = String(r.get('status') || '').trim().toLowerCase();
        let normStatus = rawSt;
        if (rawSt === 'p' || rawSt === 'present') normStatus = 'present';
        else if (rawSt === 'a' || rawSt === 'absent') normStatus = 'absent';
        else if (rawSt === 'l' || rawSt === 'lv' || rawSt === 'leave' || rawSt === 'late') normStatus = 'leave';

        const subId = String(r.get('subject_id') || '').trim();
        const resolvedSubject = subjectMap[subId] || '-';

        const savedUsername = String(r.get('user') || '').trim().toLowerCase();
        const resolvedTeacher = teacherMap[savedUsername] || '-';

        return {
          date: r.get('date') || '',
          subject: resolvedSubject,
          teacher: resolvedTeacher,
          status: normStatus
        };
      })
      .reverse();

    const stats = { present: 0, absent: 0, leave: 0, total: records.length, percentage: 0 };
    records.forEach(rec => {
      if (rec.status === 'present') stats.present++;
      else if (rec.status === 'absent') stats.absent++;
      else if (rec.status === 'leave') stats.leave++;
    });
    if (stats.total > 0) {
      stats.percentage = Math.round((stats.present / stats.total) * 100);
    }

    const perms = getEffectiveStudentPerms(portalCfg, targetAdmNo);
    res.render('student_attendance', { student, records, stats, perms, selectedMonth, selectedYear, selectedDate });
  } catch (err) {
    res.status(500).send('Portal Error: ' + err.message);
  }
});

// ==========================================
// 3. ADMIN STUDENT PORTAL CONTROL API
// ==========================================
router.get('/student-portal-control', requireAuth, (req, res) => {
  res.redirect('/add');
});

router.post('/api/student-portal-control', requireAuth, async (req, res) => {
  try {
    const sheet = await getSheet('portal_config');
    if (!sheet) {
      return res.status(400).json({ success: false, error: 'Google Sheet-ൽ "portal_config" എന്ന ടാബ് ഉണ്ടാക്കി A1-ൽ "config_json" എന്ന് ഹെഡർ നൽകുക.' });
    }

    const rows = await sheet.getRows();
    const jsonStr = JSON.stringify(req.body);
    if (rows.length > 0) {
      rows[0].set('config_json', jsonStr);
      await rows[0].save();
    } else {
      await sheet.addRow({ config_json: jsonStr });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 4. STUDENT ADMISSION FORM & SELF-UPDATE
// ==========================================
router.get('/my-admission-form', async (req, res) => {
  if (!req.session || !req.session.student) return res.redirect('/student-login');
  const targetAdmNo = String(req.session.student.admission_no || '').trim();

  try {
    const [admSheet, batchSheet, portalCfg] = await Promise.all([
      getSheet('admissions'),
      getSheet('batches'),
      getPortalConfig()
    ]);

    const perms = getEffectiveStudentPerms(portalCfg, targetAdmNo);
    if (!perms.showForm) {
      return res.status(403).send('<h3 style="font-family:sans-serif;text-align:center;margin-top:40px;">Admission Form view is currently disabled by Administrator.</h3>');
    }

    const [aRows, bRows] = await Promise.all([admSheet.getRows(), batchSheet.getRows()]);
    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    const admRow = aRows.find(r => String(r.get('admission_no') || '').trim().toLowerCase() === targetAdmNo.toLowerCase());
    if (!admRow) return res.status(404).send('Admission record not found!');

    const rawBatchIds = String(admRow.get('batch_id') || '').split(',').map(id => id.trim()).filter(Boolean);
    const batchNames = rawBatchIds.map(id => batchMap[id]).filter(Boolean).join(', ') || 'N/A';

    const student = {
      admission_no: admRow.get('admission_no') || '',
      roll_no: admRow.get('roll_no') || '',
      full_name: admRow.get('full_name') || '',
      dob: admRow.get('dob') || '',
      father_name: admRow.get('father_name') || '',
      phone: admRow.get('phone') || '',
      guardian_phone: admRow.get('guardian_phone') || '',
      aadhaar_no: admRow.get('aadhaar_no') || '',
      photo_file: admRow.get('photo_file') || '',
      address: admRow.get('address') || '',
      place: admRow.get('place') || '',
      pin: admRow.get('pin') || '',
      district: admRow.get('district') || '',
      state: admRow.get('state') || '',
      is_muthallim: admRow.get('is_muthallim') || 'no',
      prev_institution: admRow.get('prev_institution') || '',
      prev_place: admRow.get('prev_place') || '',
      school_class: admRow.get('school_class') || '',
      madrasa_class: admRow.get('madrasa_class') || '',
      batch_name: batchNames,
      created_at: admRow.get('created_at') || ''
    };

    let formTpl = {};
    try {
      const cfgSheet = await getSheet('form_config');
      if (cfgSheet) {
        const cfgRows = await cfgSheet.getRows();
        if (cfgRows.length > 0 && cfgRows[0].get('config_json')) {
          formTpl = JSON.parse(cfgRows[0].get('config_json'));
        }
      }
    } catch (e) {}

    const branding = getBrandingUrls();
    res.render('student_application_print', { student, branding, formTpl, perms });
  } catch (err) {
    res.status(500).send('Database Error: ' + err.message);
  }
});

router.post('/api/my-admission-update', studentPhotoUpload.single('photo'), async (req, res) => {
  if (!req.session || !req.session.student) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const targetAdmNo = String(req.session.student.admission_no || '').trim();

  try {
    const portalCfg = await getPortalConfig();
    const perms = getEffectiveStudentPerms(portalCfg, targetAdmNo);

    if (!perms.allowEdit) {
      return res.status(403).json({ success: false, error: 'Editing is disabled by teacher.' });
    }

    const admSheet = await getSheet('admissions');
    const rows = await admSheet.getRows();
    const row = rows.find(r => String(r.get('admission_no') || '').trim().toLowerCase() === targetAdmNo.toLowerCase());
    if (!row) return res.status(404).json({ success: false, error: 'Student not found' });

    const editableKeys = [
      'full_name', 'dob', 'father_name', 'phone', 'guardian_phone',
      'aadhaar_no', 'address', 'place', 'pin', 'district', 'state',
      'school_class', 'madrasa_class', 'is_muthallim', 'prev_institution', 'prev_place'
    ];

    editableKeys.forEach(key => {
      if (perms.allowedFields.includes(key) && req.body[key] !== undefined) {
        row.set(key, String(req.body[key]).trim());
      }
    });

    if (perms.allowedFields.includes('photo_file') && req.file) {
      row.set('photo_file', `/uploads/${req.file.filename}`);
    }

    await row.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 5. STUDENT ID CARD & LOGOUT
// ==========================================
router.get('/my-id-card', async (req, res) => {
  if (!req.session || !req.session.student) return res.redirect('/student-login');
  const targetAdmNo = String(req.session.student.admission_no || '').trim();

  try {
    const [admSheet, batchSheet, portalCfg] = await Promise.all([
      getSheet('admissions'),
      getSheet('batches'),
      getPortalConfig()
    ]);

    const perms = getEffectiveStudentPerms(portalCfg, targetAdmNo);
    if (!perms.showIdCard) {
      return res.status(403).send('<h3 style="font-family:sans-serif;text-align:center;margin-top:40px;">ID Card view is currently disabled by Administrator.</h3>');
    }

    const [aRows, bRows] = await Promise.all([admSheet.getRows(), batchSheet.getRows()]);
    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    const admRow = aRows.find(r => String(r.get('admission_no') || '').trim().toLowerCase() === targetAdmNo.toLowerCase());
    if (!admRow) return res.status(404).send('Student record not found!');

    const rawB = String(admRow.get('batch_id') || '').split(',').map(x => x.trim()).filter(Boolean);
    const batchNames = rawB.map(id => batchMap[id]).filter(Boolean);

    const student = {
      admission_no: admRow.get('admission_no') || '',
      roll_no: admRow.get('roll_no') || '',
      full_name: admRow.get('full_name') || '',
      dob: admRow.get('dob') || '',
      father_name: admRow.get('father_name') || '',
      phone: admRow.get('phone') || '',
      guardian_phone: admRow.get('guardian_phone') || '',
      aadhaar_no: admRow.get('aadhaar_no') || '',
      photo_file: admRow.get('photo_file') || '',
      address: admRow.get('address') || '',
      place: admRow.get('place') || '',
      pin: admRow.get('pin') || '',
      district: admRow.get('district') || '',
      state: admRow.get('state') || '',
      school_class: admRow.get('school_class') || '',
      madrasa_class: admRow.get('madrasa_class') || '',
      main_batch_name: batchNames[0] || 'No Batch',
      batch_name: batchNames.join(', ') || 'No Batch',
      created_at: admRow.get('created_at') || ''
    };

    let idTpl = {};
    try {
      const cfgSheet = await getSheet('id_config');
      if (cfgSheet) {
        const cfgRows = await cfgSheet.getRows();
        if (cfgRows.length > 0 && cfgRows[0].get('config_json')) {
          idTpl = JSON.parse(cfgRows[0].get('config_json'));
        }
      }
    } catch (e) {}

    const { getIdBrandingUrls } = require('../config/upload');
    const idBranding = typeof getIdBrandingUrls === 'function' ? getIdBrandingUrls() : getBrandingUrls();

    res.render('student_id_card', { student, idBranding, idTpl });
  } catch (err) {
    res.status(500).send('Error loading ID Card: ' + err.message);
  }
});

router.get('/student-logout', (req, res) => {
  delete req.session.student;
  res.redirect('/student-login');
});

// ==========================================
// 6. STUDENT SELF PASSWORD CHANGE (WITH CURRENT PASSWORD CHECK)
// ==========================================
router.post('/api/my-password-change', async (req, res) => {
  if (!req.session || !req.session.student) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  const targetAdmNo = String(req.session.student.admission_no || '').trim();
  const currentPassword = String(req.body.current_password || '').trim();
  const newPassword = String(req.body.new_password || '').trim();

  if (!currentPassword) {
    return res.status(400).json({ success: false, error: 'Please enter your current password.' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ success: false, error: 'New password must be at least 4 characters.' });
  }

  try {
    const portalCfg = await getPortalConfig();
    const perms = getEffectiveStudentPerms(portalCfg, targetAdmNo);

    if (!perms.allowPasswordChange) {
      return res.status(403).json({ success: false, error: 'Password change is disabled by teacher.' });
    }

    const admSheet = await getSheet('admissions');
    const rows = await admSheet.getRows();
    const row = rows.find(r => String(r.get('admission_no') || '').trim().toLowerCase() === targetAdmNo.toLowerCase());
    if (!row) return res.status(404).json({ success: false, error: 'Student not found' });

    const actualAdmNo = String(row.get('admission_no') || '').trim();
    const colPass = String(row.get('password') || '').trim();
    const colHash = String(row.get('password_hash') || '').trim();
    const savedSecret = colHash || colPass;

    let isCurrentMatch = false;
    if (savedSecret.startsWith('$2a$') || savedSecret.startsWith('$2b$') || savedSecret.startsWith('$2y$')) {
      isCurrentMatch = await bcrypt.compare(currentPassword, savedSecret);
    } else if (savedSecret !== '') {
      isCurrentMatch = (currentPassword === savedSecret);
    } else {
      isCurrentMatch = (currentPassword.toLowerCase() === actualAdmNo.toLowerCase());
    }

    if (!isCurrentMatch) {
      return res.status(400).json({ success: false, error: 'Current password is incorrect!' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    if (row.get('password_hash') !== undefined) row.set('password_hash', hashed);
    if (row.get('password') !== undefined) row.set('password', hashed);

    await row.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;