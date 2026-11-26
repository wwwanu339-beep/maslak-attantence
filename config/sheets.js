const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);

let isDocLoaded = false;
let docLoadPromise = null;

// 2 മിനിറ്റ് (120 സെക്കൻഡ്) നേരത്തേക്ക് ഡാറ്റ മെമ്മറിയിൽ സൂക്ഷിക്കും
const ROW_CACHE = new Map();
const CACHE_TTL_MS = 120 * 1000;

function clearSheetCache(title) {
  if (title) {
    ROW_CACHE.delete(String(title).trim().toLowerCase());
  } else {
    ROW_CACHE.clear();
  }
}

// 429 API Limit എറർ വന്നാൽ 2.5 സെക്കൻഡ് കാത്തിരുന്ന് തനിയെ വീണ്ടും ശ്രമിക്കുന്ന Helper
async function withRetry(fn, retries = 3, delayMs = 2500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit =
        err?.response?.status === 429 ||
        err?.code === 429 ||
        String(err?.message || '').includes('429') ||
        String(err?.message || '').toLowerCase().includes('quota');

      if (isRateLimit && i < retries - 1) {
        await new Promise(res => setTimeout(res, delayMs * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function ensureDocLoaded() {
  if (isDocLoaded) return;
  if (!docLoadPromise) {
    docLoadPromise = withRetry(() => doc.loadInfo())
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

function wrapRow(row, cacheKey) {
  if (row.__cacheWrapped) return row;
  row.__cacheWrapped = true;

  const origSave = row.save.bind(row);
  row.save = async (...args) => {
    const res = await withRetry(() => origSave(...args));
    ROW_CACHE.delete(cacheKey);
    return res;
  };

  const origDelete = row.delete.bind(row);
  row.delete = async (...args) => {
    const res = await withRetry(() => origDelete(...args));
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

    sheet.getRows = async (options) => {
      if (options) {
        const fresh = await withRetry(() => origGetRows(options));
        return fresh.map(r => wrapRow(r, cacheKey));
      }

      const now = Date.now();
      const cached = ROW_CACHE.get(cacheKey);

      if (cached && cached.rows && (now - cached.time < CACHE_TTL_MS)) {
        return cached.rows;
      }

      if (cached && cached.promise) {
        return cached.promise;
      }

      const fetchPromise = withRetry(() => origGetRows())
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

    sheet.addRow = async (...args) => {
      const res = await withRetry(() => origAddRow(...args));
      ROW_CACHE.delete(cacheKey);
      return res;
    };

    sheet.addRows = async (...args) => {
      const res = await withRetry(() => origAddRows(...args));
      ROW_CACHE.delete(cacheKey);
      return res;
    };

    sheet.saveUpdatedCells = async (...args) => {
      const res = await withRetry(() => origSaveUpdatedCells(...args));
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
    await withRetry(() => sheet.loadHeaderRow());
    const admIdx = sheet.headerValues.indexOf('admission_no');
    const rollIdx = sheet.headerValues.indexOf('roll_no');
    if (admIdx === -1 || rollIdx === -1 || sheet.rowCount < 2) return;

    await withRetry(() => sheet.loadCells({
      startRowIndex: 1,
      endRowIndex: sheet.rowCount,
      startColumnIndex: Math.min(admIdx, rollIdx),
      endColumnIndex: Math.max(admIdx, rollIdx) + 1
    }));

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