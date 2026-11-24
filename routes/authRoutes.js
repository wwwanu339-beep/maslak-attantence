const express = require('express');
const router = express.Router();
const { getSheet } = require('../config/sheets');
const { requireAuth, verifyPassword } = require('../middleware/auth');

router.get('/', (req, res) => res.redirect('/login'));

router.get('/dashboard', requireAuth, async (req, res) => {
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

router.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
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

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;