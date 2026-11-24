const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { getSheet, generateNextAdmissionNo, syncAndReorderRolls } = require('../config/sheets');
const {
  uploadDir, admUploads, brandingUpload, idBrandingUpload,
  getBrandingUrls, getIdBrandingUrls
} = require('../config/upload');
const { requireAuth, requireStaffOrOwnStudent, checkAdmission, hashPassword } = require('../middleware/auth');

// Public Online Admission Portal
router.get('/apply', async (req, res) => {
  try {
    const branding = getBrandingUrls();
    res.render('apply_admission', { branding });
  } catch (err) {
    res.status(500).send('Error loading admission form: ' + err.message);
  }
});

router.post('/api/public-admissions', admUploads, async (req, res) => {
  try {
    const {
      full_name, dob, father_name, phone, guardian_phone, aadhaar_no,
      address, place, pin, district, state, is_muthallim, prev_institution, prev_place,
      school_class, madrasa_class, password
    } = req.body;

    if (
      !full_name || !dob || !father_name || !aadhaar_no ||
      !phone || !guardian_phone || !pin || !place ||
      !district || !state || !address || !madrasa_class || !school_class || !password
    ) {
      return res.status(400).json({ success: false, error: 'Please fill in all required fields!' });
    }

    if (is_muthallim === 'yes' && (!prev_institution || !prev_place)) {
      return res.status(400).json({ success: false, error: 'Please enter Previous Institution Name and Place!' });
    }

    if (!req.files?.photo?.[0] || !req.files?.aadhaar_doc?.[0]) {
      return res.status(400).json({ success: false, error: 'Please upload both Student Photo and Aadhaar Document!' });
    }

    const onlineSheet = await getSheet('online_admissions');
    if (!onlineSheet) {
      return res.status(500).json({ success: false, error: 'Please create the "online_admissions" tab in your Google Sheet!' });
    }

    const appId = `APP-${Date.now()}`;
    const photoPath = `/uploads/${req.files.photo[0].filename}`;
    const aadhaarPath = `/uploads/${req.files.aadhaar_doc[0].filename}`;
    const hashedPassword = await hashPassword(password);

    await onlineSheet.addRow({
      app_id: appId,
      full_name: full_name.trim(),
      dob: String(dob).trim(),
      father_name: father_name.trim(),
      address: address.trim(),
      place: place.trim(),
      pin: String(pin).trim(),
      district: district.trim(),
      state: state.trim(),
      is_muthallim: is_muthallim === 'yes' ? 'yes' : 'no',
      prev_institution: is_muthallim === 'yes' ? prev_institution.trim() : '',
      prev_place: is_muthallim === 'yes' ? prev_place.trim() : '',
      school_class: String(school_class).trim(),
      madrasa_class: String(madrasa_class).trim(),
      aadhaar_no: String(aadhaar_no).trim(),
      aadhaar_file: aadhaarPath,
      photo_file: photoPath,
      phone: String(phone).trim(),
      guardian_phone: String(guardian_phone).trim(),
      password: hashedPassword,
      created_at: new Date().toISOString().split('T')[0]
    });

    res.json({ success: true, app_id: appId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Staff Approve Online Application
router.post('/api/online-admissions/:appId/approve', requireAuth, checkAdmission, async (req, res) => {
  try {
    const targetAppId = String(req.params.appId).trim();
    const onlineSheet = await getSheet('online_admissions');
    const admSheet = await getSheet('admissions');
    const stuSheet = await getSheet('students');

    if (!onlineSheet) return res.status(404).json({ success: false, error: 'online_admissions sheet not found!' });

    const [oRows, aRows, sRows] = await Promise.all([
      onlineSheet.getRows(),
      admSheet.getRows(),
      stuSheet.getRows()
    ]);

    const appRow = oRows.find(r => String(r.get('app_id') || '').trim() === targetAppId);
    if (!appRow) return res.status(404).json({ success: false, error: 'Online application not found!' });

    const permanentAdmNo = generateNextAdmissionNo(aRows, sRows);
    const finalPassword = appRow.get('password') || await hashPassword(permanentAdmNo);

    await admSheet.addRow({
      admission_no: permanentAdmNo,
      roll_no: '',
      full_name: appRow.get('full_name') || '',
      dob: appRow.get('dob') || '',
      father_name: appRow.get('father_name') || '',
      address: appRow.get('address') || '',
      place: appRow.get('place') || '',
      pin: appRow.get('pin') || '',
      district: appRow.get('district') || '',
      state: appRow.get('state') || '',
      is_muthallim: appRow.get('is_muthallim') || 'no',
      prev_institution: appRow.get('prev_institution') || '',
      prev_place: appRow.get('prev_place') || '',
      school_class: appRow.get('school_class') || '',
      madrasa_class: appRow.get('madrasa_class') || '',
      aadhaar_no: appRow.get('aadhaar_no') || '',
      aadhaar_file: appRow.get('aadhaar_file') || '',
      photo_file: appRow.get('photo_file') || '',
      phone: appRow.get('phone') || '',
      guardian_phone: appRow.get('guardian_phone') || '',
      batch_id: '',
      password: finalPassword,
      status: 'pending',
      created_at: new Date().toISOString().split('T')[0]
    });

    await appRow.delete();
    res.json({ success: true, admission_no: permanentAdmNo });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/api/online-admissions/:appId', requireAuth, checkAdmission, async (req, res) => {
  try {
    const targetAppId = String(req.params.appId).trim();
    const onlineSheet = await getSheet('online_admissions');
    if (!onlineSheet) return res.status(404).json({ success: false, error: 'online_admissions sheet not found!' });

    const oRows = await onlineSheet.getRows();
    const appRow = oRows.find(r => String(r.get('app_id') || '').trim() === targetAppId);
    if (appRow) await appRow.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Print Branding Upload
router.post('/api/admission-branding', requireAuth, checkAdmission, brandingUpload, (req, res) => {
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

// Staff Admissions View
router.get('/admissions', requireAuth, checkAdmission, async (req, res) => {
  try {
    const admSheet = await getSheet('admissions');
    const stuSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');
    const onlineSheet = await getSheet('online_admissions');

    if (!admSheet) return res.status(500).send('Please create the "admissions" tab in your Google Sheet.');

    const [aRows, sRows, bRows, oRows] = await Promise.all([
      admSheet.getRows(),
      stuSheet.getRows(),
      batchSheet.getRows(),
      onlineSheet ? onlineSheet.getRows() : Promise.resolve([])
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

    const onlineApplications = oRows
      .filter(r => (r.get('full_name') || '').trim() !== '')
      .map((r, i) => ({
        app_id: String(r.get('app_id') || `ROW-${i + 1}`).trim(),
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
        created_at: r.get('created_at') || ''
      }))
      .reverse();

    let savedFormTpl = {};
    try {
      const cfgSheet = await getSheet('form_config');
      if (cfgSheet) {
        const cfgRows = await cfgSheet.getRows();
        if (cfgRows.length > 0 && cfgRows[0].get('config_json')) {
          savedFormTpl = JSON.parse(cfgRows[0].get('config_json'));
        }
      }
    } catch (e) {}

    const branding = getBrandingUrls();
    res.render('admission', { batches, allStudents, onlineApplications, nextAdmissionNo, branding, savedFormTpl });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

// Create Staff Direct Admission
router.post('/api/admissions', requireAuth, checkAdmission, admUploads, async (req, res) => {
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

// Edit Admission
router.put('/api/admissions/:admNo', requireAuth, checkAdmission, admUploads, async (req, res) => {
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

// Change Admission Status (Supports: active, pending / Not Active, completed / Complete)
router.put('/api/admissions/:admNo/status', requireAuth, checkAdmission, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const status = String(req.body.status || '').trim().toLowerCase();

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
    } else if (status === 'completed') {
      admRow.set('status', 'completed');
      await admRow.save();

      const existingStu = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
      if (existingStu) await existingStu.delete();
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

// Delete Admission
router.delete('/api/admissions/:admNo', requireAuth, checkAdmission, async (req, res) => {
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

// ID Card Studio Routes
// ID Card Studio Routes
// Unified Design Studio Loader (Supports both ID Card & Admission Form tabs)
async function renderUnifiedStudio(req, res, initialTab = 'form') {
  try {
    const admSheet = await getSheet('admissions');
    const batchSheet = await getSheet('batches');
    const [aRows, bRows] = await Promise.all([admSheet.getRows(), batchSheet.getRows()]);

    const batchMap = {};
    const batches = bRows.map(r => {
      batchMap[r.get('id')] = r.get('name');
      return { id: r.get('id'), name: r.get('name') };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    let allStudents = aRows
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
          photo_file: r.get('photo_file') || '',
          address: r.get('address') || '',
          place: r.get('place') || '',
          pin: r.get('pin') || '',
          district: r.get('district') || '',
          state: r.get('state') || '',
          school_class: r.get('school_class') || '',
          madrasa_class: r.get('madrasa_class') || '',
          batch_id: r.get('batch_id') || '',
          main_batch_name: batchNamesList[0] || 'No Batch',
          batch_name: batchNamesList.join(', ') || 'No Batch',
          created_at: r.get('created_at') || new Date().toISOString().split('T')[0],
          status: (r.get('status') || 'pending').trim().toLowerCase()
        };
      })
      .reverse();

    const isStudentView = Boolean(!req.session?.user && req.session?.student);
    if (isStudentView) {
      const myAdmNo = String(req.session.student.admission_no || '').trim().toLowerCase();
      allStudents = allStudents.filter(s => s.admission_no.toLowerCase() === myAdmNo);
    }

    let savedFormTpl = {};
    let savedIdTpl = {};
    try {
      const [fSheet, iSheet] = await Promise.all([getSheet('form_config'), getSheet('id_config')]);
      if (fSheet) {
        const fRows = await fSheet.getRows();
        if (fRows.length > 0 && fRows[0].get('config_json')) savedFormTpl = JSON.parse(fRows[0].get('config_json'));
      }
      if (iSheet) {
        const iRows = await iSheet.getRows();
        if (iRows.length > 0 && iRows[0].get('config_json')) savedIdTpl = JSON.parse(iRows[0].get('config_json'));
      }
    } catch (e) {}

    const branding = getBrandingUrls();
    const idBranding = getIdBrandingUrls();

    res.render('unified_studio', {
      initialTab,
      batches,
      allStudents,
      branding,
      idBranding,
      savedFormTpl,
      savedIdTpl,
      isStudentView
    });
  } catch (err) {
    res.status(500).send('Error loading Design Studio: ' + err.message);
  }
}

router.get('/id-cards', requireStaffOrOwnStudent, (req, res) => renderUnifiedStudio(req, res, 'id'));
router.get('/admission-form-studio', requireAuth, checkAdmission, (req, res) => renderUnifiedStudio(req, res, 'form'));

router.post('/api/id-card-branding', requireAuth, checkAdmission, idBrandingUpload, (req, res) => {
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
    res.json({ success: true, ...getIdBrandingUrls() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// ID Card ഡിസൈൻ സെറ്റിംഗ്സ് Google Sheet-ൽ സേവ് ചെയ്യാനും എടുക്കാനും
router.post('/api/id-card-template', requireAuth, checkAdmission, async (req, res) => {
  try {
    let sheet = await getSheet('id_config');
    if (!sheet) return res.status(400).json({ success: false, error: 'Please create an "id_config" tab in Google Sheet with header: config_json' });
    
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


router.post('/api/admission-form-template', requireAuth, checkAdmission, async (req, res) => {
  try {
    const sheet = await getSheet('form_config');
    if (!sheet) return res.status(400).json({ success: false, error: 'Please create "form_config" tab in Google Sheet with header: config_json' });

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

module.exports = router;