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
    const user = verify_(body.idToken);
    if (body.action === 'save') return reply_(save_(user, body.profile || {}));
    if (body.action === 'get') return reply_({ ok: true, profile: find_(user.uid) });
    if (body.action === 'listProjects') return reply_({ ok: true, projects: listProjects_(user.uid) });
    if (body.action === 'saveProject') return reply_(saveProject_(user, body.project || {}));
    if (body.action === 'deleteProject') return reply_(deleteProject_(user, String(body.id || '')));
    if (body.action === 'getRates') return reply_(getRates_(user));
    if (body.action === 'saveRates') return reply_(saveRates_(user, body));
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
function senders_() {
  return [Session.getEffectiveUser().getEmail()].concat(GmailApp.getAliases()).map(function (a) { return String(a).toLowerCase(); });
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
function supplierEmails_() {
  const s = SpreadsheetApp.getActive().getSheetByName(SUPPLIERS);
  const rows = !s || s.getLastRow() < 2 ? [] : s.getRange(2, 3, s.getLastRow() - 1, 1).getValues();
  const st = rfqSettings_();
  let mine = emails_(st.cc + ',' + st.replyTo + ',' + st.from);
  try { mine = mine.concat(senders_()); } catch (e) {}
  mine = mine.map(function (e) { return e.toLowerCase(); });
  const out = [];
  rows.forEach(function (r) { emails_(r[0]).forEach(function (e) { e = e.toLowerCase(); if (mine.indexOf(e) < 0 && out.indexOf(e) < 0) out.push(e); }); });
  return out;
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
  const label = rfqLabel_();
  GmailApp.search('-label:' + RFQ_LABEL + ' -in:trash -in:spam newer_than:60d', 0, 60).forEach(function (t) {
    if (t.getLabels().some(function (l) { return l.getName() === RFQ_LABEL; })) t.addLabel(label);
  });
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
    threads: threads.map(function (t) {
      const ms = t.getMessages();
      const last = ms[ms.length - 1];
      // Who the thread is with: the sender, or for one's own mail the recipient.
      const other = me.indexOf(address_(last.getFrom())) >= 0 ? 'To: ' + last.getTo() : last.getFrom();
      // Replied / forwarded arrows: one's own answers after the first email.
      const answers = ms.slice(1).filter(function (m) { return me.indexOf(address_(m.getFrom())) >= 0; });
      return { id: t.getId(), flagged: t.hasStarredMessages(), replied: answers.some(function (m) { return /^re:/i.test(m.getSubject()); }),
        forwarded: ms.some(function (m) { return me.indexOf(address_(m.getFrom())) >= 0 && /^fwd?:/i.test(m.getSubject()); }), subject: t.getFirstMessageSubject(), date: t.getLastMessageDate().toISOString(), with: other,
        count: t.getMessageCount(), unread: t.isUnread(), snippet: String(last.getPlainBody() || '').replace(/\s+/g, ' ').slice(0, 140),
        attachments: ms.some(function (m) { return m.getAttachments().length > 0; }) };
    }),
  };
}

function mailThread_(user, body) {
  if (!rfqOwner_(user)) return { ok: false, error: 'Only the account that owns the price database can open the RFQ mailbox.' };
  const t = GmailApp.getThreadById(String(body.id || ''));
  if (!t || !inScope_(t)) return { ok: false, error: 'This email is not in the RFQ mailbox.' };
  const drafts = {};
  try { GmailApp.getDrafts().forEach(function (d) { drafts[d.getMessageId()] = true; }); } catch (e) {}
  const out = t.getMessages().map(function (m) {
    return { id: m.getId(), from: m.getFrom(), to: m.getTo(), cc: m.getCc(), replyTo: m.getReplyTo(), date: m.getDate().toISOString(), subject: m.getSubject(),
      text: String(m.getPlainBody() || '').slice(0, 30000), draft: !!drafts[m.getId()], trashed: m.isInTrash(),
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
  const drive = saveToDrive_(body.project, blobs, problem);
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

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
