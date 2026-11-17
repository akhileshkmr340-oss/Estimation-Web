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
 * the developer and the emails listed in the "Rate database access" sheet
 * can read it (the first two can also replace it);
 * the uploaded workbook is also kept in the Drive folder "Estimation price
 * database".
 *
 * "User prices" holds the prices each signed-in user adds on the website
 * ("Add to your prices": typed one by one, or imported from a price file
 * after a confirmation). Each row belongs to one account (User ID) and is
 * used only for that account's pricing. The website never lists them for
 * the user, nor how many there are; only the developer (DEVELOPER_UIDS
 * script property, or the account with this script owner's own email) can
 * count, list, change, delete or export anyone's prices, or import a
 * price file into the main price database (devImportMain). The account that
 * owns the price database is not the developer.
 *
 * Password reset: "Forgot password?" on the website asks this script
 * (resetPassword, no sign-in) to email the reset link from the owner's own
 * Gmail, because Firebase's own sender (noreply@...firebaseapp.com) is
 * filtered by some company mail systems. The link comes from Firebase
 * (Identity Toolkit, as the script owner: needs the cloud-platform scope in
 * appsscript.json). The answer is the same whether or not the account
 * exists; each request is logged in "Password resets" (masked email, never
 * the link).
 *
 * User management: the website's 'users' Cloud Functions call devCheck,
 * devProfiles, devDeleteUserData and devAudit with the developer's own
 * sign-in, so the same developer check applies. Every disable, enable and
 * delete is written to the "User admin log" sheet.
 *
 * Requests for quote: the owner's supplier list is kept in the "Suppliers"
 * sheet. The owner writes each Request for Quote on the website's RFQ tab
 * (From, To, CC, text and the items with no rate) and clicks Send; the
 * script then emails it (GmailApp, from the owner's Gmail or a "Send mail
 * as" address set up in it), one email per To address. Only the account
 * that owns the price database can send. The "RFQ log" sheet records each
 * email sent (date, project, supplier, email, item count). Files attached on
 * the RFQ tab are also saved in Drive ("Estimation RFQ/<project>"). The
 * "RFQ mailbox" sheet keeps a copy of each email sent. The website's RFQ
 * mailbox shows the Gmail folders (Inbox, Sent, Outbox = Drafts, Junk,
 * Deleted) for RFQ mail only: threads labelled "RFQ" (every email the
 * website sends gets the label) and mail from the Suppliers sheet's
 * addresses; Reply, Reply all and Forward are sent from the website too.
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
    // The only request that needs no sign-in: "Forgot password?".
    if (body.action === 'resetPassword') return reply_(resetPassword_(body));
    const user = verify_(body.idToken);
    if (body.action === 'save') return reply_(save_(user, body.profile || {}));
    if (body.action === 'get') return reply_({ ok: true, profile: find_(user.uid) });
    if (body.action === 'listProjects') return reply_({ ok: true, projects: listProjects_(user.uid) });
    if (body.action === 'saveProject') return reply_(saveProject_(user, body.project || {}));
    if (body.action === 'deleteProject') return reply_(deleteProject_(user, String(body.id || '')));
    if (body.action === 'getRates') return reply_(getRates_(user));
    if (body.action === 'saveRates') return reply_(saveRates_(user, body));
    if (body.action === 'addPrices') return reply_(addPrices_(user, body));
    if (body.action === 'devUsers') return reply_(devUsers_(user));
    if (body.action === 'devPrices') return reply_(devPrices_(user, body));
    if (body.action === 'devUpdatePrice') return reply_(devUpdatePrice_(user, body));
    if (body.action === 'devDeletePrices') return reply_(devDeletePrices_(user, body));
    if (body.action === 'devImportMain') return reply_(devImportMain_(user, body));
    if (body.action === 'devCheck') return reply_({ ok: true, developer: isDeveloper_(user), uid: user.uid });
    if (body.action === 'devProfiles') return reply_(devProfiles_(user));
    if (body.action === 'devDeleteUserData') return reply_(devDeleteUserData_(user, body));
    if (body.action === 'devAudit') return reply_(devAudit_(user, body));
    if (body.action === 'getSuppliers') return reply_(getSuppliers_(user));
    if (body.action === 'saveSuppliers') return reply_(saveSuppliers_(user, body));
    if (body.action === 'sendRfq') return reply_(sendRfq_(user, body));
    if (body.action === 'sendMail') return reply_(sendMail_(user, body));
    if (body.action === 'mailList') return reply_(mailList_(user, body));
    if (body.action === 'mailThread') return reply_(mailThread_(user, body));
    if (body.action === 'mailMove') return reply_(mailMove_(user, body));
    if (body.action === 'mailAttachment') return reply_(mailAttachment_(user, body));
    if (body.action === 'mailDraft') return reply_(mailDraft_(user, body));
    if (body.action === 'mailSaveFiles') return reply_(mailSaveFiles_(user, body));
    if (body.action === 'searchPrices') return reply_(searchPrices_(user, body));
    if (body.action === 'priceSearchStatus') return reply_(priceSearchStatus_(user));
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
  // A sign-in Google has confirmed is remembered for 10 minutes (in the
  // script's own cache, by a hash of the token), so each later call skips
  // the round trip to Google.
  const cache = CacheService.getScriptCache();
  const key = 'tok:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText() || '{}');
  const u = data.users && data.users[0];
  if (res.getResponseCode() !== 200 || !u || !u.localId) throw new Error('Your sign-in has expired. Log in again.');
  if (u.disabled) throw new Error('This account has been turned off.');
  const user = { uid: u.localId, email: u.email || '' };
  cache.put(key, JSON.stringify(user), 600);
  return user;
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
const RATE_HEADERS = ['Description', 'Heading above it in the BOQ', 'UOM', 'Supply rate (₹)', 'Service rate (₹)', 'Source sheet', 'Row', 'Single quoted rate', 'Category'];

/** Whether this account may use the price database. */
function ratesAllowed_(user) {
  const owner = PropertiesService.getScriptProperties().getProperty('RATES_OWNER');
  // No owner yet: only the developer, never every signed-in account.
  if (!owner) return isDeveloper_(user);
  if (owner === user.uid || isDeveloper_(user)) return true;
  const s = SpreadsheetApp.getActive().getSheetByName(RATES_ACCESS);
  if (!s || s.getLastRow() < 2 || !user.email) return false;
  const emails = s.getRange(2, 1, s.getLastRow() - 1, 1).getValues();
  return emails.some(function (v) { return String(v[0]).trim().toLowerCase() === user.email.toLowerCase(); });
}

function getRates_(user) {
  const props = PropertiesService.getScriptProperties();
  const s = SpreadsheetApp.getActive().getSheetByName(RATES);
  const mine = userPrices_(user.uid);
  const counts = {};
  mine.forEach(function (p) { counts[p.category] = (counts[p.category] || 0) + 1; });
  const extra = { mine: mine.map(function (p) { return { item: p.material, unit: p.unit, supply: p.price, brand: p.brand, category: p.category }; }), developer: isDeveloper_(user) };
  // Price counts are shown to the developer only; other accounts get none.
  if (!s || s.getLastRow() < 2 || !ratesAllowed_(user)) return Object.assign({ ok: true, rates: null }, extra.developer ? { counts: counts } : {}, extra);
  const rows = s.getRange(2, 1, s.getLastRow() - 1, RATE_HEADERS.length).getValues();
  rows.forEach(function (v) { const c = category_(v[8]) || 'Others'; counts[c] = (counts[c] || 0) + 1; });
  return {
    ok: true,
    counts: extra.developer ? counts : undefined,
    mine: extra.mine,
    developer: extra.developer,
    uplift: Number(props.getProperty('RATES_UPLIFT') || 0),
    updated: props.getProperty('RATES_UPDATED') || '',
    // The Drive copy of the uploaded workbook is shown to the developer only.
    file: extra.developer ? props.getProperty('RATES_FILE') || '' : '',
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
    if (owner && owner !== user.uid && !isDeveloper_(user)) return { ok: false, error: 'Only the account that first saved the price database can replace it.' };
    if (!owner && !isDeveloper_(user)) return { ok: false, error: 'Only the Arzimate developer can save the main price database.' };
    const book = SpreadsheetApp.getActive();
    let s = book.getSheetByName(RATES);
    if (!s) s = book.insertSheet(RATES);
    s.clear();
    const values = rates.map(function (r) {
      return [text_(r.item, 2000), text_(r.context, 1000), text_(r.unit, 40), money_(r.supply), money_(r.service), text_(r.sheet, 120), Number(r.row) || '', r.single ? 'Yes' : 'No', category_(r.category) || 'Electrical'];
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

// ---- Prices added on the website ("Add to your prices"), one store per account ----
const PRICES = 'User prices';
const PRICE_HEADERS = ['User ID', 'Material', 'Unit', 'Price (₹, excl. GST)', 'Brand', 'Category', 'Added', 'Source file', 'Row ID'];
const CATEGORIES = ['Electrical', 'Mechanical', 'HVAC', 'CCTV', 'Fire system', 'PA System', 'Others'];

/** The category as written in CATEGORIES, or '' when it is not one of them. */
function category_(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  for (let i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].toLowerCase() === t) return CATEGORIES[i];
  return '';
}

/**
 * The developer can see and change every price. Decided here, never by the
 * website: an account listed in the DEVELOPER_UIDS script property (comma
 * separated) or the account registered with the email of the Google account that runs this
 * script (Firebase keeps one account per email). The account that owns the
 * price database (RATES_OWNER) is NOT the developer: it keeps its rates,
 * replacing them and the RFQ mailbox, nothing more.
 */
function isDeveloper_(user) {
  const props = PropertiesService.getScriptProperties();
  const uids = String(props.getProperty('DEVELOPER_UIDS') || '').split(',').map(function (v) { return v.trim(); }).filter(String);
  if (uids.indexOf(user.uid) >= 0) return true;
  const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  return !!me && !!user.email && user.email.toLowerCase() === me;
}

function pricesSheet_() {
  const book = SpreadsheetApp.getActive();
  let s = book.getSheetByName(PRICES);
  if (!s) {
    s = book.insertSheet(PRICES);
    s.getRange(1, 1, 1, PRICE_HEADERS.length).setValues([PRICE_HEADERS]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}

function priceRows_() {
  const s = pricesSheet_();
  if (s.getLastRow() < 2) return [];
  return s.getRange(2, 1, s.getLastRow() - 1, PRICE_HEADERS.length).getValues().map(function (v, i) {
    return { sheetRow: i + 2, uid: String(v[0]), material: String(v[1]), unit: String(v[2]), price: Number(v[3]) || 0, brand: String(v[4]), category: category_(v[5]) || 'Others', added: v[6] ? String(v[6]) : '', file: String(v[7]), id: String(v[8]) };
  });
}

function userPrices_(uid) {
  return priceRows_().filter(function (p) { return p.uid === uid && p.price > 0; });
}

function priceKey_(material, unit, brand) {
  return [material, unit, brand].map(function (v) { return String(v || '').trim().toLowerCase().replace(/\s+/g, ' '); }).join('|');
}

/** One price from the website, checked; null when it cannot be stored. */
function priceRow_(r) {
  const material = text_(r && r.material, 500);
  const price = money_(r && r.price);
  const category = category_(r && r.category);
  if (!material || price === '' || !category) return null;
  return { material: material, unit: text_(r.unit, 40), price: price, brand: text_(r.brand, 120), category: category, file: text_(r.file, 200) };
}

/**
 * Adds prices to the caller's own store. mode 'replace': a price with the
 * same material, unit and brand as one already stored takes its place;
 * 'keep': both are kept. Nothing is sent back but the counts.
 */
function addPrices_(user, body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length || rows.length > 20000) return { ok: false, error: 'Send between 1 and 20000 prices at a time.' };
  const clean = rows.map(priceRow_);
  const bad = clean.filter(function (r) { return !r; }).length;
  if (bad) return { ok: false, error: bad + ' price(s) have no material name, no price above 0 or an unknown category.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const s = pricesSheet_();
    let replaced = 0;
    if (body.mode === 'replace') {
      const keys = {};
      clean.forEach(function (r) { keys[priceKey_(r.material, r.unit, r.brand)] = true; });
      const gone = priceRows_().filter(function (p) { return p.uid === user.uid && keys[priceKey_(p.material, p.unit, p.brand)]; });
      for (let i = gone.length - 1; i >= 0; i--) s.deleteRow(gone[i].sheetRow);
      replaced = gone.length;
    }
    const now = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm');
    const values = clean.map(function (r) { return [user.uid, r.material, r.unit, r.price, r.brand, r.category, now, r.file, Utilities.getUuid()]; });
    s.getRange(s.getLastRow() + 1, 1, values.length, PRICE_HEADERS.length).setValues(values);
    return { ok: true, added: values.length, replaced: replaced };
  } finally {
    lock.releaseLock();
  }
}

/** Developer only: every account with its name and how many prices it has. */
function devUsers_(user) {
  if (!isDeveloper_(user)) return { ok: false, error: 'Only the Arzimate developer can do this.' };
  const counts = {};
  priceRows_().forEach(function (p) { counts[p.uid] = (counts[p.uid] || 0) + 1; });
  const users = [];
  const s = sheet_();
  if (s.getLastRow() >= 2) {
    s.getRange(2, 1, s.getLastRow() - 1, HEADERS.length).getValues().forEach(function (v) {
      const uid = String(v[0]);
      if (uid) users.push({ uid: uid, name: (String(v[1]) + ' ' + String(v[2])).trim(), email: String(v[6]), count: counts[uid] || 0 });
    });
  }
  Object.keys(counts).forEach(function (uid) {
    if (!users.some(function (u) { return u.uid === uid; })) users.push({ uid: uid, name: '', email: '', count: counts[uid] });
  });
  const main = SpreadsheetApp.getActive().getSheetByName(RATES);
  return { ok: true, users: users, mainCount: main ? Math.max(0, main.getLastRow() - 1) : 0 };
}

/** Developer only: one account's prices (target uid), or the main price database (target 'main'). */
function devPrices_(user, body) {
  if (!isDeveloper_(user)) return { ok: false, error: 'Only the Arzimate developer can do this.' };
  const target = String(body.target || '');
  if (target === 'main') {
    const s = SpreadsheetApp.getActive().getSheetByName(RATES);
    if (!s || s.getLastRow() < 2) return { ok: true, prices: [] };
    return { ok: true, prices: s.getRange(2, 1, s.getLastRow() - 1, RATE_HEADERS.length).getValues().map(function (v, i) {
      return { id: 'row:' + (i + 2) + ':' + String(v[0]).slice(0, 40), material: String(v[0]), unit: String(v[2]), price: v[3] === '' ? null : Number(v[3]), brand: '', category: category_(v[8]) || 'Others', service: v[4] === '' ? null : Number(v[4]), context: String(v[1]) };
    }) };
  }
  return { ok: true, prices: priceRows_().filter(function (p) { return p.uid === target; }).map(function (p) {
    return { id: p.id, material: p.material, unit: p.unit, price: p.price, brand: p.brand, category: p.category, added: p.added, file: p.file };
  }) };
}

/** Finds a main-database row from its id ('row:<n>:<start of text>'), checking the text still matches. */
function mainRow_(id) {
  const m = /^row:(\d+):([\s\S]*)$/.exec(String(id));
  const s = SpreadsheetApp.getActive().getSheetByName(RATES);
  if (!m || !s || Number(m[1]) > s.getLastRow()) return 0;
  return String(s.getRange(Number(m[1]), 1).getValue()).slice(0, 40) === m[2] ? Number(m[1]) : 0;
}

function devUpdatePrice_(user, body) {
  if (!isDeveloper_(user)) return { ok: false, error: 'Only the Arzimate developer can do this.' };
  const r = priceRow_(body.price || {});
  if (!r) return { ok: false, error: 'The price needs a material name, a price above 0 and a category.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (body.target === 'main') {
      const n = mainRow_(body.id);
      if (!n) return { ok: false, error: 'That line has changed since the list was loaded. Reload and try again.' };
      const s = SpreadsheetApp.getActive().getSheetByName(RATES);
      s.getRange(n, 1).setValue(r.material);
      s.getRange(n, 3, 1, 2).setValues([[r.unit, r.price]]);
      s.getRange(n, 9).setValue(r.category);
      return { ok: true };
    }
    const p = priceRows_().filter(function (x) { return x.id === String(body.id) && x.uid === String(body.target); })[0];
    if (!p) return { ok: false, error: 'That price is no longer there. Reload the list.' };
    pricesSheet_().getRange(p.sheetRow, 2, 1, 5).setValues([[r.material, r.unit, r.price, r.brand, r.category]]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function devDeletePrices_(user, body) {
  if (!isDeveloper_(user)) return { ok: false, error: 'Only the Arzimate developer can do this.' };
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String);
  if (!ids.length) return { ok: false, error: 'Nothing to delete.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let rows;
    let s;
    if (body.target === 'main') {
      s = SpreadsheetApp.getActive().getSheetByName(RATES);
      rows = ids.map(mainRow_).filter(Boolean);
    } else {
      s = pricesSheet_();
      rows = priceRows_().filter(function (p) { return p.uid === String(body.target) && ids.indexOf(p.id) >= 0; }).map(function (p) { return p.sheetRow; });
    }
    rows.sort(function (a, b) { return b - a; }).forEach(function (n) { s.deleteRow(n); });
    return { ok: true, deleted: rows.length };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Developer only: puts arranged prices (from "Import price file") into the
 * main price database. mode 'replace': the whole database becomes these
 * prices; 'add': each price is added, and one with the same material, unit
 * and brand as a row already there takes its place. The brand goes in the
 * "Heading" column as 'Make: <brand>', the file in "Source sheet" as
 * 'Imported: <file>'. Prices are stored as given (no uplift).
 */
function devImportMain_(user, body) {
  if (!isDeveloper_(user)) return { ok: false, error: 'Only the Arzimate developer can do this.' };
  const mode = body.mode === 'replace' ? 'replace' : 'add';
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length || rows.length > 20000) return { ok: false, error: 'Send between 1 and 20000 prices at a time.' };
  const clean = rows.map(priceRow_);
  const bad = clean.filter(function (r) { return !r; }).length;
  if (bad) return { ok: false, error: bad + ' price(s) have no material name, no price above 0 or an unknown category.' };
  const key = function (material, unit, brand) {
    return [material, unit, brand].map(function (v) { return String(v || '').trim().toLowerCase().replace(/\s+/g, ' '); }).join('|');
  };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const book = SpreadsheetApp.getActive();
    let s = book.getSheetByName(RATES);
    if (!s) s = book.insertSheet(RATES);
    const fresh = clean.map(function (r) {
      return [r.material, r.brand ? 'Make: ' + r.brand : '', r.unit, r.price, '', text_('Imported: ' + (r.file || 'price file'), 120), '', 'No', r.category];
    });
    let kept = [];
    let replaced = 0;
    if (mode === 'add' && s.getLastRow() >= 2) {
      const incoming = {};
      fresh.forEach(function (v) { incoming[key(v[0], v[2], String(v[1]).replace(/^Make: /, ''))] = true; });
      s.getRange(2, 1, s.getLastRow() - 1, RATE_HEADERS.length).getValues().forEach(function (v) {
        const brand = /^Make: /.test(String(v[1])) ? String(v[1]).slice(6) : '';
        if (incoming[key(v[0], v[2], brand)]) replaced++; else kept.push(v);
      });
    }
    const values = kept.concat(fresh);
    if (values.length > 20000) return { ok: false, error: 'The main price database would have more than 20000 prices.' };
    s.clear();
    s.getRange(1, 1, 1, RATE_HEADERS.length).setValues([RATE_HEADERS]).setFontWeight('bold');
    s.getRange(2, 1, values.length, RATE_HEADERS.length).setValues(values);
    s.setFrozenRows(1);
    const updated = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'd MMM yyyy');
    const set = { RATES_UPDATED: updated };
    if (mode === 'replace') set.RATES_UPLIFT = '0';
    props.setProperties(set);
    return { ok: true, added: fresh.length, replaced: mode === 'replace' ? kept.length : replaced, total: values.length, updated: updated };
  } finally {
    lock.releaseLock();
  }
}

const SUPPLIERS = 'Suppliers';
const SUPPLIER_HEADERS = ['Supplier', 'Contact person', 'Email', 'CC', 'Supplies (keywords)'];
const RFQ_LOG = 'RFQ log';
const RFQ_LOG_HEADERS = ['Sent', 'Project', 'Supplier', 'Email', 'Items', 'Request ID'];

/** Only the owner of the price database may keep suppliers and send mail. */
function rfqOwner_(user) {
  const owner = PropertiesService.getScriptProperties().getProperty('RATES_OWNER');
  return !!owner && owner === user.uid;
}

function rfqSettings_() {
  const props = PropertiesService.getScriptProperties();
  return { from: props.getProperty('RFQ_FROM') || '', cc: props.getProperty('RFQ_CC') || '', replyTo: props.getProperty('RFQ_REPLYTO') || '', auto: props.getProperty('RFQ_AUTO') === 'yes' };
}

/** The addresses the script may send from: the Gmail account and its "Send mail as" addresses. */
let senders__ = null; // per call: Gmail aliases are slow to read
function senders_() {
  if (senders__) return senders__;
  return senders__ = [Session.getEffectiveUser().getEmail()].concat(GmailApp.getAliases()).map(function (a) { return String(a).toLowerCase(); });
}

function getSuppliers_(user) {
  const owner = PropertiesService.getScriptProperties().getProperty('RATES_OWNER');
  if (owner && owner !== user.uid) return { ok: true, allowed: false, suppliers: [] };
  const s = SpreadsheetApp.getActive().getSheetByName(SUPPLIERS);
  const rows = !s || s.getLastRow() < 2 ? [] : s.getRange(2, 1, s.getLastRow() - 1, SUPPLIER_HEADERS.length).getValues();
  const log = SpreadsheetApp.getActive().getSheetByName(RFQ_LOG);
  const out = { ok: true, allowed: true, suppliers: rows.map(function (v) { return { name: String(v[0]), contact: String(v[1]), email: String(v[2]), cc: String(v[3]), supplies: String(v[4]) }; }), sent: log ? Math.max(0, log.getLastRow() - 1) : 0 };
  const st = rfqSettings_();
  out.from = st.from; out.cc = st.cc; out.replyTo = st.replyTo; out.auto = st.auto;
  try {
    out.senders = senders_();
    out.mailReady = true;
  } catch (err) {
    out.mailReady = false;
    out.mailError = String(err.message || err);
  }
  return out;
}

function emailOk_(e) {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e);
}

function emails_(v) {
  return String(v || '').split(/[,;\s]+/).map(function (e) { return e.trim(); }).filter(function (e) { return e && emailOk_(e); });
}

function saveSuppliers_(user, body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const owner = props.getProperty('RATES_OWNER');
    if (owner && owner !== user.uid) return { ok: false, error: 'Only the account that owns the price database can keep the supplier list.' };
    if (!owner) props.setProperty('RATES_OWNER', user.uid);
    if (Array.isArray(body.suppliers)) {
      if (body.suppliers.length > 2000) return { ok: false, error: 'Too many suppliers.' };
      const values = body.suppliers.map(function (r) {
        return [text_(r.name, 200), text_(r.contact, 200), emails_(r.email).join(', '), emails_(r.cc).join(', '), text_(r.supplies, 2000)];
      }).filter(function (v) { return v[0] && v[2]; });
      const book = SpreadsheetApp.getActive();
      let s = book.getSheetByName(SUPPLIERS);
      if (!s) s = book.insertSheet(SUPPLIERS);
      s.clear();
      s.getRange(1, 1, 1, SUPPLIER_HEADERS.length).setValues([SUPPLIER_HEADERS]).setFontWeight('bold');
      if (values.length) s.getRange(2, 1, values.length, SUPPLIER_HEADERS.length).setValues(values);
      s.setFrozenRows(1);
    }
    if (body.from != null) {
      const from = emails_(body.from)[0] || '';
      props.setProperty('RFQ_FROM', from);
    }
    if (body.cc != null) props.setProperty('RFQ_CC', emails_(body.cc).join(', '));
    if (body.replyTo != null) props.setProperty('RFQ_REPLYTO', emails_(body.replyTo).join(', '));
    if (body.auto != null) props.setProperty('RFQ_AUTO', body.auto ? 'yes' : 'no');
    return getSuppliers_(user);
  } finally {
    lock.releaseLock();
  }
}

function esc_(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The RFQ email body, in the layout of the owner's own RFQ mails. */
function rfqHtml_(lines, signature) {
  const td = 'border:1px solid #000;padding:3px 6px;font-family:Calibri,Arial,sans-serif;font-size:11pt;vertical-align:top;';
  const rows = lines.map(function (l) {
    const b = l.h ? 'font-weight:bold;' : '';
    return '<tr><td style="' + td + 'text-align:center;' + b + '">' + esc_(l.no) + '</td><td style="' + td + b + 'text-align:justify;">' + esc_(l.d).replace(/\n/g, '<br>') +
      '</td><td style="' + td + 'text-align:right;">' + esc_(l.q) + '</td><td style="' + td + 'text-align:center;">' + esc_(l.u) + '</td></tr>';
  }).join('');
  const head = '<tr><th style="' + td + '">Item No.</th><th style="' + td + '">Description</th><th style="' + td + '">Qty</th><th style="' + td + '">Unit</th></tr>';
  const p = 'font-family:Calibri,Arial,sans-serif;font-size:11pt;';
  return '<p style="' + p + '">Dear Sir,</p><p style="' + p + '">Please refer to the item below and kindly submit your best offer for the same.</p>' +
    '<table style="border-collapse:collapse;max-width:800px;">' + head + rows + '</table>' +
    '<p style="' + p + '">Regards,<br>' + signature.map(esc_).join('<br>') + '</p>';
}

function rfqText_(lines, signature) {
  return 'Dear Sir,\n\nPlease refer to the item below and kindly submit your best offer for the same.\n\n' +
    lines.map(function (l) { return [l.no, l.d, l.q, l.u].join('\t'); }).join('\n') + '\n\nRegards,\n' + signature.join('\n');
}

function sendRfq_(user, body) {
  if (!rfqOwner_(user)) return { ok: false, error: 'Only the account that owns the price database can send requests for quote.' };
  const mails = Array.isArray(body.mails) ? body.mails.slice(0, 50) : [];
  const project = text_(body.project, 200) || 'Project';
  const signature = (Array.isArray(body.signature) ? body.signature : []).slice(0, 6).map(function (v) { return String(v).slice(0, 200); });
  const st = rfqSettings_();
  const from = st.from.toLowerCase();
  if (from && senders_().indexOf(from) < 0) {
    return { ok: false, error: from + ' is not set up yet as a "Send mail as" address in the Gmail account that runs the Sheet script (' + Session.getEffectiveUser().getEmail() + ').' };
  }
  const book = SpreadsheetApp.getActive();
  const s = book.getSheetByName(SUPPLIERS);
  const rows = !s || s.getLastRow() < 2 ? [] : s.getRange(2, 1, s.getLastRow() - 1, SUPPLIER_HEADERS.length).getValues();
  let log = book.getSheetByName(RFQ_LOG);
  if (!log) {
    log = book.insertSheet(RFQ_LOG);
    log.getRange(1, 1, 1, RFQ_LOG_HEADERS.length).setValues([RFQ_LOG_HEADERS]).setFontWeight('bold');
    log.setFrozenRows(1);
  }
  const done = log.getLastRow() < 2 ? [] : log.getRange(2, 6, log.getLastRow() - 1, 1).getValues().map(function (v) { return String(v[0]); });
  const sent = [], skipped = [], errors = [];
  mails.forEach(function (m) {
    const name = String(m.supplier || '');
    const row = rows.filter(function (v) { return String(v[0]) === name; })[0];
    const id = String(m.id || '').slice(0, 80);
    if (!row) return errors.push({ supplier: name, error: 'not in the Suppliers sheet' });
    if (id && done.indexOf(id) >= 0) return skipped.push(name);
    const to = emails_(row[2]);
    if (!to.length) return errors.push({ supplier: name, error: 'no email address' });
    const lines = (Array.isArray(m.lines) ? m.lines : []).slice(0, 1000).map(function (l) {
      return { no: String(l.no || '').slice(0, 20), d: String(l.d || '').slice(0, 3000), q: String(l.q == null ? '' : l.q).slice(0, 20), u: String(l.u || '').slice(0, 20), h: !!l.h };
    });
    if (!lines.length) return;
    const cc = emails_(row[3]).concat(emails_(st.cc)).filter(function (e, i, a) { return a.indexOf(e) === i && to.indexOf(e) < 0; });
    const opts = { htmlBody: rfqHtml_(lines, signature) };
    if (cc.length) opts.cc = cc.join(',');
    if (from) opts.from = from;
    try {
      GmailApp.sendEmail(to.join(','), 'RFQ for ' + project, rfqText_(lines, signature), opts);
      const items = lines.filter(function (l) { return !l.h; }).length;
      log.appendRow([new Date(), text_(project, 200), text_(name, 200), to.join(', '), items, id]);
      done.push(id);
      sent.push(name);
    } catch (err) {
      errors.push({ supplier: name, error: String(err.message || err) });
    }
  });
  return { ok: true, sent: sent, skipped: skipped, errors: errors };
}

/** The RFQ body written on the website: its text, the item table and the signature. */
function mailHtml_(intro, lines, closing) {
  const td = 'border:1px solid #000;padding:3px 6px;font-family:Calibri,Arial,sans-serif;font-size:11pt;vertical-align:top;';
  const p = 'font-family:Calibri,Arial,sans-serif;font-size:11pt;';
  const para = function (t) {
    return String(t || '').split(/\n{2,}/).filter(function (x) { return x.trim(); }).map(function (x) { return '<p style="' + p + '">' + esc_(x).replace(/\n/g, '<br>') + '</p>'; }).join('');
  };
  const rows = lines.map(function (l) {
    const b = l.h ? 'font-weight:bold;' : '';
    return '<tr><td style="' + td + 'text-align:center;' + b + '">' + esc_(l.no) + '</td><td style="' + td + b + 'text-align:justify;">' + esc_(l.d).replace(/\n/g, '<br>') +
      '</td><td style="' + td + 'text-align:right;">' + esc_(l.q) + '</td><td style="' + td + 'text-align:center;">' + esc_(l.u) + '</td></tr>';
  }).join('');
  const head = '<tr><th style="' + td + '">Item No.</th><th style="' + td + '">Description</th><th style="' + td + '">Qty</th><th style="' + td + '">Unit</th></tr>';
  return para(intro) + (lines.length ? '<table style="border-collapse:collapse;max-width:800px;">' + head + rows + '</table>' : '') + para(closing);
}

// The "RFQ mailbox" sheet: a copy of every email sent from the RFQ tab (the
// text with its item table, the names of attached files, links to the email
// in Gmail and to its files in Drive).
const MAILBOX = 'RFQ mailbox';
const MAILBOX_HEADERS = ['Sent', 'Project', 'From', 'To', 'CC', 'Subject', 'Mail text', 'Attachments', 'Gmail link', 'Drive folder'];

function mailbox_(book) {
  let box = book.getSheetByName(MAILBOX);
  if (!box) {
    box = book.insertSheet(MAILBOX);
    box.getRange(1, 1, 1, MAILBOX_HEADERS.length).setValues([MAILBOX_HEADERS]).setFontWeight('bold');
    box.setFrozenRows(1);
  }
  return box;
}

// ---- The RFQ mailbox on the website: the owner's Gmail, folder by folder ----
// Only RFQ mail is ever shown (see rfqQuery_); the rest of Gmail never is.
const RFQ_LABEL = 'RFQ';
// Outlook's folders in Gmail: Drafts, Outbox = scheduled mail, Archive = the
// "RFQ-Archive" label (set by Archive on the website) outside the Inbox.
const ARCHIVE_LABEL = 'RFQ-Archive';
const FOLDERS = { inbox: 'in:inbox', drafts: 'in:drafts', sent: 'in:sent', deleted: 'in:trash', archive: 'label:' + ARCHIVE_LABEL + ' -in:inbox -in:trash -in:spam',
  junk: 'in:spam', outbox: 'in:scheduled' };

function archiveLabel_() {
  return GmailApp.getUserLabelByName(ARCHIVE_LABEL) || GmailApp.createLabel(ARCHIVE_LABEL);
}

function rfqLabel_() {
  return GmailApp.getUserLabelByName(RFQ_LABEL) || GmailApp.createLabel(RFQ_LABEL);
}

/** Suppliers' own addresses (Email column only), never one's own or the RFQ CC. */
let suppliers__ = null; // per call
function supplierEmails_() {
  if (suppliers__) return suppliers__;
  const s = SpreadsheetApp.getActive().getSheetByName(SUPPLIERS);
  const rows = !s || s.getLastRow() < 2 ? [] : s.getRange(2, 3, s.getLastRow() - 1, 1).getValues();
  const st = rfqSettings_();
  let mine = emails_(st.cc + ',' + st.replyTo + ',' + st.from);
  try { mine = mine.concat(senders_()); } catch (e) {}
  mine = mine.map(function (e) { return e.toLowerCase(); });
  const out = [];
  rows.forEach(function (r) { emails_(r[0]).forEach(function (e) { e = e.toLowerCase(); if (mine.indexOf(e) < 0 && out.indexOf(e) < 0) out.push(e); }); });
  return suppliers__ = out;
}

// The RFQ mailbox shows only RFQ mail: threads sent from this mailbox (label
// "RFQ", replies land in the same thread) and a supplier's own RFQ email.
// The rest of the Gmail account is never shown.
function rfqQuery_() {
  const from = supplierEmails_().slice(0, 60);
  return '(label:' + RFQ_LABEL + (from.length ? ' OR (from:(' + from.join(' OR ') + ') subject:RFQ)' : '') + ')';
}

function address_(v) {
  const m = String(v || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(v || '')).trim().toLowerCase();
}

/** Whether a thread is RFQ mail and so may be shown. */
function inScope_(thread) {
  if (thread.getLabels().some(function (l) { return l.getName() === RFQ_LABEL; })) return true;
  const from = supplierEmails_();
  return /\bRFQ\b/i.test(thread.getFirstMessageSubject()) && thread.getMessages().some(function (m) { return from.indexOf(address_(m.getFrom())) >= 0; });
}

/**
 * Gmail search matches single messages, and only the emails sent from the
 * website carry the "RFQ" label. A reply that arrives in an RFQ thread
 * (from a supplier, or from one's own other address) is labelled here, so
 * it shows in the Inbox. Runs at most every 15 seconds.
 */
function labelReplies_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('rfqSweep')) return;
  cache.put('rfqSweep', '1', 15);
  // Threads with a labelled email and an unlabelled one: two searches, then
  // label only those.
  const labelled = {};
  GmailApp.search('label:' + RFQ_LABEL + ' newer_than:60d', 0, 100).forEach(function (t) { labelled[t.getId()] = true; });
  const todo = GmailApp.search('-label:' + RFQ_LABEL + ' -in:trash -in:spam newer_than:60d', 0, 100).filter(function (t) { return labelled[t.getId()]; });
  if (todo.length) {
    const label = rfqLabel_();
    todo.forEach(function (t) { t.addLabel(label); });
  }
}

function mailList_(user, body) {
  if (!rfqOwner_(user)) return { ok: false, error: 'Only the account that owns the price database can open the RFQ mailbox.' };
  if (!body.start) { try { labelReplies_(); } catch (e) {} }
  const folder = FOLDERS[body.folder] ? body.folder : 'inbox';
  const scope = 'rfq';
  const q = [FOLDERS[folder], rfqQuery_(), String(body.query || '').slice(0, 200)].filter(String).join(' ');
  const start = Math.max(0, Number(body.start) || 0);
  const threads = GmailApp.search(q, start, 25);
  const me = senders_();
  // One batch read of the messages, and one search for the paper clips.
  const all = threads.length ? GmailApp.getMessagesForThreads(threads) : [];
  const clips = {};
  if (threads.length) GmailApp.search(q + ' has:attachment', 0, Math.min(500, start + 50)).forEach(function (t) { clips[t.getId()] = true; });
  // Counts beside the folders, as in Outlook: unread in Inbox and Junk, all in Drafts.
  const counts = {};
  if (start === 0) {
    const sq = ' ' + rfqQuery_();
    counts.inbox = GmailApp.search('in:inbox is:unread' + sq, 0, 100).length;
    counts.drafts = GmailApp.search('in:drafts' + sq, 0, 100).length;
    counts.junk = GmailApp.search('in:spam is:unread' + sq, 0, 100).length;
    counts.outbox = GmailApp.search('in:scheduled' + sq, 0, 100).length;
  }
  return {
    ok: true, folder: folder, scope: scope, start: start, more: threads.length === 25, unread: counts.inbox, counts: start === 0 ? counts : null,
    threads: threads.map(function (t, i) {
      const ms = all[i];
      const last = ms[ms.length - 1];
      // Who the thread is with: the sender, or for one's own mail the recipient.
      const other = me.indexOf(address_(last.getFrom())) >= 0 ? 'To: ' + last.getTo() : last.getFrom();
      // Replied / forwarded arrows: one's own answers after the first email.
      const answers = ms.slice(1).filter(function (m) { return me.indexOf(address_(m.getFrom())) >= 0; });
      return { id: t.getId(), flagged: t.hasStarredMessages(), replied: answers.some(function (m) { return /^re:/i.test(m.getSubject()); }),
        forwarded: ms.some(function (m) { return me.indexOf(address_(m.getFrom())) >= 0 && /^fwd?:/i.test(m.getSubject()); }), subject: t.getFirstMessageSubject(), date: t.getLastMessageDate().toISOString(), with: other,
        count: t.getMessageCount(), unread: t.isUnread(), snippet: String(last.getPlainBody() || '').replace(/\s+/g, ' ').slice(0, 140),
        attachments: !!clips[t.getId()] };
    }),
  };
}

function mailThread_(user, body) {
  if (!rfqOwner_(user)) return { ok: false, error: 'Only the account that owns the price database can open the RFQ mailbox.' };
  const t = GmailApp.getThreadById(String(body.id || ''));
  if (!t || !inScope_(t)) return { ok: false, error: 'This email is not in the RFQ mailbox.' };
  const out = t.getMessages().map(function (m) {
    return { id: m.getId(), from: m.getFrom(), to: m.getTo(), cc: m.getCc(), replyTo: m.getReplyTo(), date: m.getDate().toISOString(), subject: m.getSubject(),
      text: String(m.getPlainBody() || '').slice(0, 30000), draft: m.isDraft(), trashed: m.isInTrash(),
      attachments: m.getAttachments().map(function (a) { return { name: a.getName(), size: a.getSize() }; }) };
  });
  if (t.isUnread()) t.markRead();
  return { ok: true, id: t.getId(), subject: t.getFirstMessageSubject(), spam: t.isInSpam(), trash: t.isInTrash(), messages: out };
}

/** Moves a thread: delete, restore, junk, not junk, unread. */
function mailMove_(user, body) {
  if (!rfqOwner_(user)) return { ok: false, error: 'Only the account that owns the price database can change the RFQ mailbox.' };
  const t = GmailApp.getThreadById(String(body.id || ''));
  if (!t || !inScope_(t)) return { ok: false, error: 'This email is not in the RFQ mailbox.' };
  const what = String(body.move || '');
  if (what === 'delete') t.moveToTrash();
  else if (what === 'restore') t.moveToInbox();
  else if (what === 'junk') t.moveToSpam();
  else if (what === 'notJunk') t.moveToInbox();
  else if (what === 'unread') t.markUnread();
  else if (what === 'read') t.markRead();
  else if (what === 'flag') t.getMessages().forEach(function (m) { m.star(); });
  else if (what === 'unflag') t.getMessages().forEach(function (m) { m.unstar(); });
  else if (what === 'archive') { t.addLabel(archiveLabel_()); t.moveToArchive(); }
  else if (what === 'inbox') { try { t.removeLabel(archiveLabel_()); } catch (e) {} t.moveToInbox(); }
  else return { ok: false, error: 'Unknown change.' };
  return { ok: true };
}

/** One attached file of a message in the RFQ mailbox, for download. */
function mailAttachment_(user, body) {
  if (!rfqOwner_(user)) return { ok: false, error: 'Only the account that owns the price database can open the RFQ mailbox.' };
  const m = GmailApp.getMessageById(String(body.message || ''));
  if (!m || !inScope_(m.getThread())) return { ok: false, error: 'This email is not in the RFQ mailbox.' };
  const a = m.getAttachments()[Number(body.index) || 0];
  if (!a) return { ok: false, error: 'The file is no longer in this email.' };
  return { ok: true, name: a.getName(), mime: a.getContentType(), b64: Utilities.base64Encode(a.getBytes()) };
}

/** Sends a draft in the Outbox (Gmail Drafts), or deletes it. */
function mailDraft_(user, body) {
  if (!rfqOwner_(user)) return { ok: false, error: 'Only the account that owns the price database can send from the RFQ mailbox.' };
  const d = GmailApp.getDrafts().filter(function (x) { return x.getMessageId() === String(body.message || ''); })[0];
  if (!d || !inScope_(d.getMessage().getThread())) return { ok: false, error: 'This draft is no longer in the Outbox.' };
  if (body.send) d.send();
  else d.deleteDraft();
  return { ok: true };
}

const MAIL_LIMIT = 25 * 1048576; // Gmail's limit for one email
const RFQ_FOLDER = 'Estimation RFQ';

/** The Drive folder "Estimation RFQ/<project>", made when missing. */
function rfqFolder_(project) {
  const roots = DriveApp.getFoldersByName(RFQ_FOLDER);
  const root = roots.hasNext() ? roots.next() : DriveApp.createFolder(RFQ_FOLDER);
  const name = String(project || '').replace(/[\/\\]/g, '-').trim().slice(0, 100) || 'Other mail';
  const subs = root.getFoldersByName(name);
  return subs.hasNext() ? subs.next() : root.createFolder(name);
}

/** Saves [blobs] in the project's Drive folder; returns its link, or '' with [problem] set. */
function saveToDrive_(project, blobs, problem) {
  if (!blobs.length) return '';
  try {
    const folder = rfqFolder_(project);
    blobs.forEach(function (b) { folder.createFile(b.copyBlob ? b.copyBlob() : b); });
    return folder.getUrl();
  } catch (err) {
    problem.error = /permission|authoriz/i.test(String(err.message || err))
      ? 'The files were sent but not saved in Drive: the Sheet script is not allowed to use Drive yet (open the script, run doGet and Allow).'
      : 'The files were sent but not saved in Drive: ' + String(err.message || err);
    return '';
  }
}

/**
 * Sends an email written on the website's RFQ tab. mode 'new' (an RFQ):
 * one email to each address in "to", so suppliers never see each other.
 * 'reply' / 'replyAll': a reply in the thread of message "ref". 'forward':
 * message "ref" with its files to the "to" addresses. Attached files are
 * also saved in Drive (Estimation RFQ/<project>). Only the owner of the
 * price database may send.
 */
function sendMail_(user, body) {
  if (!rfqOwner_(user)) return { ok: false, error: 'Only the account that owns the price database can send requests for quote.' };
  const mode = ['reply', 'replyAll', 'forward'].indexOf(body.mode) >= 0 ? body.mode : 'new';
  let ref = null;
  if (mode !== 'new') {
    ref = GmailApp.getMessageById(String(body.ref || ''));
    if (!ref || !inScope_(ref.getThread())) return { ok: false, error: 'The email being answered is no longer in the RFQ mailbox.' };
  }
  const to = emails_((Array.isArray(body.to) ? body.to : [body.to]).join(',')).filter(function (e, i, a) { return a.indexOf(e) === i; });
  if (!to.length && mode !== 'reply' && mode !== 'replyAll') return { ok: false, error: 'Add at least one To address.' };
  if (to.length > 30) return { ok: false, error: 'Send to at most 30 addresses at a time.' };
  const from = (emails_(body.from)[0] || '').toLowerCase();
  if (from && senders_().indexOf(from) < 0) {
    return { ok: false, error: from + ' is not an address the Gmail account that runs the Sheet script (' + Session.getEffectiveUser().getEmail() + ') can send from.' };
  }
  const cc = emails_(body.cc);
  const bcc = emails_(body.bcc);
  // Replies go here (e.g. the company mailbox when it cannot be a Gmail From address).
  const replyTo = emails_(body.replyTo)[0] || '';
  const subject = String(body.subject || '').slice(0, 250) || 'Request for Quote';
  const intro = String(body.intro || '').slice(0, 20000);
  const closing = String(body.closing || '').slice(0, 2000);
  const quoted = String(body.quoted || '').slice(0, 30000);
  const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 1000).map(function (l) {
    return { no: String(l.no || '').slice(0, 20), d: String(l.d || '').slice(0, 3000), q: String(l.q == null ? '' : l.q).slice(0, 20), u: String(l.u || '').slice(0, 20), h: !!l.h };
  });
  const names = body.names && typeof body.names === 'object' ? body.names : {};
  const files = Array.isArray(body.attachments) ? body.attachments.slice(0, 20) : [];
  let size = 0;
  const blobs = files.map(function (f) {
    const bytes = Utilities.base64Decode(String(f.b64 || ''));
    size += bytes.length;
    return Utilities.newBlob(bytes, String(f.mime || 'application/octet-stream'), String(f.name || 'file').slice(0, 200));
  });
  // A forward carries the files of the email forwarded.
  const carried = mode === 'forward' ? ref.getAttachments() : [];
  carried.forEach(function (a) { size += a.getSize(); });
  if (size > MAIL_LIMIT) return { ok: false, error: 'The attached files are ' + (size / 1048576).toFixed(1) + ' MB; Gmail allows 25 MB per email.' };
  const table = lines.length ? lines.map(function (l) { return [l.no, l.d, l.q, l.u].join('\t'); }).join('\n') + '\n\n' : '';
  const text = intro + '\n\n' + table + closing + (quoted ? '\n\n' + quoted : '');
  const html = mailHtml_(intro, lines, closing) + (quoted ? '<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;font-family:Calibri,Arial,sans-serif;font-size:11pt;">' +
    esc_(quoted).replace(/\n/g, '<br>') + '</blockquote>' : '');
  const book = SpreadsheetApp.getActive();
  let log = book.getSheetByName(RFQ_LOG);
  if (!log) {
    log = book.insertSheet(RFQ_LOG);
    log.getRange(1, 1, 1, RFQ_LOG_HEADERS.length).setValues([RFQ_LOG_HEADERS]).setFontWeight('bold');
    log.setFrozenRows(1);
  }
  const items = lines.filter(function (l) { return !l.h; }).length;
  const box = mailbox_(book);
  const label = rfqLabel_();
  const problem = {};
  // Connected apps on the website can turn saving in Drive off.
  const drive = body.saveToDrive === false ? '' : saveToDrive_(body.project, blobs, problem);
  const sent = [], errors = [];
  // A new RFQ is one email per To address; anything else is one email.
  const groups = mode === 'new' ? to.map(function (a) { return [a]; }) : [to];
  groups.forEach(function (group) {
    const opts = { htmlBody: html };
    const c = cc.filter(function (e) { return group.map(function (g) { return g.toLowerCase(); }).indexOf(e.toLowerCase()) < 0; });
    if (c.length) opts.cc = c.join(',');
    if (bcc.length) opts.bcc = bcc.join(',');
    if (from) opts.from = from;
    if (replyTo) opts.replyTo = replyTo;
    const all = blobs.concat(carried);
    if (all.length) opts.attachments = all;
    try {
      let draft;
      if (mode === 'reply') draft = ref.createDraftReply(text, opts);
      else if (mode === 'replyAll') draft = ref.createDraftReplyAll(text, opts);
      else draft = GmailApp.createDraft(group.join(','), subject, text, opts);
      const message = draft.send();
      const thread = message.getThread();
      thread.addLabel(label);
      const shownTo = group.length ? group.join(', ') : message.getTo();
      log.appendRow([new Date(), text_(body.project, 200), text_(group.map(function (g) { return names[g] || ''; }).join(', '), 200), shownTo, items, mode === 'new' ? '' : mode]);
      box.appendRow([new Date(), text_(body.project, 200), from || Session.getEffectiveUser().getEmail(), shownTo, c.join(', '), text_(message.getSubject() || subject, 250),
        text_(text, 45000), files.concat(carried.map(function (a) { return { name: a.getName() }; })).map(function (f) { return String(f.name || 'file'); }).join(', '),
        'https://mail.google.com/mail/u/0/#sent/' + thread.getId(), drive]);
      sent.push(shownTo);
    } catch (err) {
      errors.push({ supplier: group.join(', ') || 'reply', error: String(err.message || err) });
    }
  });
  return { ok: true, sent: sent, skipped: [], errors: errors, drive: drive, driveError: problem.error || '' };
}

/** Saves the files of a thread's emails in Drive (Estimation RFQ/<project>). */
function mailSaveFiles_(user, body) {
  if (!rfqOwner_(user)) return { ok: false, error: 'Only the account that owns the price database can save files.' };
  const t = GmailApp.getThreadById(String(body.id || ''));
  if (!t || !inScope_(t)) return { ok: false, error: 'This email is not in the RFQ mailbox.' };
  const blobs = [];
  t.getMessages().forEach(function (m) { m.getAttachments().forEach(function (a) { blobs.push(a); }); });
  if (!blobs.length) return { ok: false, error: 'This email has no attached files.' };
  const problem = {};
  const link = saveToDrive_(body.project || t.getFirstMessageSubject().replace(/^(re|fwd?):\s*/i, '').replace(/^RFQ for\s+/i, ''), blobs, problem);
  if (!link) return { ok: false, error: (problem.error || '').replace('The files were sent but not saved in Drive', 'The files could not be saved in Drive') };
  return { ok: true, saved: blobs.length, link: link };
}

// ---- Online price search -------------------------------------------------
// Searches current Indian prices for BOQ items with no rate. The keys are
// Script properties the owner adds in Apps Script (Project Settings > Script
// properties); they never leave this script:
//   GEMINI_API_KEY  Google AI Studio key: Gemini with Google Search (free tier)
//   SERPER_API_KEY  serper.dev key: Google Shopping and web results
//   OPENAI_API_KEY  OpenAI key: ChatGPT with web search
// Only prices seen on a web page are returned, each with its link.

function searchKeys_() {
  const p = PropertiesService.getScriptProperties();
  return { gemini: p.getProperty('GEMINI_API_KEY') || '', serper: p.getProperty('SERPER_API_KEY') || '', openai: p.getProperty('OPENAI_API_KEY') || '' };
}

function priceSearchStatus_(user) {
  const k = searchKeys_();
  return { ok: true, allowed: ratesAllowed_(user), gemini: !!k.gemini, google: !!k.serper, chatgpt: !!k.openai };
}

function clip_(v, n) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
}

function rupees_(text) {
  const m = String(text || '').match(/(?:₹|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ''));
  return isFinite(v) && v > 0 ? v : null;
}

function host_(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.)?([^\/:?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function itemQuery_(it) {
  return [it.brand, it.description, it.rating, 'price'].filter(String).join(' ');
}

function searchPrices_(user, body) {
  if (!ratesAllowed_(user)) return { ok: false, error: 'Only the owner of the price database can search prices online.' };
  const keys = searchKeys_();
  if (!keys.gemini && !keys.serper && !keys.openai) return { ok: false, error: 'No search key is set up yet. Add GEMINI_API_KEY in the Apps Script project settings (Script properties).' };
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 10).map(function (it, i) {
    return { id: String(it.id || i), description: clip_(it.description, 300), rating: clip_(it.rating, 120), uom: clip_(it.uom, 20), brand: clip_(it.brand, 60), context: clip_(it.context, 160) };
  }).filter(function (it) { return it.description; });
  if (!items.length) return { ok: false, error: 'Give the items to search.' };
  if (body.estimate) return estimatePrices_(items, keys);
  const out = {};
  items.forEach(function (it) { out[it.id] = { id: it.id, candidates: [], errors: [] }; });
  const reqs = [];
  const handlers = [];
  if (keys.gemini) {
    reqs.push(geminiRequest_(items, keys.gemini));
    handlers.push(function (res) { geminiParse_(res, items, out); });
  }
  if (keys.serper) {
    items.forEach(function (it) {
      ['shopping', 'search'].forEach(function (path) {
        reqs.push({ url: 'https://google.serper.dev/' + path, method: 'post', contentType: 'application/json', headers: { 'X-API-KEY': keys.serper }, payload: JSON.stringify({ q: itemQuery_(it), gl: 'in', hl: 'en', num: 10 }), muteHttpExceptions: true });
        handlers.push(function (res) { serperParse_(res, it, out[it.id]); });
      });
    });
  }
  if (keys.openai) {
    items.forEach(function (it) {
      reqs.push({ url: 'https://api.openai.com/v1/responses', method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + keys.openai }, payload: JSON.stringify({ model: 'gpt-5-mini', tools: [{ type: 'web_search' }], input: offerPrompt_([it]) }), muteHttpExceptions: true });
      handlers.push(function (res) { openaiParse_(res, it, out[it.id]); });
    });
  }
  const answers = UrlFetchApp.fetchAll(reqs);
  answers.forEach(function (res, i) {
    try {
      handlers[i](res);
    } catch (e) {
      items.forEach(function (it) { out[it.id].errors.push(String(e.message || e)); });
    }
  });
  const results = items.map(function (it) {
    const r = out[it.id];
    const seen = {};
    r.candidates = r.candidates.filter(function (c) {
      const k = c.url + '|' + c.price;
      if (seen[k] || !(c.price > 0) || !/^https?:\/\//.test(c.url)) return false;
      seen[k] = true;
      return true;
    }).sort(function (a, b) { return a.price - b.price; }).slice(0, 20);
    return r;
  });
  return { ok: true, results: results, checked: Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd') };
}

// For items no page gives a price for: Gemini's best estimate of the Indian
// market rate (supply before GST, and installation), with its basis. The
// website marks every such rate "Estimate, confirm".
function estimatePrices_(items, keys) {
  if (!keys.gemini) return { ok: false, error: 'Estimates need GEMINI_API_KEY in the Apps Script project settings (Script properties).' };
  const prompt = 'You are an electrical estimator in India. For each BOQ item below, give your best estimate of the current Indian market ' +
    'supply rate in INR before GST for one unit, and the installation (labour) rate in INR for one unit. Use web search for similar items ' +
    'and brand price lists. If the item is a custom-built panel or assembly, estimate from its listed components. Give a one-line basis.\n' +
    items.map(function (it, i) {
      return (i + 1) + '. ' + it.description + (it.rating ? ' | rating: ' + it.rating : '') + (it.uom ? ' | unit: ' + it.uom : '') + (it.context ? ' | section: ' + it.context : '');
    }).join('\n') +
    '\nAnswer with JSON only: {"items":[{"n":1,"supply":number,"service":number,"basis":""}]}';
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(keys.gemini), {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
  });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'Gemini estimate failed (' + res.getResponseCode() + ')' };
  const cand = (JSON.parse(res.getContentText()).candidates || [])[0] || {};
  const j = json_(((cand.content || {}).parts || []).map(function (p) { return p.text || ''; }).join(''));
  if (!j || !Array.isArray(j.items)) return { ok: false, error: 'Gemini gave no estimates' };
  const results = [];
  j.items.forEach(function (row) {
    const it = items[Number(row.n) - 1];
    const supply = Number(row.supply), service = Number(row.service);
    if (!it || !(supply > 0 || service > 0)) return;
    results.push({ id: it.id, supply: supply > 0 ? supply : null, service: service > 0 ? service : null, basis: clip_(row.basis, 200) });
  });
  return { ok: true, estimates: results, checked: Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd') };
}

function offerPrompt_(items) {
  return 'Find current prices in India (INR) for these electrical items, from brand price lists, distributors or marketplaces ' +
    '(Moglix, Industrybuying, IndiaMART, Amazon.in, Flipkart, brand sites). Only give prices you saw on a web page, with that page\'s full link, ' +
    'for the same item (same type, rating, size and unit). Never estimate. Say whether the price includes GST when the page says so, ' +
    'and the unit the price is for (each, metre, set, kg).\n' +
    items.map(function (it, i) {
      return (i + 1) + '. ' + it.description + (it.rating ? ' | rating: ' + it.rating : '') + (it.uom ? ' | unit: ' + it.uom : '') + (it.brand ? ' | brand: ' + it.brand : '') + (it.context ? ' | section: ' + it.context : '');
    }).join('\n') +
    '\nAnswer with JSON only: {"items":[{"n":1,"offers":[{"price":number,"unit":"","title":"","seller":"","brand":"","url":"","gst":"incl|excl|unknown"}]}]}';
}

function json_(text) {
  const t = String(text || '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch (e) {
    return null;
  }
}

function offerOf_(o, provider, sites) {
  const price = Number(o.price);
  const url = String(o.url || '');
  if (!(price > 0) || !/^https?:\/\//.test(url)) return null;
  // Gemini's links must be among the pages its Google search returned.
  if (sites && !sites.some(function (d) { const h = host_(url); return h === d || h.endsWith('.' + d) || d.endsWith('.' + h); })) return null;
  return {
    provider: provider,
    price: price,
    title: clip_(o.title, 160),
    seller: clip_(o.seller, 60) || host_(url),
    brand: clip_(o.brand, 60),
    url: url,
    unit: clip_(o.unit, 20),
    note: o.gst === 'incl' ? 'price includes GST' : o.gst === 'excl' ? 'price before GST' : '',
  };
}

function geminiRequest_(items, key) {
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key),
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ contents: [{ parts: [{ text: offerPrompt_(items) }] }], tools: [{ google_search: {} }] }),
    muteHttpExceptions: true,
  };
}

function geminiParse_(res, items, out) {
  if (res.getResponseCode() !== 200) throw new Error('Gemini search failed (' + res.getResponseCode() + ')');
  const data = JSON.parse(res.getContentText());
  const cand = (data.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).map(function (p) { return p.text || ''; }).join('');
  const sites = ((cand.groundingMetadata || {}).groundingChunks || []).map(function (c) { return String((c.web || {}).title || '').toLowerCase().replace(/^www\./, ''); }).filter(String);
  const j = json_(text);
  if (!j || !Array.isArray(j.items)) throw new Error('Gemini gave no price list');
  if (!sites.length) return;
  j.items.forEach(function (row) {
    const it = items[Number(row.n) - 1];
    if (!it) return;
    (row.offers || []).forEach(function (o) {
      const c = offerOf_(o, 'gemini', sites);
      if (c) out[it.id].candidates.push(c);
    });
  });
}

function serperParse_(res, it, r) {
  if (res.getResponseCode() !== 200) throw new Error('Google search failed (' + res.getResponseCode() + ')');
  const data = JSON.parse(res.getContentText());
  (data.shopping || []).forEach(function (s) {
    const price = rupees_(s.price);
    if (price) r.candidates.push({ provider: 'google', price: price, title: clip_(s.title, 160), seller: clip_(s.source, 60) || host_(s.link), url: s.link, note: 'Google Shopping listing' });
  });
  (data.organic || []).forEach(function (o) {
    const price = rupees_((o.price || '') + ' ' + (o.snippet || ''));
    if (price) r.candidates.push({ provider: 'google', price: price, title: clip_(o.title, 160), seller: host_(o.link), url: o.link, note: clip_(o.snippet, 200) });
  });
}

function openaiParse_(res, it, r) {
  if (res.getResponseCode() !== 200) throw new Error('ChatGPT search failed (' + res.getResponseCode() + ')');
  const data = JSON.parse(res.getContentText());
  let text = data.output_text || '';
  if (!text) (data.output || []).forEach(function (o) { (o.content || []).forEach(function (c) { if (c.type === 'output_text') text += c.text; }); });
  const j = json_(text);
  if (!j || !Array.isArray(j.items)) throw new Error('ChatGPT gave no price list');
  j.items.forEach(function (row) {
    (row.offers || []).forEach(function (o) {
      const c = offerOf_(o, 'chatgpt', null);
      if (c) r.candidates.push(c);
    });
  });
}

// ---- User management (developer only; called by the website's 'users' Cloud Functions with the developer's own sign-in) ----
const AUDIT = 'User admin log';
const AUDIT_HEADERS = ['When', 'Developer ID', 'Developer email', 'Action', 'Account ID', 'Account email', 'Details'];

/** Developer only: every saved profile (name, organisation, department, mobile, signed up). */
function devProfiles_(user) {
  if (!isDeveloper_(user)) return { ok: false, error: 'Only the Arzimate developer can do this.' };
  const s = sheet_();
  if (s.getLastRow() < 2) return { ok: true, profiles: [] };
  return { ok: true, profiles: s.getRange(2, 1, s.getLastRow() - 1, HEADERS.length).getValues().filter(function (v) { return String(v[0]); }).map(function (v) {
    return { uid: String(v[0]), firstName: String(v[1]), lastName: String(v[2]), organization: String(v[3]), department: String(v[4]), mobile: String(v[5]), email: String(v[6]), signedUp: v[7] ? String(v[7]) : '' };
  }) };
}

function audit_(user, action, uid, email, details) {
  const book = SpreadsheetApp.getActive();
  let s = book.getSheetByName(AUDIT);
  if (!s) {
    s = book.insertSheet(AUDIT);
    s.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  s.appendRow([Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss'), user.uid, user.email, text_(action, 40), text_(uid, 128), text_(email, 200), text_(details, 500)]);
}

/** Developer only: writes one line to the "User admin log" sheet (disable, enable, delete). */
function devAudit_(user, body) {
  if (!isDeveloper_(user)) return { ok: false, error: 'Only the Arzimate developer can do this.' };
  if (!/^(disable|enable|delete)$/.test(String(body.what))) return { ok: false, error: 'Unknown action.' };
  audit_(user, body.what, body.uid, body.email, body.details || '');
  return { ok: true };
}

/**
 * Developer only: removes what this Sheet keeps for one account: its profile
 * row ("Users"), its project details ("Projects") and its own prices ("User
 * prices"). Never the developer's own account. Says how many rows went.
 */
function devDeleteUserData_(user, body) {
  if (!isDeveloper_(user)) return { ok: false, error: 'Only the Arzimate developer can do this.' };
  const uid = String(body.uid || '');
  if (!uid) return { ok: false, error: 'No account given.' };
  if (uid === user.uid) return { ok: false, error: 'You cannot delete your own account.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const gone = { profile: 0, projects: 0, prices: 0 };
    const drop = function (s, width, key) {
      if (!s || s.getLastRow() < 2) return;
      const v = s.getRange(2, 1, s.getLastRow() - 1, width).getValues();
      for (let i = v.length - 1; i >= 0; i--) if (String(v[i][0]) === uid) { s.deleteRow(i + 2); gone[key]++; }
    };
    drop(sheet_(), HEADERS.length, 'profile');
    drop(SpreadsheetApp.getActive().getSheetByName(PROJECTS), PROJECT_HEADERS.length, 'projects');
    drop(SpreadsheetApp.getActive().getSheetByName(PRICES), PRICE_HEADERS.length, 'prices');
    return { ok: true, removed: gone };
  } finally {
    lock.releaseLock();
  }
}

// ---- Password reset emails, sent from the owner's Gmail ----
const RESETS = 'Password resets';
const FIREBASE_PROJECT = 'estimation-6fa32';
const RESET_ANSWER = { ok: true, message: 'If there is an Arzimate account for this email, a reset link is on its way from Arzimate. Check Junk too.' };

/** "a***@example.com": enough to recognise a request, not the full address. */
function maskEmail_(email) {
  const at = email.indexOf('@');
  return at < 1 ? '***' : email.charAt(0) + '***' + email.slice(at);
}

function logReset_(email, result) {
  const book = SpreadsheetApp.getActive();
  let s = book.getSheetByName(RESETS);
  if (!s) {
    s = book.insertSheet(RESETS);
    s.getRange(1, 1, 1, 3).setValues([['When', 'Email (masked)', 'Result']]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  s.appendRow([Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss'), maskEmail_(email), result]);
}

/** Counts one more use of [key] this hour; false when [max] is already reached. */
function underLimit_(cache, key, max) {
  const n = Number(cache.get(key) || 0);
  if (n >= max) return false;
  cache.put(key, String(n + 1), 3600);
  return true;
}

/**
 * Emails a password reset link from the owner's Gmail. No sign-in. Always the
 * same answer, so it never tells whether an account exists. At most 3 a
 * hour per email and 30 a hour in all.
 */
function resetPassword_(body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { ok: false, error: 'Enter a valid email.' };
  const cache = CacheService.getScriptCache();
  const key = 'reset:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email));
  if (!underLimit_(cache, 'reset:all', 30) || !underLimit_(cache, key, 3)) {
    logReset_(email, 'over the limit, not sent');
    return RESET_ANSWER;
  }
  let link = '';
  try {
    const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/projects/' + FIREBASE_PROJECT + '/accounts:sendOobCode', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': FIREBASE_PROJECT },
      payload: JSON.stringify({ requestType: 'PASSWORD_RESET', email: email, returnOobLink: true }),
      muteHttpExceptions: true,
    });
    const data = JSON.parse(res.getContentText() || '{}');
    if (res.getResponseCode() === 200 && data.oobLink) link = String(data.oobLink);
    else {
      const why = String((data.error && data.error.message) || res.getResponseCode());
      logReset_(email, /EMAIL_NOT_FOUND|USER_NOT_FOUND/.test(why) ? 'no such account, not sent' : 'link refused: ' + why.slice(0, 120));
      return RESET_ANSWER;
    }
  } catch (err) {
    logReset_(email, 'link failed: ' + String(err.message || err).slice(0, 120));
    return RESET_ANSWER;
  }
  const note = 'This link works once and expires in about an hour. If you did not ask for it, ignore this email.';
  const safe = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  try {
    GmailApp.sendEmail(email, 'Reset your Arzimate password',
      'Hello,\n\nUse this link to set a new password for your Arzimate account (' + email + '):\n\n' + link + '\n\n' + note + '\n\nArzimate: BOQ to Excel\nhttps://arzimate.web.app',
      {
        name: 'Arzimate',
        htmlBody: '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b1b2f;max-width:520px">' +
          '<p>Hello,</p><p>Use the button below to set a new password for your Arzimate account (' + email.replace(/</g, '&lt;') + ').</p>' +
          '<p style="margin:24px 0"><a href="' + safe + '" style="background:#4c3fc4;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Reset password</a></p>' +
          '<p>Or open this link:<br><a href="' + safe + '" style="word-break:break-all">' + safe + '</a></p>' +
          '<p style="color:#555">' + note + '</p><p style="color:#888">Arzimate: BOQ to Excel &middot; <a href="https://arzimate.web.app">arzimate.web.app</a></p></div>',
      });
    logReset_(email, 'sent');
  } catch (err) {
    logReset_(email, 'mail failed: ' + String(err.message || err).slice(0, 120));
  }
  return RESET_ANSWER;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
