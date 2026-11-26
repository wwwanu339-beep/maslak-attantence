const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);

let isDocLoaded = false;
let docLoadPromise = null;

// In-Memory Cache for Sheet Rows (45 Seconds TTL)
const ROW_CACHE = new Map();
const CACHE_TTL_MS = 45 * 1000;

function clearSheetCache(title) {
  if (title) {
    ROW_CACHE.delete(String(title).trim().toLowerCase());
  } else {
    ROW_CACHE.clear();
  }
}

async function ensureDocLoaded() {
  if (isDocLoaded) return;
  if (!docLoadPromise) {
    docLoadPromise = doc.loadInfo()
      .then(() => {
        isDocLoaded = true;
      })
      .catch((err) => {
        docLoadPromise = null;
        throw err;
      });
  }
  await docLoadPromise;
}

// Wrap each row so save() or delete() automatically clears cache
function wrapRow(row, cacheKey) {
  if (row.__cacheWrapped) return row;
  row.__cacheWrapped = true;

  const origSave = row.save.bind(row);
  row.save = async (...args) => {
    const res = await origSave(...args);
    ROW_CACHE.delete(cacheKey);
    return res;
  };

  const origDelete = row.delete.bind(row);
  row.delete = async (...args) => {
    const res = await origDelete(...args);
    ROW_CACHE.delete(cacheKey);
    return res;
  };

  return row;
}

async function getSheet(title) {
  await ensureDocLoaded();
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) return null;

  const cacheKey = String(title).trim().toLowerCase();

  if (!sheet.__smartCached) {
    sheet.__smartCached = true;

    const origGetRows = sheet.getRows.bind(sheet);
    const origAddRow = sheet.addRow.bind(sheet);
    const origAddRows = sheet.addRows.bind(sheet);
    const origSaveUpdatedCells = sheet.saveUpdatedCells.bind(sheet);

    // 1. Cached getRows() with concurrent request deduplication
    sheet.getRows = async (options) => {
      if (options) {
        const fresh = await origGetRows(options);
        return fresh.map(r => wrapRow(r, cacheKey));
      }

      const now = Date.now();
      const cached = ROW_CACHE.get(cacheKey);

      if (cached && cached.rows && (now - cached.time < CACHE_TTL_MS)) {
        return cached.rows;
      }

      // If 200 users request simultaneously while fetching, share the same single API call!
      if (cached && cached.promise) {
        return cached.promise;
      }

      const fetchPromise = origGetRows()
        .then(rows => {
          const wrapped = rows.map(r => wrapRow(r, cacheKey));
          ROW_CACHE.set(cacheKey, { rows: wrapped, time: Date.now(), promise: null });
          return wrapped;
        })
        .catch(err => {
          ROW_CACHE.delete(cacheKey);
          throw err;
        });

      ROW_CACHE.set(cacheKey, { rows: cached?.rows || null, time: cached?.time || 0, promise: fetchPromise });
      return fetchPromise;
    };

    // 2. Auto-invalidate cache on writes
    sheet.addRow = async (...args) => {
      const res = await origAddRow(...args);
      ROW_CACHE.delete(cacheKey);
      return res;
    };

    sheet.addRows = async (...args) => {
      const res = await origAddRows(...args);
      ROW_CACHE.delete(cacheKey);
      return res;
    };

    sheet.saveUpdatedCells = async (...args) => {
      const res = await origSaveUpdatedCells(...args);
      ROW_CACHE.delete(cacheKey);
      return res;
    };
  }

  return sheet;
}

function generateNextAdmissionNo(aRows = [], sRows = []) {
  let maxNum = 1000;
  let prefix = 'ADM';

  const scan = (rows) => {
    rows.forEach(r => {
      const val = String(r.get('admission_no') || '').trim();
      const match = val.match(/^([A-Za-z\-_]*)(\d+)$/);
      if (match) {
        if (match[1]) prefix = match[1];
        const num = parseInt(match[2], 10);
        if (!isNaN(num) && num > maxNum) maxNum = num;
      }
    });
  };

  scan(aRows);
  scan(sRows);
  return `${prefix}${maxNum + 1}`;
}

async function syncAndReorderRolls(targetAdmNo, newRollStr, stuSheet, admSheet, sRows, aRows) {
  const newRoll = parseInt(newRollStr, 10);
  if (isNaN(newRoll) || newRoll < 1) return;

  const activeStu = sRows
    .filter(r => (r.get('status') || '').trim().toLowerCase() === 'active' && String(r.get('admission_no') || '').trim() !== targetAdmNo)
    .map(r => ({
      adm: String(r.get('admission_no') || '').trim(),
      roll: parseInt(String(r.get('roll_no') || '').trim(), 10) || 999999
    }))
    .sort((a, b) => a.roll - b.roll);

  const orderedAdms = [];
  let inserted = false;

  for (const item of activeStu) {
    if (!inserted && item.roll >= newRoll) {
      orderedAdms.push(targetAdmNo);
      inserted = true;
    }
    orderedAdms.push(item.adm);
  }
  if (!inserted) orderedAdms.push(targetAdmNo);

  const newRollMap = {};
  orderedAdms.forEach((adm, idx) => {
    newRollMap[adm] = String(idx + 1);
  });

  async function batchUpdateRollColumn(sheet) {
    if (!sheet) return;
    await sheet.loadHeaderRow();
    const admIdx = sheet.headerValues.indexOf('admission_no');
    const rollIdx = sheet.headerValues.indexOf('roll_no');
    if (admIdx === -1 || rollIdx === -1 || sheet.rowCount < 2) return;

    await sheet.loadCells({
      startRowIndex: 1,
      endRowIndex: sheet.rowCount,
      startColumnIndex: Math.min(admIdx, rollIdx),
      endColumnIndex: Math.max(admIdx, rollIdx) + 1
    });

    let changed = false;
    for (let r = 1; r < sheet.rowCount; r++) {
      const admVal = String(sheet.getCell(r, admIdx).value || '').trim();
      if (newRollMap[admVal]) {
        const cell = sheet.getCell(r, rollIdx);
        if (String(cell.value || '').trim() !== newRollMap[admVal]) {
          cell.value = newRollMap[admVal];
          changed = true;
        }
      }
    }
    if (changed) await sheet.saveUpdatedCells();
  }

  await Promise.all([
    batchUpdateRollColumn(stuSheet),
    batchUpdateRollColumn(admSheet)
  ]);
}

module.exports = {
  getSheet,
  clearSheetCache,
  generateNextAdmissionNo,
  syncAndReorderRolls
};