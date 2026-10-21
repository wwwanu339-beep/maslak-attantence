require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. അടിസ്ഥാന മിഡിൽവെയറുകൾ
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 2. സെഷൻ മിഡിൽവെയർ
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key_here',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 1000 * 60 * 60 * 24 // 1 ദിവസം
  }
}));

// 3. എല്ലാ EJS പേജുകളിലും user വേരിയബിൾ എപ്പോഴും ലഭ്യമാക്കാൻ
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// വ്യൂ എഞ്ചിൻ
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Neon PostgreSQL ഡാറ്റാബേസ് കണക്ഷൻ
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ================= പെർമിഷൻ ഫംഗ്ഷനുകൾ (Middlewares) =================

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
}

function checkManage(req, res, next) {
  if (req.session.user && req.session.user.can_manage == 1) {
    next();
  } else {
    res.status(403).send("ഈ പേജ് തുറക്കാൻ നിങ്ങൾക്ക് അനുമതിയില്ല!");
  }
}

function checkStudent(req, res, next) {
  if (req.session.user && req.session.user.can_studet == 1) {
    next();
  } else {
    res.status(403).send("ഈ പേജ് തുറക്കാൻ നിങ്ങൾക്ക് അനുമതിയില്ല!");
  }
}

function checkAttendance(req, res, next) {
  if (req.session.user && req.session.user.can_attendance == 1) {
    next();
  } else {
    res.status(403).send("ഈ പേജ് തുറക്കാൻ നിങ്ങൾക്ക് അനുമതിയില്ല!");
  }
}

function checkAttendanceView(req, res, next) {
  if (req.session.user && req.session.user.can_attendanceveiw == 1) {
    next();
  } else {
    res.status(403).send("ഈ പേജ് തുറക്കാൻ നിങ്ങൾക്ക് അനുമതിയില്ല!");
  }
}

// ================= AUTH ROUTES =================
app.get('/', (req, res) => {
  res.redirect('/login');
});

// ഡാഷ്‌ബോർഡ്
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const studentRes = await pool.query("SELECT COUNT(*) AS totalstudents FROM students WHERE status = 'active'");
    const userRes = await pool.query("SELECT COUNT(*) AS totalusers FROM users");
    const attRes = await pool.query("SELECT COUNT(*) AS totalattendance FROM attendance");

    const totalStudents = studentRes.rows[0].totalstudents;
    const totalUsers = userRes.rows[0].totalusers;
    const totalAttendance = attRes.rows[0].totalattendance;

    res.render('dashboard', { totalStudents, totalUsers, totalAttendance });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

// ലോഗിൻ പേജ്
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

// ലോഗിൻ പരിശോധന
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE username = $1 AND password = $2",
      [username, password]
    );

    if (rows.length > 0) {
      req.session.user = {
        id: rows[0].id,
        username: rows[0].username,
        can_attendance: rows[0].can_attendance,
        can_manage: rows[0].can_manage,
        can_attendanceveiw: rows[0].can_attendanceveiw,
        can_studet: rows[0].can_studet
      };
      res.redirect('/dashboard');
    } else {
      res.render('login', { error: 'Username അല്ലെങ്കിൽ Password തെറ്റാണ്!' });
    }
  } catch (err) {
    res.status(500).render('login', { error: 'സെർവർ എറർ: ' + err.message });
  }
});

// ലോഗ് ഔട്ട്
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// ================= 2. SETTINGS =================
app.get('/settings', requireAuth, checkManage, async (req, res) => {
  try {
    const batches = (await pool.query("SELECT * FROM batches ORDER BY id DESC")).rows;
    const subjects = (await pool.query("SELECT * FROM subjects ORDER BY id DESC")).rows;
    const users = (await pool.query("SELECT id, username FROM users ORDER BY id DESC")).rows;
    res.render('add', { batches, subjects, users });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Batch APIs
app.post('/api/batches', requireAuth, checkManage, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name required' });
    await pool.query("INSERT INTO batches (name) VALUES ($1)", [name]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/batches/:id', requireAuth, checkManage, async (req, res) => {
  try {
    await pool.query("DELETE FROM batches WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Subject APIs
app.post('/api/subjects', requireAuth, checkManage, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name required' });
    await pool.query("INSERT INTO subjects (name) VALUES ($1)", [name]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/subjects/:id', requireAuth, checkManage, async (req, res) => {
  try {
    await pool.query("DELETE FROM subjects WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// User APIs
app.post('/api/users', requireAuth, checkManage, async (req, res) => {
  const { username, password, can_attendance, can_manage, can_attendanceveiw, can_studet } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: 'All fields required' });
  try {
    await pool.query(
      "INSERT INTO users (username, password, can_attendance, can_manage, can_attendanceveiw, can_studet) VALUES ($1, $2, $3, $4, $5, $6)",
      [username, password, can_attendance ? 1 : 0, can_manage ? 1 : 0, can_attendanceveiw ? 1 : 0, can_studet ? 1 : 0]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/users/:id', requireAuth, checkManage, async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 3. STUDENTS =================
app.get('/students', requireAuth, checkStudent, async (req, res) => {
  try {
    const studentsQuery = `
      SELECT s.*, b.name AS batch_name 
      FROM students s 
      LEFT JOIN batches b ON s.batch_id = b.id 
      WHERE s.status = 'active' 
      ORDER BY s.batch_id ASC, NULLIF(regexp_replace(s.admission_no, '\\D', '', 'g'), '')::INT ASC NULLS LAST, s.id ASC
    `;
    const { rows: students } = await pool.query(studentsQuery);
    const { rows: batches } = await pool.query("SELECT * FROM batches ORDER BY name ASC");
    res.render('studet', { students, batches });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

app.post('/api/students', requireAuth, checkStudent, async (req, res) => {
  try {
    const { full_name, age, phone, batch_id, admission_no } = req.body;
    await pool.query(
      "INSERT INTO students (full_name, age, phone, batch_id, admission_no) VALUES ($1, $2, $3, $4, $5)",
      [
        full_name, 
        age ? parseInt(age) : null, 
        phone || null, 
        batch_id, 
        admission_no ? admission_no.trim() : null
      ]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/students/:id', requireAuth, checkStudent, async (req, res) => {
  try {
    const { full_name, age, phone, batch_id, admission_no } = req.body;
    await pool.query(
      "UPDATE students SET full_name = $1, age = $2, phone = $3, batch_id = $4, admission_no = $5 WHERE id = $6",
      [
        full_name, 
        age ? parseInt(age) : null, 
        phone || null, 
        batch_id, 
        admission_no ? admission_no.trim() : null, 
        req.params.id
      ]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 4. ATTENDANCE =================
app.get('/attendance', requireAuth, checkAttendance, async (req, res) => {
  try {
    const { rows: batches } = await pool.query("SELECT * FROM batches ORDER BY name ASC");
    const { rows: subjects } = await pool.query("SELECT * FROM subjects ORDER BY name ASC");
    res.render('attanten', { batches, subjects });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

app.get('/api/attendance-data', requireAuth, checkAttendance, async (req, res) => {
  const { batch_id, subject_id, date } = req.query;

  if (!batch_id || !subject_id || !date) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  try {
    let studentSql = `
      SELECT s.id, s.full_name, s.admission_no, s.batch_id, b.name AS batch_name 
      FROM students s 
      LEFT JOIN batches b ON s.batch_id = b.id 
      WHERE s.status = 'active'
    `;
    const studentParams = [];

    if (batch_id !== 'all') {
      studentParams.push(batch_id);
      studentSql += ` AND s.batch_id = $${studentParams.length}`;
    }

    studentSql += " ORDER BY s.batch_id ASC, NULLIF(regexp_replace(s.admission_no, '\\D', '', 'g'), '')::INT ASC NULLS LAST, s.id ASC";

    const { rows: students } = await pool.query(studentSql, studentParams);

    let attSql = "SELECT student_id, status FROM attendance WHERE date = $1";
    const attParams = [date];

    if (batch_id !== 'all') {
      attParams.push(batch_id);
      attSql += ` AND batch_id = $${attParams.length}`;
    }

    if (subject_id !== 'all') {
      attParams.push(subject_id);
      attSql += ` AND subject_id = $${attParams.length}`;
    }

    const { rows: logs } = await pool.query(attSql, attParams);

    const statusMap = {};
    logs.forEach(l => {
      statusMap[l.student_id] = l.status;
    });

    res.json({ success: true, students, statusMap });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/save-attendance', requireAuth, checkAttendance, async (req, res) => {
  const { subject_id, date, records } = req.body;

  if (!subject_id || !date || !records || records.length === 0) {
    return res.status(400).json({ success: false, error: 'വിവരങ്ങൾ അപൂർണ്ണമാണ്!' });
  }

  try {
    // PostgreSQL Bulk Upsert (student_id, date, subject_id എന്നിവയിൽ UNIQUE constraint ഉണ്ടാകണം)
    const valuePlaceholders = [];
    const values = [];
    let counter = 1;

    records.forEach(r => {
      valuePlaceholders.push(`($${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++})`);
      values.push(r.student_id, r.batch_id, subject_id, date, r.status);
    });

    const sql = `
      INSERT INTO attendance (student_id, batch_id, subject_id, date, status)
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (student_id, date, subject_id) 
      DO UPDATE SET status = EXCLUDED.status, batch_id = EXCLUDED.batch_id
    `;

    await pool.query(sql, values);
    res.json({ success: true, message: 'ഹാജർ വിജയകരമായി സേവ് ചെയ്തു!' });
  } catch (err) {
    console.error("Save Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 5. MONTHLY MATRIX =================
app.get('/monthly-report', requireAuth, checkAttendanceView, async (req, res) => {
  try {
    const { rows: batches } = await pool.query("SELECT * FROM batches ORDER BY name ASC");
    const { rows: subjects } = await pool.query("SELECT * FROM subjects ORDER BY name ASC");
    res.render('attveiw', { batches, subjects });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

app.get('/api/monthly-matrix', requireAuth, checkAttendanceView, async (req, res) => {
  const { batch_id, subject_id, month, year } = req.query;

  if (!batch_id || !month || !year) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  try {
    const daysInMonth = new Date(year, month, 0).getDate();

    let studentSql = `
      SELECT s.id, s.admission_no, s.full_name, s.batch_id, b.name AS batch_name 
      FROM students s 
      LEFT JOIN batches b ON s.batch_id = b.id 
      WHERE s.status = 'active'
    `;
    const studentParams = [];

    if (batch_id !== 'all') {
      studentParams.push(batch_id);
      studentSql += ` AND s.batch_id = $${studentParams.length}`;
    }

    studentSql += " ORDER BY s.batch_id ASC, NULLIF(regexp_replace(s.admission_no, '\\D', '', 'g'), '')::INT ASC NULLS LAST, s.id ASC";

    const { rows: students } = await pool.query(studentSql, studentParams);

    let attSql = `
      SELECT student_id, EXTRACT(DAY FROM date)::INT AS day, status 
      FROM attendance 
      WHERE EXTRACT(MONTH FROM date) = $1 AND EXTRACT(YEAR FROM date) = $2
    `;
    const params = [parseInt(month), parseInt(year)];

    if (batch_id !== 'all') {
      params.push(batch_id);
      attSql += ` AND batch_id = $${params.length}`;
    }

    if (subject_id && subject_id !== 'all') {
      params.push(subject_id);
      attSql += ` AND subject_id = $${params.length}`;
    }

    const { rows: attRows } = await pool.query(attSql, params);

    const attMap = {};
    attRows.forEach(r => {
      if (!attMap[r.student_id]) attMap[r.student_id] = {};
      attMap[r.student_id][r.day] = r.status;
    });

    res.json({ success: true, students, attMap, daysInMonth });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/student-day-details', requireAuth, checkAttendanceView, async (req, res) => {
  const { student_id, date } = req.query;
  if (!student_id || !date) {
    return res.status(400).json({ success: false, error: 'Student ID and Date required' });
  }

  try {
    const { rows: students } = await pool.query(
      "SELECT s.id, s.admission_no, s.full_name, b.name AS batch_name FROM students s LEFT JOIN batches b ON s.batch_id = b.id WHERE s.id = $1",
      [student_id]
    );

    if (students.length === 0) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    const student = students[0];

    const { rows: sessions } = await pool.query(`
      SELECT sub.name AS subject_name, a.status, a.created_at
      FROM attendance a
      JOIN subjects sub ON a.subject_id = sub.id
      WHERE a.student_id = $1 AND a.date = $2
      ORDER BY a.id ASC
    `, [student_id, date]);

    res.json({ success: true, student, sessions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));