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
  allowedFields: ['phone', 'guardian_phone', 'address', 'place', 'pin', 'district', 'state'],
  studentOverrides: {}
};

async function getPortalConfig() {
  try {
    const sheet = await getSheet('portal_config');
    if (sheet) {
      const rows = await sheet.getRows();
      if (rows.length > 0 && rows[0].get('config_json')) {
        return { ...DEFAULT_PORTAL_CFG, ...JSON.parse(rows[0].get('config_json')) };
      }
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
    // Read all possible password column names from sheet
    const colPass = String(stuRow.get('password') || '').trim();
    const colHash = String(stuRow.get('password_hash') || '').trim();
    const savedSecret = colHash || colPass;

    let isMatch = false;
    if (savedSecret.startsWith('$2a$') || savedSecret.startsWith('$2b$') || savedSecret.startsWith('$2y$')) {
      isMatch = await bcrypt.compare(password, savedSecret);
    } else if (savedSecret !== '') {
      isMatch = (password === savedSecret);
    } else {
      // If no password is set in sheet, allow Admission No (case-insensitive)
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
  const selectedMonth = parseInt(req.query.month, 10) || (now.getMonth() + 1);
  const selectedYear = parseInt(req.query.year, 10) || now.getFullYear();

  try {
    const [admSheet, attSheet, batchSheet, portalCfg] = await Promise.all([
      getSheet('admissions'),
      getSheet('attendance'),
      getSheet('batches'),
      getPortalConfig()
    ]);

    const [aRows, attRows, bRows] = await Promise.all([
      admSheet.getRows(),
      attSheet ? attSheet.getRows() : [],
      batchSheet.getRows()
    ]);

    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

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
        // Check student_id (where Admission No is saved) as well as admission_no
        const savedAdm = String(
          r.get('student_id') ||
          r.get('Student ID') ||
          r.get('admission_no') ||
          r.get('adm_no') ||
          ''
        ).trim().toLowerCase();

        if (savedAdm !== targetAdmNo.toLowerCase()) return false;

        const dStr = String(r.get('date') || r.get('att_date') || '').trim();
        if (!dStr) return false;

        // Supports YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD
        const parts = dStr.split(/[-/\s]/);
        if (parts.length < 3) return false;

        let m = 0, y = 0;
        if (parts[0].length === 4) {
          y = parseInt(parts[0], 10);
          m = parseInt(parts[1], 10);
        } else {
          m = parseInt(parts[1], 10);
          y = parseInt(parts[2], 10);
        }
        return m === selectedMonth && y === selectedYear;
      })
      .map(r => {
        const rawSt = String(r.get('status') || r.get('attendance') || '').trim().toLowerCase();
        let normStatus = rawSt;
        if (rawSt === 'p' || rawSt === 'present') normStatus = 'present';
        else if (rawSt === 'a' || rawSt === 'absent') normStatus = 'absent';
        else if (rawSt === 'l' || rawSt === 'lv' || rawSt === 'leave' || rawSt === 'late') normStatus = 'leave';

        return {
          date: r.get('date') || r.get('att_date') || '',
          subject: r.get('subject') || r.get('subject_name') || '-',
          teacher: r.get('teacher') || r.get('marked_by') || r.get('teacher_name') || '-',
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
    res.render('student_attendance', { student, records, stats, perms, selectedMonth, selectedYear });
  } catch (err) {
    res.status(500).send('Portal Error: ' + err.message);
  }
});
// ==========================================
// 3. ADMIN STUDENT PORTAL CONTROL PANEL
// ==========================================
router.get('/student-portal-control', requireAuth, checkAdmission, async (req, res) => {
  try {
    const [admSheet, batchSheet, portalCfg] = await Promise.all([
      getSheet('admissions'),
      getSheet('batches'),
      getPortalConfig()
    ]);
    const [aRows, bRows] = await Promise.all([admSheet.getRows(), batchSheet.getRows()]);

    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    const students = aRows
      .filter(r => (r.get('full_name') || '').trim() !== '')
      .map(r => {
        const admNo = String(r.get('admission_no') || '').trim();
        const rawB = String(r.get('batch_id') || '').split(',').map(x => x.trim()).filter(Boolean);
        return {
          admission_no: admNo,
          roll_no: r.get('roll_no') || '',
          full_name: r.get('full_name') || '',
          batch_name: rawB.map(id => batchMap[id]).filter(Boolean).join(', ') || 'No Batch',
          status: (r.get('status') || 'pending').trim().toLowerCase(),
          perms: getEffectiveStudentPerms(portalCfg, admNo)
        };
      })
      .reverse();

    res.render('student_portal_control', { students, portalCfg });
  } catch (err) {
    res.status(500).send('Error loading Portal Control: ' + err.message);
  }
});

router.post('/api/student-portal-control', requireAuth, checkAdmission, async (req, res) => {
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

module.exports = router;

