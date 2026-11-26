const express = require('express');
const router = express.Router();
const { getSheet } = require('../config/sheets');
const { requireAuth, checkManage, isProtectedAdmin, hashPassword, verifyPassword } = require('../middleware/auth');

const DEFAULT_PORTAL_CFG = {
  globalShowForm: true,
  globalShowIdCard: true,
  globalAllowEdit: false,
  globalAllowPasswordChange: false,
  allowedFields: ['phone', 'guardian_phone', 'address', 'place', 'pin', 'district', 'state'],
  studentOverrides: {}
};

// Helper: Verify Main Admin Password for all Delete / Clear operations
async function verifyMainAdminPassword(adminPassword) {
  if (!adminPassword) return { ok: false, status: 400, error: 'Main Admin password is required!' };
  const userSheet = await getSheet('users');
  const uRows = await userSheet.getRows();
  const protectedAdmins = uRows.filter(r => isProtectedAdmin(r));

  if (protectedAdmins.length === 0) {
    return { ok: false, status: 404, error: 'Main Admin account not found!' };
  }

  for (const adm of protectedAdmins) {
    if (await verifyPassword(adminPassword, adm.get('password'))) {
      return { ok: true };
    }
  }
  return { ok: false, status: 401, error: 'Incorrect Main Admin password!' };
}

router.get('/settings', requireAuth, checkManage, async (req, res) => {
  try {
    const [batchSheet, subjectSheet, userSheet, admSheet, cfgSheet] = await Promise.all([
      getSheet('batches'),
      getSheet('subjects'),
      getSheet('users'),
      getSheet('admissions'),
      getSheet('portal_config')
    ]);

    const [bRows, sRows, uRows, aRows, cRows] = await Promise.all([
      batchSheet.getRows(),
      subjectSheet.getRows(),
      userSheet.getRows(),
      admSheet ? admSheet.getRows() : [],
      cfgSheet ? cfgSheet.getRows() : []
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

    const batchMap = {};
    bRows.forEach(r => {
      batchMap[String(r.get('id') || '').trim()] = r.get('name');
    });

    const students = aRows
      .filter(r => (r.get('full_name') || '').trim() !== '')
      .map(r => {
        const rawB = String(r.get('batch_id') || '').split(',').map(x => x.trim()).filter(Boolean);
        return {
          admission_no: String(r.get('admission_no') || '').trim(),
          roll_no: r.get('roll_no') || '',
          full_name: r.get('full_name') || '',
          batch_name: rawB.map(id => batchMap[id]).filter(Boolean).join(', ') || 'No Batch'
        };
      })
      .reverse();

    let portalCfg = { ...DEFAULT_PORTAL_CFG };
    if (cRows.length > 0 && cRows[0].get('config_json')) {
      try {
        portalCfg = { ...DEFAULT_PORTAL_CFG, ...JSON.parse(cRows[0].get('config_json')) };
      } catch (e) {}
    }

    res.render('add', { batches, subjects, users, students, portalCfg });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

router.post('/api/batches', requireAuth, checkManage, async (req, res) => {
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

router.delete('/api/batches/:id', requireAuth, checkManage, async (req, res) => {
  try {
    const authCheck = await verifyMainAdminPassword(req.body.adminPassword);
    if (!authCheck.ok) return res.status(authCheck.status).json({ success: false, error: authCheck.error });

    const sheet = await getSheet('batches');
    const rows = await sheet.getRows();
    const row = rows.find(r => String(r.get('id')) === String(req.params.id));
    if (row) await row.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/subjects', requireAuth, checkManage, async (req, res) => {
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

router.delete('/api/subjects/:id', requireAuth, checkManage, async (req, res) => {
  try {
    const authCheck = await verifyMainAdminPassword(req.body.adminPassword);
    if (!authCheck.ok) return res.status(authCheck.status).json({ success: false, error: authCheck.error });

    const sheet = await getSheet('subjects');
    const rows = await sheet.getRows();
    const row = rows.find(r => String(r.get('id')) === String(req.params.id));
    if (row) await row.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/users', requireAuth, checkManage, async (req, res) => {
  const {
    name, phone, username, password, role, allowed_batch, allowed_subject,
    can_attendance, can_update, can_manage, can_attendanceveiw, can_studet, can_admission, can_studio
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
      can_admission: can_admission ? '1' : '0',
      can_studio: can_studio ? '1' : '0'
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/api/users/:id', requireAuth, checkManage, async (req, res) => {
  try {
    const authCheck = await verifyMainAdminPassword(req.body.adminPassword);
    if (!authCheck.ok) return res.status(authCheck.status).json({ success: false, error: authCheck.error });

    const sheet = await getSheet('users');
    const rows = await sheet.getRows();
    const targetId = String(req.params.id).trim();

    const row = rows.find(r => String(r.get('id')).trim() === targetId);
    if (!row) return res.status(404).json({ success: false, error: 'User not found!' });
    if (isProtectedAdmin(row)) return res.status(403).json({ success: false, error: 'Protected Admin account cannot be deleted!' });

    await row.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'Both current and new passwords are required!' });
  }

  try {
    const sheet = await getSheet('users');
    const rows = await sheet.getRows();
    const userRow = rows.find(r => String(r.get('username')).trim() === String(req.session.user.username).trim());

    if (!userRow) return res.status(404).json({ success: false, error: 'User record not found!' });

    const isMatch = await verifyPassword(currentPassword, userRow.get('password'));
    if (!isMatch) return res.status(401).json({ success: false, error: 'Current password is incorrect!' });

    userRow.set('password', await hashPassword(newPassword));
    await userRow.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/api/clear/:target', requireAuth, checkManage, async (req, res) => {
  const target = req.params.target;
  const allowedTargets = ['attendance', 'students', 'subjects', 'batches', 'users'];

  if (!allowedTargets.includes(target)) return res.status(400).json({ success: false, error: 'Invalid clear target!' });

  try {
    const authCheck = await verifyMainAdminPassword(req.body.adminPassword);
    if (!authCheck.ok) return res.status(authCheck.status).json({ success: false, error: authCheck.error });

    const sheet = await getSheet(target);
    if (!sheet) return res.status(404).json({ success: false, error: `Sheet "${target}" not found!` });

    const rows = await sheet.getRows();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (target === 'users' && isProtectedAdmin(rows[i])) continue;
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

module.exports = router;