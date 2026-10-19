/**
 * Estimation website accounts: keeps each user's profile as one row of the
 * "Users" sheet in this spreadsheet (in the owner's Google Drive), and the
 * details of each user's projects (name, client/site, pricing mode, margin
 * and discount) as rows of the "Projects" sheet. Drawings, extracted items
 * and Excel files are never sent here.
 *
 * The website sends the user's Firebase ID token with every request. The
 * script checks it with Google before reading or writing, so only signed-in
 * users can add rows, and each user only their own row. Passwords are never
 * sent here; Firebase Authentication keeps them.
 *
 * The "Rate database" sheet holds the owner's own price database (rates
 * from their earlier BOQs and offers). Only the account that first saved it,
 * and the emails listed in the "Rate database access" sheet, can read it;
 * the uploaded workbook is also kept in the Drive folder "Estimation price
 * database".
 *
 * Set FIREBASE_API_KEY below to the Firebase web config's apiKey, then
 * Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 */
const FIREBASE_API_KEY = 'AIzaSyDn181WEUUq6Dw9F0-2OgXzm0vbe6cfLkI';
const SHEET = 'Users';
const HEADERS = ['User ID', 'First name', 'Last name', 'Organization', 'Department', 'Mobile', 'Email', 'Signed up', 'Updated'];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const user = verify_(body.idToken);
    if (body.action === 'save') return reply_(save_(user, body.profile || {}));
    if (body.action === 'get') return reply_({ ok: true, profile: find_(user.uid) });
    if (body.action === 'listProjects') return reply_({ ok: true, projects: listProjects_(user.uid) });
    if (body.action === 'saveProject') return reply_(saveProject_(user, body.project || {}));
    if (body.action === 'deleteProject') return reply_(deleteProject_(user, String(body.id || '')));
    if (body.action === 'getRates') return reply_(getRates_(user));
    if (body.action === 'saveRates') return reply_(saveRates_(user, body));
    return reply_({ ok: false, error: 'Unknown request.' });
  } catch (err) {
    return reply_({ ok: false, error: String(err.message || err) });
  }
}

function doGet() {
  return reply_({ ok: true, service: 'Estimation accounts' });
}

/** The caller's Firebase account, checked with Google: {uid, email}. */
function verify_(idToken) {
  if (!idToken) throw new Error('Not signed in.');
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText() || '{}');
  const u = data.users && data.users[0];
  if (res.getResponseCode() !== 200 || !u || !u.localId) throw new Error('Your sign-in has expired. Log in again.');
  return { uid: u.localId, email: u.email || '' };
}

function sheet_() {
  const book = SpreadsheetApp.getActive();
  let s = book.getSheetByName(SHEET);
  if (!s) {
    s = book.insertSheet(SHEET);
    s.appendRow(HEADERS);
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return s;
}

function clean_(v, max) {
  // A leading = + - @ would make the cell a formula.
  return String(v == null ? '' : v).trim().replace(/^[=+\-@]+/, '').slice(0, max);
}

function save_(user, p) {
  const row = {
    firstName: clean_(p.firstName, 80),
    lastName: clean_(p.lastName, 80),
    organization: clean_(p.organization, 120),
    department: clean_(p.department, 120),
    mobile: String(p.mobile == null ? '' : p.mobile).trim(),
  };
  if (!row.firstName || !row.lastName || !row.organization || !row.department) {
    return { ok: false, error: 'Fill in every field.' };
  }
  if (!/^\+?[0-9 ]{7,20}$/.test(row.mobile)) return { ok: false, error: 'Enter a valid mobile number.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const s = sheet_();
    const now = new Date();
    const at = rowOf_(s, user.uid);
    // The mobile is kept as text so a leading + or 0 stays.
    const values = [user.uid, row.firstName, row.lastName, row.organization, row.department, "'" + row.mobile, user.email];
    if (at) {
      s.getRange(at, 1, 1, values.length).setValues([values]);
      s.getRange(at, 9).setValue(now);
    } else {
      s.appendRow(values.concat([now, now]));
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function rowOf_(s, uid) {
  const n = s.getLastRow();
  if (n < 2) return 0;
  const ids = s.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === uid) return i + 2;
  return 0;
}

function find_(uid) {
  const s = sheet_();
  const at = rowOf_(s, uid);
  if (!at) return null;
  const v = s.getRange(at, 1, 1, 7).getValues()[0];
  return { firstName: v[1], lastName: v[2], organization: v[3], department: v[4], mobile: String(v[5]), email: v[6] };
}

const PROJECTS = 'Projects';
const PROJECT_HEADERS = ['User ID', 'Project ID', 'Project name', 'Client / Site', 'Pricing', 'Margin %', 'Discount %', 'Created', 'Updated'];

function projectSheet_() {
  const book = SpreadsheetApp.getActive();
  let s = book.getSheetByName(PROJECTS);
  if (!s) {
    s = book.insertSheet(PROJECTS);
    s.appendRow(PROJECT_HEADERS);
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, PROJECT_HEADERS.length).setFontWeight('bold');
  }
  return s;
}

function num_(v) {
  const n = Number(v);
  return isFinite(n) && n >= 0 && n <= 1000 ? n : 0;
}

/** The caller's projects, newest first. */
function listProjects_(uid) {
  const s = projectSheet_();
  const n = s.getLastRow();
  if (n < 2) return [];
  const rows = s.getRange(2, 1, n - 1, PROJECT_HEADERS.length).getValues();
  const out = [];
  rows.forEach(function (v) {
    if (v[0] !== uid) return;
    out.push({
      id: String(v[1]), name: String(v[2]), client: String(v[3]), pricing: v[4] === 'Manual' ? 'manual' : 'auto',
      margin: num_(v[5]), discount: num_(v[6]),
      createdAt: v[7] instanceof Date ? v[7].toISOString() : '', updatedAt: v[8] instanceof Date ? v[8].toISOString() : '',
    });
  });
  out.sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; });
  return out;
}

function projectRow_(s, uid, id) {
  const n = s.getLastRow();
  if (n < 2) return 0;
  const ids = s.getRange(2, 1, n - 1, 2).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === uid && String(ids[i][1]) === id) return i + 2;
  return 0;
}

function saveProject_(user, p) {
  const id = clean_(p.id, 40);
  const name = clean_(p.name, 120);
  if (!/^[a-z0-9]{6,40}$/.test(id) || !name) return { ok: false, error: 'The project needs a name.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const s = projectSheet_();
    const now = new Date();
    const values = [user.uid, id, name, clean_(p.client, 160), p.pricing === 'manual' ? 'Manual' : 'Auto', num_(p.margin), num_(p.discount)];
    const at = projectRow_(s, user.uid, id);
    if (at) {
      s.getRange(at, 1, 1, values.length).setValues([values]);
      s.getRange(at, 9).setValue(now);
    } else {
      s.appendRow(values.concat([now, now]));
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function deleteProject_(user, id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const s = projectSheet_();
    const at = projectRow_(s, user.uid, id);
    if (at) s.deleteRow(at);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

const RATES = 'Rate database';
const RATES_ACCESS = 'Rate database access';
const RATE_HEADERS = ['Description', 'Heading above it in the BOQ', 'UOM', 'Supply rate (₹)', 'Service rate (₹)', 'Source sheet', 'Row', 'Single quoted rate'];

/** Whether this account may use the price database. */
function ratesAllowed_(user) {
  const owner = PropertiesService.getScriptProperties().getProperty('RATES_OWNER');
  if (!owner || owner === user.uid) return true;
  const s = SpreadsheetApp.getActive().getSheetByName(RATES_ACCESS);
  if (!s || s.getLastRow() < 2 || !user.email) return false;
  const emails = s.getRange(2, 1, s.getLastRow() - 1, 1).getValues();
  return emails.some(function (v) { return String(v[0]).trim().toLowerCase() === user.email.toLowerCase(); });
}

function getRates_(user) {
  const props = PropertiesService.getScriptProperties();
  const s = SpreadsheetApp.getActive().getSheetByName(RATES);
  if (!s || s.getLastRow() < 2 || !ratesAllowed_(user)) return { ok: true, rates: null };
  const rows = s.getRange(2, 1, s.getLastRow() - 1, RATE_HEADERS.length).getValues();
  return {
    ok: true,
    uplift: Number(props.getProperty('RATES_UPLIFT') || 0),
    updated: props.getProperty('RATES_UPDATED') || '',
    file: props.getProperty('RATES_FILE') || '',
    rates: rows.map(function (v) {
      return { item: String(v[0]), context: String(v[1]), unit: String(v[2]), supply: v[3] === '' ? null : Number(v[3]), service: v[4] === '' ? null : Number(v[4]), sheet: String(v[5]), row: Number(v[6]) || 0, single: v[7] === true || v[7] === 'Yes' };
    }),
  };
}

function text_(v, max) {
  // A leading = + - @ would make the cell a formula; the apostrophe keeps it text.
  const t = String(v == null ? '' : v).trim().slice(0, max);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

function money_(v) {
  const n = Number(v);
  return v != null && v !== '' && isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : '';
}

function saveRates_(user, body) {
  const rates = body.rates;
  if (!Array.isArray(rates) || !rates.length || rates.length > 20000) return { ok: false, error: 'The price database has no rates.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const owner = props.getProperty('RATES_OWNER');
    if (owner && owner !== user.uid) return { ok: false, error: 'Only the account that first saved the price database can replace it.' };
    const book = SpreadsheetApp.getActive();
    let s = book.getSheetByName(RATES);
    if (!s) s = book.insertSheet(RATES);
    s.clear();
    const values = rates.map(function (r) {
      return [text_(r.item, 2000), text_(r.context, 1000), text_(r.unit, 40), money_(r.supply), money_(r.service), text_(r.sheet, 120), Number(r.row) || '', r.single ? 'Yes' : 'No'];
    });
    s.getRange(1, 1, 1, RATE_HEADERS.length).setValues([RATE_HEADERS]).setFontWeight('bold');
    s.getRange(2, 1, values.length, RATE_HEADERS.length).setValues(values);
    s.setFrozenRows(1);
    let a = book.getSheetByName(RATES_ACCESS);
    if (!a) {
      a = book.insertSheet(RATES_ACCESS);
      a.appendRow(['Other emails that may use the price database (one per row). The account that saved it can always use it.']);
      a.getRange(1, 1).setFontWeight('bold');
    }
    let file = '';
    if (body.fileBase64 && body.fileName) {
      const folders = DriveApp.getFoldersByName('Estimation price database');
      const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('Estimation price database');
      const blob = Utilities.newBlob(Utilities.base64Decode(body.fileBase64), MimeType.MICROSOFT_EXCEL, clean_(body.fileName, 120) || 'Rate_Database.xlsx');
      file = folder.createFile(blob).getUrl();
    }
    const updated = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'd MMM yyyy');
    props.setProperties({ RATES_OWNER: owner || user.uid, RATES_UPLIFT: String(Number(body.uplift) || 0), RATES_UPDATED: updated, RATES_FILE: file || props.getProperty('RATES_FILE') || '' });
    return { ok: true, count: values.length, updated: updated, file: file };
  } finally {
    lock.releaseLock();
  }
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
