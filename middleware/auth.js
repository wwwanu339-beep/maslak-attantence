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

function requireStaffOrOwnStudent(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }

  if (req.session && req.session.student) {
    const loggedAdm = String(req.session.student.admission_no || '').trim().toLowerCase();
    const paramAdm = String(req.params.admNo || req.query.admNo || req.query.adm_no || '').trim().toLowerCase();
    
    if (loggedAdm && loggedAdm === paramAdm) {
      return next();
    }
    return res.status(403).send("Access Denied: You can only view your own documents.");
  }

  return res.redirect('/student-login');
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