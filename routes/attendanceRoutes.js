const express = require('express');
const router = express.Router();
const { getSheet } = require('../config/sheets');
const { requireAuth, checkAttendance, checkAttendanceView, checkAdmission } = require('../middleware/auth');

// Helper: യൂസർനെയിമും ശരിയായ പേരും മാപ്പ് ചെയ്യാൻ
async function getUserMap() {
  const userSheet = (await getSheet('users')) || (await getSheet('user'));
  const userMap = {};
  if (userSheet) {
    const uRows = await userSheet.getRows();
    uRows.forEach(r => {
      const uname = String(r.get('username') || '').trim().toLowerCase();
      const fullName = String(r.get('name') || r.get('full_name') || '').trim();
      if (uname && fullName) {
        userMap[uname] = fullName;
      }
    });
  }
  return userMap;
}

router.get('/attendance', requireAuth, checkAttendance, async (req, res) => {
  try {
    const batchSheet = await getSheet('batches');
    const subjectSheet = await getSheet('subjects');

    const [bRows, sRows] = await Promise.all([batchSheet.getRows(), subjectSheet.getRows()]);

    let batches = bRows.map(r => ({ id: r.get('id'), name: r.get('name') })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    let subjects = sRows.map(r => ({ id: r.get('id'), name: r.get('name'), batch_id: r.get('batch_id') })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const currentUser = req.session?.user || {};
    if (currentUser.allowed_batch && currentUser.allowed_batch !== 'all') {
      batches = batches.filter(b => String(b.id).trim() === String(currentUser.allowed_batch).trim());
    }
    if (currentUser.allowed_subject && currentUser.allowed_subject !== 'all') {
      subjects = subjects.filter(s => String(s.id).trim() === String(currentUser.allowed_subject).trim());
    }

    res.render('attanten', { batches, subjects, user: currentUser });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

router.get('/api/attendance-data', requireAuth, checkAttendance, async (req, res) => {
  const { batch_id, subject_id, date } = req.query;
  if (!batch_id || !subject_id || !date) return res.status(400).json({ success: false, error: 'Missing required parameters!' });

  try {
    const studentSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');
    const attSheet = await getSheet('attendance');

    const [sRows, bRows, attRows, userMap] = await Promise.all([
      studentSheet.getRows(),
      batchSheet.getRows(),
      attSheet.getRows(),
      getUserMap()
    ]);

    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    let students = sRows
      .filter(r => (r.get('status') || '').trim().toLowerCase() === 'active' && (r.get('full_name') || '').trim() !== '')
      .map(r => {
        const admNo = String(r.get('admission_no') || '').trim();
        const rawBatchIds = String(r.get('batch_id') || '').split(',').map(id => id.trim()).filter(Boolean);
        const mainBatchId = rawBatchIds[0];

        return {
          admission_no: admNo,
          roll_no: r.get('roll_no') || admNo,
          full_name: r.get('full_name'),
          batch_id: r.get('batch_id'),
          batch_name: batchMap[mainBatchId] || 'N/A'
        };
      });

    if (batch_id !== 'all') {
      students = students.filter(s => {
        const studentBatches = String(s.batch_id || '').split(',').map(id => id.trim());
        return studentBatches.includes(String(batch_id).trim());
      });
    }

    students.sort((a, b) => {
      const admA = parseInt(String(a.roll_no || a.admission_no).replace(/\D/g, '')) || 0;
      const admB = parseInt(String(b.roll_no || b.admission_no).replace(/\D/g, '')) || 0;
      return admA - admB;
    });

    const statusMap = {};
    let savedBy = '';

    attRows.forEach(r => {
      const matchDate = String(r.get('date') || '').trim() === String(date).trim();
      const matchBatch = batch_id === 'all' || String(r.get('batch_id') || '').trim() === String(batch_id).trim();
      const matchSub = subject_id === 'all' || String(r.get('subject_id') || '').trim() === String(subject_id).trim();

      if (matchDate && matchBatch && matchSub) {
        const admKey = String(r.get('admission_no') || r.get('student_id') || '').trim();
        statusMap[admKey] = r.get('status');
        if (r.get('user')) {
          const rawUser = String(r.get('user')).trim();
          savedBy = userMap[rawUser.toLowerCase()] || rawUser;
        }
      }
    });

    res.json({ success: true, students, statusMap, savedBy });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/save-attendance', requireAuth, checkAttendance, async (req, res) => {
  const { subject_id, date, records, user_name } = req.body;
  const sessionUser = req.session?.user || {};
  const loggedInUser = sessionUser.username || user_name || 'Admin';

  if (!subject_id || !date || !records || records.length === 0) {
    return res.status(400).json({ success: false, error: 'Incomplete attendance data!' });
  }

  if (sessionUser.allowed_subject && sessionUser.allowed_subject !== 'all') {
    if (String(subject_id).trim() !== String(sessionUser.allowed_subject).trim()) {
      return res.status(403).json({ success: false, error: 'Permission Denied: You are not authorized for this subject!' });
    }
  }

  if (sessionUser.allowed_batch && sessionUser.allowed_batch !== 'all') {
    const unauthorizedBatch = records.some(r => String(r.batch_id).trim() !== String(sessionUser.allowed_batch).trim());
    if (unauthorizedBatch) {
      return res.status(403).json({ success: false, error: 'Permission Denied: You are not authorized for this batch!' });
    }
  }

  try {
    const attSheet = await getSheet('attendance');
    await attSheet.loadHeaderRow();
    const useAdmHeader = attSheet.headerValues.includes('admission_no');
    const existingRows = await attSheet.getRows();

    const rowMap = new Map();
    existingRows.forEach(row => {
      const admNo = String(row.get('admission_no') || row.get('student_id') || '').trim();
      const rDate = String(row.get('date') || '').trim();
      const subId = String(row.get('subject_id') || '').trim();
      const bId = String(row.get('batch_id') || '').trim();
      if (admNo && rDate && subId) rowMap.set(`${admNo}_${rDate}_${subId}_${bId}`, row);
    });

    const alreadyMarked = records.some(r => {
      const admVal = String(r.admission_no || r.student_id || '').trim();
      const searchKey = `${admVal}_${String(date).trim()}_${String(subject_id).trim()}_${String(r.batch_id || '').trim()}`;
      return rowMap.has(searchKey);
    });

    if (alreadyMarked && sessionUser.can_update != 1) {
      return res.status(403).json({
        success: false,
        error: 'Attendance for this session has already been recorded. You do not have update permission.'
      });
    }

    const rowsToAdd = [];
    const rowsToUpdate = [];
    const cleanDate = String(date).trim();
    const cleanSubId = String(subject_id).trim();
    const timestamp = Date.now();

    records.forEach((r, index) => {
      const cleanStudentAdm = String(r.admission_no || r.student_id || '').trim();
      const cleanBatchId = String(r.batch_id || '').trim();
      const searchKey = `${cleanStudentAdm}_${cleanDate}_${cleanSubId}_${cleanBatchId}`;
      const matchedRow = rowMap.get(searchKey);

      if (matchedRow) {
        const currentStatus = String(matchedRow.get('status') || '').trim();
        const currentBatch = String(matchedRow.get('batch_id') || '').trim();

        if (currentStatus !== r.status || currentBatch !== cleanBatchId) {
          matchedRow.set('status', r.status);
          matchedRow.set('batch_id', cleanBatchId);
          matchedRow.set('user', loggedInUser);
          rowsToUpdate.push(matchedRow);
        }
      } else {
        const newRowObj = {
          id: `${timestamp}_${index}`,
          batch_id: cleanBatchId,
          subject_id: cleanSubId,
          date: cleanDate,
          user: loggedInUser,
          status: r.status
        };
        if (useAdmHeader) newRowObj.admission_no = cleanStudentAdm;
        else newRowObj.student_id = cleanStudentAdm;

        rowsToAdd.push(newRowObj);
      }
    });

    if (rowsToAdd.length > 0) await attSheet.addRows(rowsToAdd);
    if (rowsToUpdate.length > 0) {
      const chunkSize = 10;
      for (let i = 0; i < rowsToUpdate.length; i += chunkSize) {
        const chunk = rowsToUpdate.slice(i, i + chunkSize);
        await Promise.all(chunk.map(row => row.save()));
      }
    }

    return res.json({
      success: true,
      message: `Attendance saved successfully! (New: ${rowsToAdd.length}, Updated: ${rowsToUpdate.length})`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to save attendance: ' + err.message });
  }
});

router.get('/monthly-report', requireAuth, checkAttendanceView, async (req, res) => {
  try {
    const [batchSheet, subjectSheet, studentSheet, admSheet, attSheet] = await Promise.all([
      getSheet('batches'),
      getSheet('subjects'),
      getSheet('students'),
      getSheet('admissions'),
      getSheet('attendance')
    ]);

    const [bRows, sRows, stRows, admRows, attRows] = await Promise.all([
      batchSheet.getRows(),
      subjectSheet.getRows(),
      studentSheet ? studentSheet.getRows() : [],
      admSheet ? admSheet.getRows() : [],
      attSheet ? attSheet.getRows() : []
    ]);

    const batches = bRows
      .map(r => ({ id: String(r.get('id') || '').trim(), name: String(r.get('name') || '').trim() }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const subjects = sRows
      .map(r => ({
        id: String(r.get('id') || '').trim(),
        name: String(r.get('name') || '').trim(),
        batch_id: String(r.get('batch_id') || '').trim()
      }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // 1. students & admissions രണ്ട് ടാബിൽ നിന്നും ഓരോ കുട്ടിയുടെയും batch_id ലിസ്റ്റ് എടുക്കുന്നു
    const studentBatchesByAdm = {};
    const collectBatches = (rows) => {
      rows.forEach(r => {
        const adm = String(r.get('admission_no') || r.get('student_id') || '').trim().toLowerCase();
        if (!adm) return;
        const bIds = String(r.get('batch_id') || '').split(',').map(x => x.trim()).filter(Boolean);
        if (!studentBatchesByAdm[adm]) studentBatchesByAdm[adm] = new Set();
        bIds.forEach(id => studentBatchesByAdm[adm].add(id));
      });
    };
    collectBatches(stRows);
    collectBatches(admRows);

    // 2. ഓരോ ബാച്ചിലെയും കുട്ടികൾ ഉൾപ്പെടുന്ന മറ്റു ബാച്ചുകൾ (relatedBatchesMap)
    const relatedBatchesMap = {};
    batches.forEach(b => { relatedBatchesMap[b.id] = new Set([b.id]); });

    Object.values(studentBatchesByAdm).forEach(bSet => {
      const arr = Array.from(bSet);
      arr.forEach(primaryId => {
        if (!relatedBatchesMap[primaryId]) relatedBatchesMap[primaryId] = new Set([primaryId]);
        arr.forEach(otherId => relatedBatchesMap[primaryId].add(otherId));
      });
    });

    // 3. ആ ബാച്ചിലെ കുട്ടികൾക്ക് ഹാജർ രേഖപ്പെടുത്തിയിട്ടുള്ള എല്ലാ subject_id-കളും
    const relatedSubjectsMap = {};
    batches.forEach(b => { relatedSubjectsMap[b.id] = new Set(); });

    attRows.forEach(r => {
      const adm = String(r.get('admission_no') || r.get('student_id') || '').trim().toLowerCase();
      const subId = String(r.get('subject_id') || '').trim();
      if (!adm || !subId) return;

      const stuBatches = studentBatchesByAdm[adm];
      if (stuBatches) {
        stuBatches.forEach(bId => {
          if (!relatedSubjectsMap[bId]) relatedSubjectsMap[bId] = new Set();
          relatedSubjectsMap[bId].add(subId);
        });
      }
    });

    const relatedBatchesObj = {};
    Object.keys(relatedBatchesMap).forEach(k => { relatedBatchesObj[k] = Array.from(relatedBatchesMap[k]); });

    const relatedSubjectsObj = {};
    Object.keys(relatedSubjectsMap).forEach(k => { relatedSubjectsObj[k] = Array.from(relatedSubjectsMap[k]); });

    res.render('attveiw', {
      batches,
      subjects,
      relatedBatchesMap: relatedBatchesObj,
      relatedSubjectsMap: relatedSubjectsObj
    });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

router.get('/api/monthly-matrix', requireAuth, checkAttendanceView, async (req, res) => {
  const { batch_id, subject_id, month, year } = req.query;
  if (!batch_id || !month || !year) return res.status(400).json({ success: false, error: 'Missing filter parameters!' });

  try {
    const daysInMonth = new Date(year, month, 0).getDate();

    const studentSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');
    const attSheet = await getSheet('attendance');

    const [sRows, bRows, attRows, userMap] = await Promise.all([
      studentSheet.getRows(),
      batchSheet.getRows(),
      attSheet.getRows(),
      getUserMap()
    ]);

    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    let students = sRows
      .filter(r => (r.get('status') || '').trim().toLowerCase() === 'active' && (r.get('full_name') || '').trim() !== '')
      .map(r => {
        const admNo = String(r.get('admission_no') || '').trim();
        const rawBatchIds = String(r.get('batch_id') || '').split(',').map(id => id.trim()).filter(Boolean);
        const mainBatchId = rawBatchIds[0];

        return {
          admission_no: admNo,
          roll_no: r.get('roll_no') || admNo,
          full_name: r.get('full_name'),
          batch_id: r.get('batch_id'),
          batch_name: batchMap[mainBatchId] || 'N/A'
        };
      });

    if (batch_id !== 'all') {
      students = students.filter(s => {
        const studentBatches = String(s.batch_id || '').split(',').map(id => id.trim());
        return studentBatches.includes(String(batch_id).trim());
      });
    }

    students.sort((a, b) => {
      const admA = parseInt(String(a.roll_no || a.admission_no).replace(/\D/g, '')) || 0;
      const admB = parseInt(String(b.roll_no || b.admission_no).replace(/\D/g, '')) || 0;
      return admA - admB;
    });

    const attMap = {};
    const teachersSet = new Set();

    attRows.forEach(r => {
      const rDateStr = String(r.get('date') || '').trim();
      if (!rDateStr) return;

      const [rYear, rMonth, rDay] = rDateStr.split('-').map(Number);
      const matchMonth = rMonth === parseInt(month);
      const matchYear = rYear === parseInt(year);
      const matchBatch = batch_id === 'all' || String(r.get('batch_id')).trim() === String(batch_id).trim();
      const matchSub = !subject_id || subject_id === 'all' || String(r.get('subject_id')).trim() === String(subject_id).trim();

      if (matchMonth && matchYear && matchBatch && matchSub) {
        const studentAdm = String(r.get('admission_no') || r.get('student_id') || '').trim();
        const st = String(r.get('status') || '').trim().toLowerCase();
        const markedByRaw = String(r.get('user') || '').trim();

        if (markedByRaw) {
          const teacherName = userMap[markedByRaw.toLowerCase()] || markedByRaw;
          teachersSet.add(teacherName);
        }

        if (!attMap[studentAdm]) attMap[studentAdm] = {};
        if (!attMap[studentAdm][rDay] || st === 'present') attMap[studentAdm][rDay] = st;
      }
    });

    res.json({
      success: true,
      students,
      attMap,
      daysInMonth,
      markedTeachers: Array.from(teachersSet).join(', ') || '-'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/api/student-day-details', requireAuth, checkAttendanceView, async (req, res) => {
  const { admission_no, date } = req.query;
  if (!admission_no || !date) return res.status(400).json({ success: false, error: 'Admission Number and Date are required!' });

  try {
    const studentSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');
    const subjectSheet = await getSheet('subjects');
    const attSheet = await getSheet('attendance');

    const [sRows, bRows, subRows, attRows, userMap] = await Promise.all([
      studentSheet.getRows(),
      batchSheet.getRows(),
      subjectSheet.getRows(),
      attSheet.getRows(),
      getUserMap()
    ]);

    const batchMap = {};
    bRows.forEach(r => { batchMap[r.get('id')] = r.get('name'); });

    const subjectMap = {};
    subRows.forEach(r => { subjectMap[r.get('id')] = r.get('name'); });

    const targetAdmNo = String(admission_no).trim();
    const studentRow = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (!studentRow) return res.status(404).json({ success: false, error: 'Student not found!' });

    const rawBatchIds = String(studentRow.get('batch_id') || '').split(',').map(id => id.trim()).filter(Boolean);
    const batchNames = rawBatchIds.map(id => batchMap[id]).filter(Boolean).join(', ');

    const student = {
      admission_no: targetAdmNo,
      full_name: studentRow.get('full_name'),
      batch_name: batchNames || 'N/A'
    };

    const sessions = attRows
      .filter(r => String(r.get('admission_no') || r.get('student_id')).trim() === targetAdmNo && String(r.get('date')).trim() === String(date).trim())
      .map(r => {
        const rawUser = String(r.get('user') || '').trim();
        return {
          subject_name: subjectMap[r.get('subject_id')] || 'General',
          user: rawUser ? (userMap[rawUser.toLowerCase()] || rawUser) : '-',
          status: r.get('status'),
          created_at: r.get('date')
        };
      });

    res.json({ success: true, student, sessions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;