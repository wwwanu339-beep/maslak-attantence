const express = require('express');
const router = express.Router();
const { getSheet } = require('../config/sheets');
const { getBrandingUrls, getIdBrandingUrls } = require('../config/upload');
const { verifyPassword } = require('../middleware/auth');

router.get('/student-login', (req, res) => {
  if (req.session && req.session.student) return res.redirect('/my-attendance');
  res.render('student_login', { error: null });
});

router.post('/student-login', async (req, res) => {
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

router.get('/my-attendance', async (req, res) => {
  if (!req.session || !req.session.student) return res.redirect('/student-login');

  const sessionStudent = req.session.student;
  const now = new Date();
  const selectedMonth = parseInt(req.query.month) || (now.getMonth() + 1);
  const selectedYear = parseInt(req.query.year) || now.getFullYear();

  try {
    const [attSheet, subjectSheet, stuSheet, admSheet, batchSheet] = await Promise.all([
      getSheet('attendance'),
      getSheet('subjects'),
      getSheet('students'),
      getSheet('admissions'),
      getSheet('batches')
    ]);

    const [attRows, subRows, stuRows, admRows, batchRows] = await Promise.all([
      attSheet.getRows(),
      subjectSheet.getRows(),
      stuSheet.getRows(),
      admSheet ? admSheet.getRows() : [],
      batchSheet.getRows()
    ]);

    const subjectMap = {};
    subRows.forEach(r => { subjectMap[r.get('id')] = r.get('name'); });

    const batchMap = {};
    batchRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    const targetAdmNo = String(sessionStudent.admission_no || '').trim().toLowerCase();
    const stuRow = stuRows.find(r => String(r.get('admission_no') || '').trim().toLowerCase() === targetAdmNo);
    const admRow = admRows.find(r => String(r.get('admission_no') || '').trim().toLowerCase() === targetAdmNo);
    const infoRow = stuRow || admRow;

    const rawBatchIds = String((infoRow && infoRow.get('batch_id')) || '').split(',').map(id => id.trim()).filter(Boolean);
    const batchNamesList = rawBatchIds.map(id => batchMap[id]).filter(Boolean);
    const mainBatchName = batchNamesList[0] || sessionStudent.batch_name || 'N/A';

    let rawPhoto = (admRow && admRow.get('photo_file')) || (stuRow && stuRow.get('photo_file')) || (infoRow && (infoRow.get('photo') || infoRow.get('photo_url'))) || '';
    let photoUrl = rawPhoto;
    if (rawPhoto.includes('drive.google.com')) {
      const match = rawPhoto.match(/[-\w]{25,}/);
      if (match) photoUrl = `https://drive.google.com/thumbnail?id=${match[0]}&sz=w500`;
    }

    const student = {
      ...sessionStudent,
      full_name: (infoRow && infoRow.get('full_name')) || sessionStudent.full_name,
      admission_no: (infoRow && infoRow.get('admission_no')) || sessionStudent.admission_no,
      roll_no: (infoRow && infoRow.get('roll_no')) || '',
      main_batch_name: mainBatchName,
      batch_name: batchNamesList.join(', ') || sessionStudent.batch_name || 'N/A',
      place: (admRow && (admRow.get('place') || admRow.get('address'))) || (stuRow && (stuRow.get('place') || stuRow.get('address'))) || 'N/A',
      phone: (infoRow && infoRow.get('phone')) || 'N/A',
      dob: (infoRow && (infoRow.get('dob') || infoRow.get('age'))) || 'N/A',
      photo_url: photoUrl
    };

    let presentCount = 0;
    let absentCount = 0;
    let leaveCount = 0;
    const records = [];

    attRows.forEach(r => {
      const admKey = String(r.get('admission_no') || r.get('student_id') || '').trim().toLowerCase();
      if (admKey !== targetAdmNo) return;

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

// 1. വിദ്യാർത്ഥിക്ക് സ്വന്തം ID Card (എഡിറ്റിംഗ് ഇല്ലാതെ PDF / Image ഡൗൺലോഡ് മാത്രം)
// 1. വിദ്യാർത്ഥിക്ക് സ്വന്തം ID Card (ടീച്ചറുടെ അതേ ഡിസൈനിൽ) തുറക്കാൻ
router.get('/my-id-card', (req, res) => {
  if (!req.session || !req.session.student) return res.redirect('/student-login');
  const admNo = String(req.session.student.admission_no || '').trim();
  res.redirect(`/id-cards?adm_no=${encodeURIComponent(admNo)}`);
});

// 2. വിദ്യാർത്ഥിക്ക് സ്വന്തം Admission Application കാണാനും പ്രിന്റ്/PDF ഡൗൺലോഡ് ചെയ്യാനും
// 2. വിദ്യാർത്ഥിക്ക് സ്വന്തം Admission Application കാണാനും പ്രിന്റ്/PDF ഡൗൺലോഡ് ചെയ്യാനും
router.get('/my-admission-form', async (req, res) => {
  if (!req.session || !req.session.student) return res.redirect('/student-login');
  const targetAdmNo = String(req.session.student.admission_no || '').trim().toLowerCase();

  try {
    const [admSheet, batchSheet] = await Promise.all([
      getSheet('admissions'),
      getSheet('batches')
    ]);

    const [aRows, bRows] = await Promise.all([
      admSheet.getRows(),
      batchSheet.getRows()
    ]);

    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    const admRow = aRows.find(r => String(r.get('admission_no') || '').trim().toLowerCase() === targetAdmNo);
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
    res.render('student_application_print', { student, branding, formTpl });
  } catch (err) {
    res.status(500).send('Database Error: ' + err.message);
  }
});

router.get('/student-logout', (req, res) => {
  delete req.session.student;
  res.redirect('/student-login');
});

module.exports = router;