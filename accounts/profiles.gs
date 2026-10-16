/**
 * Estimation website accounts: keeps each user's profile as one row of the
 * "Users" sheet in this spreadsheet (in the owner's Google Drive).
 *
 * The website sends the user's Firebase ID token with every request. The
 * script checks it with Google before reading or writing, so only signed-in
 * users can add rows, and each user only their own row. Passwords are never
 * sent here; Firebase Authentication keeps them.
 *
 * Set FIREBASE_API_KEY below to the Firebase web config's apiKey, then
 * Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 */
const FIREBASE_API_KEY = 'PASTE_YOUR_FIREBASE_API_KEY';
const SHEET = 'Users';
const HEADERS = ['User ID', 'First name', 'Last name', 'Organization', 'Department', 'Mobile', 'Email', 'Signed up', 'Updated'];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const user = verify_(body.idToken);
    if (body.action === 'save') return reply_(save_(user, body.profile || {}));
    if (body.action === 'get') return reply_({ ok: true, profile: find_(user.uid) });
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

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
