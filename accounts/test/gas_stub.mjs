import crypto from 'node:crypto';
// Runs accounts/profiles.gs under Node with Apps Script stubs.
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const src = fs.readFileSync(process.argv[2], 'utf8')
  .replace("'PASTE_YOUR_FIREBASE_API_KEY'", "'fake-api-key'")
  .replace('https://identitytoolkit.googleapis.com/', 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/');
const sheets = {};
const props = process.env.FAKE_SEARCH ? { GEMINI_API_KEY: 'test-key' } : {};
const files = [];
const mails = [];

// A small Gmail: threads in folders, messages, the RFQ label, drafts sent at once.
const threads = [];
const me = () => process.env.GMAIL || 'owner@gmail.com';
let nextId = 1;
const blobOf = (b) => ({ getName: () => b.name, getSize: () => b.bytes, getContentType: () => b.mime, getBytes: () => [...Buffer.alloc(b.bytes, 65)], copyBlob: () => blobOf(b), ...b });
const label = { getName: () => 'RFQ' };
function msgObj(m, t) {
  return {
    getId: () => m.id, getFrom: () => m.from, getTo: () => m.to, getCc: () => m.cc || '', getReplyTo: () => '', getDate: () => m.date, getSubject: () => m.subject,
    getPlainBody: () => m.text, star: () => (t.starred = true), unstar: () => (t.starred = false), getAttachments: () => m.attachments.map(blobOf), isInTrash: () => t.folder === 'trash', isDraft: () => !!m.draft, getThread: () => threadObj(t),
    createDraftReply: (text, opts) => draft(t, m.from, 'Re: ' + t.messages[0].subject, text, opts, 'reply'),
    createDraftReplyAll: (text, opts) => draft(t, [m.from, ...String(m.to).split(',')].filter((a) => a && !a.includes(me())).join(','), 'Re: ' + t.messages[0].subject, text, opts, 'replyAll'),
  };
}
function threadObj(t) {
  return {
    getId: () => t.id, getMessages: () => t.messages.map((m) => msgObj(m, t)), getFirstMessageSubject: () => t.messages[0].subject,
    getLastMessageDate: () => t.messages[t.messages.length - 1].date, getMessageCount: () => t.messages.length, isUnread: () => t.unread,
    markRead: () => (t.unread = false), hasStarredMessages: () => !!t.starred, markUnread: () => (t.unread = true), getLabels: () => (t.labels.has('RFQ') ? [label] : []), addLabel: () => { t.labels.add('RFQ'); t.newUnlabelled = false; },
    moveToTrash: () => (t.folder = 'trash'), moveToArchive: () => (t.folder = 'archive'), removeLabel: () => {}, moveToInbox: () => (t.folder = 'inbox'), moveToSpam: () => (t.folder = 'spam'), isInSpam: () => t.folder === 'spam', isInTrash: () => t.folder === 'trash',
  };
}
function draft(t, to, subject, text, opts = {}, mode = 'new') {
  return { send: () => {
    const atts = (opts.attachments || []).map((b) => ({ name: b.name || b.getName(), bytes: typeof b.bytes === 'number' ? b.bytes : b.getSize(), mime: b.mime || 'application/octet-stream' }));
    mails.push({ to, subject, text, ...opts, attachments: atts, mode });
    const m = { id: 'm' + nextId++, from: opts.from || me(), to, cc: opts.cc || '', date: new Date(), subject, text, attachments: atts };
    if (!t) { t = { id: 't' + nextId++, labels: new Set(), folder: 'sent', unread: false, messages: [] }; threads.push(t); }
    t.messages.push(m);
    return msgObj(m, t);
  } };
}
function search(q, start, max) {
  const folder = q.includes('label:RFQ-Archive') ? 'archive' : { inbox: 'inbox', sent: 'sent', drafts: 'drafts', spam: 'spam', trash: 'trash', scheduled: 'scheduled' }[(q.match(/in:(\w+)/) || [])[1]];
  const from = ((q.match(/from:\(([^)]*)\)/) || [])[1] || '').split(' OR ').filter(Boolean);
  const rfq = q.includes('(label:RFQ');
  if (q.startsWith('-label:RFQ ')) return threads.filter((t) => t.newUnlabelled).slice(start, start + max).map(threadObj);
  if (q.startsWith('label:RFQ newer_than')) return threads.filter((t) => t.labels.has('RFQ')).slice(start, start + max).map(threadObj);
  if (q.endsWith(' has:attachment')) return search(q.slice(0, -' has:attachment'.length), 0, 1000).filter((t) => t.getMessages().some((m) => m.getAttachments().length)).slice(start, start + max);
  const rfqSubject = q.includes(') subject:RFQ)');
  const words = q.replace(/label:RFQ-Archive|-in:\w+|in:\w+|is:unread|\(label:RFQ( OR \(from:\([^)]*\) subject:RFQ\))?\)/g, '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return threads.filter((t) => (folder === 'sent' ? t.messages.some((m) => m.from.includes(me()) || m.from.includes('@')) && t.folder !== 'trash' && t.folder !== 'spam' && t.messages.some((m) => !m.from.includes('supplier')) : t.folder === folder))
    .filter((t) => !rfq || (t.labels.has('RFQ') && !(folder === 'inbox' && t.newUnlabelled)) || (rfqSubject && /\bRFQ\b/i.test(t.messages[0].subject) && t.messages.some((m) => from.includes(m.from.toLowerCase()))))
    .filter((t) => !q.includes('is:unread') || t.unread)
    .filter((t) => words.every((w) => t.messages.some((m) => (m.subject + ' ' + m.text + ' ' + m.from + ' ' + m.to).toLowerCase().includes(w))))
    .reverse().slice(start, start + max).map(threadObj);
}
const folders = {};
function folderObj(path) {
  return folders[path] ??= {
    getUrl: () => 'https://drive.example/folder/' + encodeURIComponent(path),
    getFoldersByName: (n) => { const f = folders[path + '/' + n]; return { hasNext: () => !!f, next: () => f }; },
    createFolder: (n) => folderObj(path + '/' + n),
    createFile: (b) => (files.push({ folder: path, name: b.name || (b.getName && b.getName()), bytes: b.bytes }), { getUrl: () => 'https://drive.example/file/' + files.length }),
  };
}
const cell = (v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);
const makeSheet = (rows) => ({
  clear: () => rows.splice(0, rows.length),
  appendRow: (r) => rows.push(r.map(cell)),
  deleteRow: (r) => rows.splice(r - 1, 1),
  setFrozenRows() {}, getLastRow: () => rows.length,
  getRange: (r, c, nr = 1, nc = 1) => ({
    setFontWeight() { return this; },
    getValues: () => rows.slice(r - 1, r - 1 + nr).map((x) => x.slice(c - 1, c - 1 + nc)),
    setValues(vals) { vals.forEach((v, i) => v.forEach((x, j) => ((rows[r - 1 + i] ??= [])[c - 1 + j] = cell(x)))); return this; },
    setValue: (x) => (rows[r - 1][c - 1] = x),
  }),
});
const cache = {};
const ctx = {
  JSON, Date, String, Error, Number, isFinite, Math, Object, Array, RegExp,
  // FAKE_SEARCH=1: Gemini answers with a made-up price for each item (the
  // first item unpriced, so the estimate step runs), on moglix.com.
  UrlFetchApp: { fetchAll: (reqs) => reqs.map((r) => ctx.UrlFetchApp.fetch(r.url, r)), fetch(url, o) {
    if (process.env.FAKE_SEARCH && url.includes('generativelanguage')) {
      const prompt = JSON.parse(o.payload).contents[0].parts[0].text;
      const n = (prompt.match(/^\d+\. /gm) || []).length;
      const estimate = /best estimate/.test(prompt);
      const items = Array.from({ length: n }, (_, i) => estimate
        ? { n: i + 1, supply: 5000, service: 500, basis: 'similar items on IndiaMART' }
        : { n: i + 1, offers: i === 0 ? [] : [{ price: 1180 * (i + 1), unit: 'each', title: 'Item ' + (i + 1), seller: 'Moglix', url: 'https://www.moglix.com/item' + (i + 1), gst: 'incl' }, { price: 1200 * (i + 1), title: 'Item', seller: 'IndustryBuying', url: 'https://www.industrybuying.com/i' + (i + 1), gst: 'incl' }] });
      const body = { candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify({ items }) + '\n```' }] }, groundingMetadata: { groundingChunks: [{ web: { title: 'moglix.com' } }, { web: { title: 'industrybuying.com' } }] } }] };
      return { getContentText: () => JSON.stringify(body), getResponseCode: () => 200 };
    }
    const out = execFileSync('curl', ['-s', '--noproxy', '*', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', o.payload, '-w', '\n%{http_code}', url]).toString();
    const i = out.lastIndexOf('\n');
    return { getContentText: () => out.slice(0, i), getResponseCode: () => +out.slice(i + 1) };
  } },
  SpreadsheetApp: { getActive: () => ({ getSheetByName: (n) => (sheets[n] ? sheets[n].sheet : null), insertSheet: (n) => (sheets[n] = { rows: [], sheet: null }, sheets[n].sheet = makeSheet(sheets[n].rows)) }) },
  CacheService: { getScriptCache: () => ({ get: (k) => (cache[k] && cache[k].until > Date.now() ? cache[k].v : null), put: (k, v, s = 600) => (cache[k] = { v, until: Date.now() + s * 1000 }) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperties: (o) => Object.assign(props, o), setProperty: (k, v) => (props[k] = String(v)) }) },
  DriveApp: {
    // NO_DRIVE=1: the script was never allowed Drive access.
    getFoldersByName: (n) => {
      if (process.env.NO_DRIVE) throw new Error('You do not have permission to call DriveApp.getFoldersByName. Required permissions: (https://www.googleapis.com/auth/drive.readonly || https://www.googleapis.com/auth/drive)');
      const f = folders[n];
      return { hasNext: () => !!f, next: () => f };
    },
    createFolder: (n) => folderObj(n),
  },
  Session: { getEffectiveUser: () => ({ getEmail: () => process.env.GMAIL || 'owner@gmail.com' }) },
  // NO_ALIAS=1: the From address is not a "Send mail as" address yet.
  GmailApp: {
    getAliases: () => (process.env.NO_ALIAS ? [] : ['projectexecution_mv@symaticindia.com']),
    sendEmail: (to, subject, text, opts) => mails.push({ to, subject, text, ...opts }),
    createDraft: (to, subject, text, opts) => draft(null, to, subject, text, opts),
    search, getMessagesForThreads: (ts) => ts.map((t) => t.getMessages()), getUserLabelByName: () => label, createLabel: () => label, getDrafts: () => [],
    getThreadById: (id) => { const t = threads.find((x) => x.id === id); return t ? threadObj(t) : null; },
    getMessageById: (id) => { for (const t of threads) { const m = t.messages.find((x) => x.id === id); if (m) return msgObj(m, t); } return null; },
  },
  Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (alg, t) => [...crypto.createHash(alg).update(t).digest()], base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'), base64Encode: (b) => Buffer.from(b).toString('base64'), base64Decode: (t) => [...Buffer.from(t, 'base64')], newBlob: (bytes, mime, name) => ({ bytes: bytes.length, mime, name }), formatDate: () => '19 Oct 2026' },
  MimeType: { MICROSOFT_EXCEL: 'xlsx' },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType() { return this; }, t }) },
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.startsWith('/files')) { res.end(JSON.stringify(files)); return; }
    // POST /inject {from, to, text, files}: a supplier's reply to the RFQ thread sent to "from".
    if (req.url.startsWith('/inject')) {
      const j = JSON.parse(body);
      // {from, subject, text, personal: true}: a new email outside RFQ, in the Inbox.
      if (j.personal) {
        threads.push({ id: 't' + nextId++, labels: new Set(), folder: 'inbox', unread: true, messages: [{ id: 'm' + nextId++, from: j.from, to: me(), cc: '', date: new Date(), subject: j.subject, text: j.text, attachments: [] }] });
        res.end(JSON.stringify({ ok: true })); return;
      }
      const t = threads.find((x) => x.messages[0].to === (j.to || j.from));
      if (t) {
        t.messages.push({ id: 'm' + nextId++, from: j.from, to: me(), cc: '', date: new Date(), subject: 'Re: ' + t.messages[0].subject, text: j.text, attachments: (j.files || []).map((n) => ({ name: n, bytes: 2048, mime: 'application/pdf' })) });
        t.folder = 'inbox'; t.unread = true; t.newUnlabelled = true;
      }
      res.end(JSON.stringify({ ok: !!t })); return;
    }
    if (req.url.startsWith('/mails')) { res.end(JSON.stringify(mails)); return; }
    if (req.url.startsWith('/rows')) { const n = new URL(req.url, 'http://x').searchParams.get('sheet') || 'Users'; res.end(JSON.stringify(sheets[n]?.rows ?? [])); return; }
    const out = req.method === 'POST' ? ctx.doPost({ postData: { contents: body } }) : ctx.doGet();
    res.setHeader('Content-Type', 'application/json');
    res.end(out.t);
  });
}).listen(8787, () => console.log('gas on 8787'));
