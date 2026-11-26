const bcrypt = require('bcryptjs');

function isProtectedAdmin(row) {
  if (!row) return false;
  const role = String(row.get('role') || '').trim().toLowerCase();
  return role === 'super_admin' || role === 'admin';
}

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

function requireStaffOrOwnStudent(req, res, next) {
  // 1. Staff / Admin logged in
  if (req.session && req.session.user) {
    if (req.session.user.can_admission == 1 || req.session.user.can_studet == 1 || req.session.user.can_manage == 1) {
      return next();
    }
    return res.status(403).send('Access Denied: You do not have permission to view ID Cards.');
  }

  // 2. Student logged in
  if (req.session && req.session.student) {
    const myAdm = String(req.session.student.admission_no || '').trim().toLowerCase();
    const reqAdms = String(req.query.adms || req.query.admNo || req.params.admission_no || '').trim().toLowerCase();

    if (!reqAdms || reqAdms === myAdm) {
      return next();
    }
    return res.status(403).send('Access Denied: You can only view your own documents.');
  }

  // 3. Not logged in
  return res.redirect('/login');
}

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

module.exports = {
  isProtectedAdmin,
  hashPassword,
  verifyPassword,
  requireAuth,
  requireStaffOrOwnStudent,
  checkManage,
  checkStudent,
  checkAdmission,
  checkAttendance,
  checkAttendanceView
};