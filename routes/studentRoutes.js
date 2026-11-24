const express = require('express');
const router = express.Router();
const { getSheet, syncAndReorderRolls } = require('../config/sheets');
const { requireAuth, checkStudent, hashPassword } = require('../middleware/auth');

function parseRollExpressionServer(expr) {
  const clean = String(expr || '').trim();
  if (!clean || clean.length > 300) return { error: 'Invalid or overly long roll number input!' };
  if (!/^[0-9,\-\s]+$/.test(clean)) return { error: 'Invalid characters! Use only numbers, commas (,), and hyphens (-).' };

  const rollSet = new Set();
  const parts = clean.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return { error: 'Please provide at least one roll number!' };

  for (const part of parts) {
    if (part.includes('-')) {
      const bounds = part.split('-').map(b => b.trim());
      if (bounds.length !== 2 || !bounds[0] || !bounds[1]) return { error: `Invalid range syntax "${part}".` };
      const start = parseInt(bounds[0], 10);
      const end = parseInt(bounds[1], 10);
      if (isNaN(start) || isNaN(end) || start < 1 || end < start || end > 100000) return { error: `Invalid roll range "${part}".` };
      if (end - start > 500) return { error: 'Range cannot exceed 500 roll numbers per request!' };
      for (let n = start; n <= end; n++) rollSet.add(n);
    } else {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 1 || num > 100000) return { error: `Invalid roll number "${part}".` };
      rollSet.add(num);
    }
  }

  if (rollSet.size === 0 || rollSet.size > 500) return { error: 'Please specify between 1 and 500 valid roll numbers!' };
  return { rollSet };
}

router.get('/students', requireAuth, checkStudent, async (req, res) => {
  try {
    const studentSheet = await getSheet('students');
    const batchSheet = await getSheet('batches');

    const [sRows, bRows] = await Promise.all([studentSheet.getRows(), batchSheet.getRows()]);

    const batchMap = {};
    const batches = bRows.map(r => {
      batchMap[r.get('id')] = r.get('name');
      return { id: r.get('id'), name: r.get('name') };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const students = sRows
      .filter(r => (r.get('status') || '').trim().toLowerCase() === 'active' && (r.get('full_name') || '').trim() !== '')
      .map(r => {
        const rawBatchIds = String(r.get('batch_id') || '').split(',').map(id => id.trim()).filter(Boolean);
        const batchNamesList = rawBatchIds.map(id => batchMap[id]).filter(Boolean);
        const mainBatchName = batchNamesList[0] || 'N/A';
        const admNo = String(r.get('admission_no') || '').trim();

        return {
          admission_no: admNo,
          roll_no: r.get('roll_no') || '',
          full_name: r.get('full_name'),
          dob: r.get('dob') || r.get('age') || '',
          phone: r.get('phone') || '',
          batch_id: r.get('batch_id') || '',
          main_batch_name: mainBatchName,
          batch_name: batchNamesList.join(', ') || 'N/A',
          status: r.get('status')
        };
      })
      .sort((a, b) => {
        const rollA = parseInt(String(a.roll_no || a.admission_no).replace(/\D/g, '')) || 0;
        const rollB = parseInt(String(b.roll_no || b.admission_no).replace(/\D/g, '')) || 0;
        return rollA - rollB;
      });

    res.render('studet', { students, batches });
  } catch (err) {
    res.status(500).send("Database Error: " + err.message);
  }
});

router.post('/api/students/bulk-assign-batch', requireAuth, checkStudent, async (req, res) => {
  try {
    const { batch_id, roll_expression, from_roll, to_roll } = req.body;
    const targetBatch = String(batch_id || '').trim();
    const sessionUser = req.session?.user || {};

    if (!targetBatch) return res.status(400).json({ success: false, error: 'Please select a valid batch!' });

    if (sessionUser.allowed_batch && sessionUser.allowed_batch !== 'all') {
      if (targetBatch !== String(sessionUser.allowed_batch).trim()) {
        return res.status(403).json({ success: false, error: 'Permission Denied: You are not authorized to assign this batch!' });
      }
    }

    const rawExpr = roll_expression !== undefined
      ? roll_expression
      : (from_roll && to_roll ? `${from_roll}-${to_roll}` : '');

    const parsed = parseRollExpressionServer(rawExpr);
    if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
    const targetRollSet = parsed.rollSet;

    const batchSheet = await getSheet('batches');
    const bRows = await batchSheet.getRows();
    const validBatch = bRows.find(r => String(r.get('id') || '').trim() === targetBatch);
    if (!validBatch) return res.status(400).json({ success: false, error: 'Selected batch does not exist!' });

    const stuSheet = await getSheet('students');
    const admSheet = await getSheet('admissions');

    async function updateBatchInSheet(sheet, onlyActive = false) {
      if (!sheet) return 0;
      await sheet.loadHeaderRow();
      const rollIdx = sheet.headerValues.indexOf('roll_no');
      const batchIdx = sheet.headerValues.indexOf('batch_id');
      const statusIdx = sheet.headerValues.indexOf('status');
      if (rollIdx === -1 || batchIdx === -1 || sheet.rowCount < 2) return 0;

      const cols = [rollIdx, batchIdx];
      if (statusIdx !== -1) cols.push(statusIdx);

      await sheet.loadCells({
        startRowIndex: 1,
        endRowIndex: sheet.rowCount,
        startColumnIndex: Math.min(...cols),
        endColumnIndex: Math.max(...cols) + 1
      });

      let updatedCount = 0;
      for (let r = 1; r < sheet.rowCount; r++) {
        if (onlyActive && statusIdx !== -1) {
          const st = String(sheet.getCell(r, statusIdx).value || '').trim().toLowerCase();
          if (st !== 'active') continue;
        }

        const rollVal = parseInt(String(sheet.getCell(r, rollIdx).value || '').trim(), 10);
        if (!isNaN(rollVal) && targetRollSet.has(rollVal)) {
          const batchCell = sheet.getCell(r, batchIdx);
          const existingBatches = String(batchCell.value || '')
            .split(',')
            .map(b => b.trim())
            .filter(Boolean);

          if (!existingBatches.includes(targetBatch)) {
            existingBatches.push(targetBatch);
            batchCell.value = existingBatches.join(',');
            updatedCount++;
          }
        }
      }

      if (updatedCount > 0) await sheet.saveUpdatedCells();
      return updatedCount;
    }

    const [stuUpdated] = await Promise.all([
      updateBatchInSheet(stuSheet, true),
      updateBatchInSheet(admSheet, false)
    ]);

    res.json({
      success: true,
      message: `Batch "${validBatch.get('name')}" assigned successfully to ${stuUpdated} student(s)!`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to assign batch: ' + err.message });
  }
});

router.put('/api/students/:admNo/password', requireAuth, checkStudent, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, error: 'Password is required!' });

    const stuSheet = await getSheet('students');
    const admSheet = await getSheet('admissions');
    await stuSheet.loadHeaderRow();
    if (!stuSheet.headerValues.includes('password')) {
      return res.status(400).json({ success: false, error: 'Column "password" is missing in the "students" sheet!' });
    }

    const [sRows, aRows] = await Promise.all([stuSheet.getRows(), admSheet.getRows()]);
    const stuRow = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (!stuRow) return res.status(404).json({ success: false, error: 'Student not found!' });

    const hashedPassword = await hashPassword(password);
    stuRow.set('password', hashedPassword);
    await stuRow.save();

    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (admRow) {
      admRow.set('password', hashedPassword);
      await admRow.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/api/students/:admNo', requireAuth, checkStudent, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const { full_name, dob, phone, batch_id, roll_no, password } = req.body;

    const stuSheet = await getSheet('students');
    const admSheet = await getSheet('admissions');
    const [sRows, aRows] = await Promise.all([stuSheet.getRows(), admSheet.getRows()]);

    const hashedPassword = (password && password.trim() !== '') ? await hashPassword(password) : null;
    const cleanRoll = roll_no ? String(roll_no).trim() : '';

    const row = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (row) {
      row.set('full_name', full_name ? full_name.trim() : '');
      row.set('roll_no', cleanRoll);
      if (dob !== undefined) row.set('dob', String(dob).trim());
      row.set('phone', phone ? String(phone).trim() : '');
      row.set('batch_id', batch_id ? String(batch_id) : '');
      if (hashedPassword) row.set('password', hashedPassword);
      await row.save();
    }

    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (admRow) {
      admRow.set('full_name', full_name ? full_name.trim() : '');
      admRow.set('roll_no', cleanRoll);
      if (dob !== undefined) admRow.set('dob', String(dob).trim());
      admRow.set('phone', phone ? String(phone).trim() : '');
      admRow.set('batch_id', batch_id ? String(batch_id) : '');
      if (hashedPassword) admRow.set('password', hashedPassword);
      await admRow.save();
    }

    if (cleanRoll) {
      await syncAndReorderRolls(targetAdmNo, cleanRoll, stuSheet, admSheet, sRows, aRows);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/api/students/:admNo', requireAuth, checkStudent, async (req, res) => {
  try {
    const targetAdmNo = String(req.params.admNo).trim();
    const stuSheet = await getSheet('students');
    const admSheet = await getSheet('admissions');
    const [sRows, aRows] = await Promise.all([stuSheet.getRows(), admSheet.getRows()]);

    const row = sRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (!row) return res.status(404).json({ success: false, error: 'Student not found!' });
    await row.delete();

    const admRow = aRows.find(r => String(r.get('admission_no')).trim() === targetAdmNo);
    if (admRow) {
      admRow.set('status', 'pending');
      await admRow.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;