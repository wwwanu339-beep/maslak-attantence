const express = require('express');
const router = express.Router();
const { getSheet } = require('../config/sheets');
const { requireAuth, checkManage, isProtectedAdmin, hashPassword, verifyPassword } = require('../middleware/auth');

router.get('/settings', requireAuth, checkManage, async (req, res) => {
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

router.delete('/api/users/:id', requireAuth, checkManage, async (req, res) => {
  try {
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
  const { adminPassword } = req.body;
  const allowedTargets = ['attendance', 'students', 'subjects', 'batches', 'users'];

  if (!allowedTargets.includes(target)) return res.status(400).json({ success: false, error: 'Invalid clear target!' });
  if (!adminPassword) return res.status(400).json({ success: false, error: 'Main Admin password is required!' });

  try {
    const userSheet = await getSheet('users');
    const uRows = await userSheet.getRows();

    const protectedAdmins = uRows.filter(r => isProtectedAdmin(r));
    if (protectedAdmins.length === 0) return res.status(404).json({ success: false, error: 'Main Admin account not found!' });

    let isPasswordValid = false;
    for (const adm of protectedAdmins) {
      if (await verifyPassword(adminPassword, adm.get('password'))) {
        isPasswordValid = true;
        break;
      }
    }

    if (!isPasswordValid) return res.status(401).json({ success: false, error: 'Incorrect Main Admin password!' });

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