const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

function formatPrivateKey(key) {
  if (!key) return '';
  return key
    .replace(/^["']|["']$/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .trim();
}

let serviceAccountAuth;
if (process.env.GOOGLE_CREDENTIALS_BASE64) {
  const creds = JSON.parse(
    Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf8')
  );
  serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
} else {
  serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: formatPrivateKey(process.env.GOOGLE_PRIVATE_KEY),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);

async function getSheet(sheetTitle) {
  await doc.loadInfo();
  if (doc.sheetsByTitle[sheetTitle]) return doc.sheetsByTitle[sheetTitle];
  const target = String(sheetTitle || '').trim().toLowerCase();
  const matchedKey = Object.keys(doc.sheetsByTitle).find(k => k.trim().toLowerCase() === target);
  return matchedKey ? doc.sheetsByTitle[matchedKey] : null;
}

function generateNextAdmissionNo(admRows, stuRows = []) {
  for (let i = admRows.length - 1; i >= 0; i--) {
    const adm = String(admRows[i].get('admission_no') || '').trim();
    const num = parseInt(adm.replace(/\D/g, ''), 10);
    if (!isNaN(num)) return `ADM${num + 1}`;
  }
  for (let i = stuRows.length - 1; i >= 0; i--) {
    const adm = String(stuRows[i].get('admission_no') || '').trim();
    const num = parseInt(adm.replace(/\D/g, ''), 10);
    if (!isNaN(num)) return `ADM${num + 1}`;
  }
  return 'ADM1001';
}

async function syncAndReorderRolls(targetAdmNo, desiredRollStr, stuSheet, admSheet, sRows, aRows) {
  const newRoll = parseInt(desiredRollStr, 10);
  if (isNaN(newRoll) || newRoll < 1) return;

  const items = [];
  const processedAdms = new Set();

  [...sRows, ...aRows].forEach(r => {
    const adm = String(r.get('admission_no') || '').trim();
    if (!adm || adm === targetAdmNo || processedAdms.has(adm)) return;
    processedAdms.add(adm);

    const rNum = parseInt(String(r.get('roll_no') || '').trim(), 10);
    if (!isNaN(rNum) && rNum > 0) {
      items.push({ adm, roll: rNum });
    }
  });

  items.sort((a, b) => a.roll - b.roll);

  const targetIndex = Math.min(Math.max(0, newRoll - 1), items.length);
  items.splice(targetIndex, 0, { adm: targetAdmNo, roll: newRoll });

  const finalRollMap = new Map();
  items.forEach((item, idx) => {
    finalRollMap.set(item.adm, String(idx + 1));
  });

  async function batchUpdateRollColumn(sheet) {
    if (!sheet) return;
    await sheet.loadHeaderRow();
    const admColIdx = sheet.headerValues.indexOf('admission_no');
    const rollColIdx = sheet.headerValues.indexOf('roll_no');
    if (admColIdx === -1 || rollColIdx === -1 || sheet.rowCount < 2) return;

    await sheet.loadCells({
      startRowIndex: 1,
      endRowIndex: sheet.rowCount,
      startColumnIndex: Math.min(admColIdx, rollColIdx),
      endColumnIndex: Math.max(admColIdx, rollColIdx) + 1
    });

    let hasChanges = false;
    for (let r = 1; r < sheet.rowCount; r++) {
      const admCell = sheet.getCell(r, admColIdx);
      const admVal = String(admCell.value || '').trim();
      if (admVal && finalRollMap.has(admVal)) {
        const newRollVal = finalRollMap.get(admVal);
        const rollCell = sheet.getCell(r, rollColIdx);
        if (String(rollCell.value || '').trim() !== newRollVal) {
          rollCell.value = newRollVal;
          hasChanges = true;
        }
      }
    }

    if (hasChanges) await sheet.saveUpdatedCells();
  }

  await Promise.all([
    batchUpdateRollColumn(stuSheet),
    batchUpdateRollColumn(admSheet)
  ]);
}

module.exports = {
  getSheet,
  generateNextAdmissionNo,
  syncAndReorderRolls
};