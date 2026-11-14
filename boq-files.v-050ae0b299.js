// One priced workbook per client BOQ file. The app merges every uploaded file into one BOQ
// ("<project>_BOQ.xlsx"); its "Sources" sheet lists each file with its number of items, in
// the order the items appear. When the app saves that workbook, this script also writes each
// client file back as it was, with only the rate, amount, margin, transport and accessories
// columns added (the same writer the AI agent uses), and the app's rates filled in. It also
// lets "Compute with AI Agent" send each client file as its own job.
// Everything runs in the browser; the writer (core/estimation_core.*.js) loads only when needed.
(function (root) {
  'use strict';

  // ---- Reading an .xlsx (zip of XML) -------------------------------------------------------

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // { path: () => Promise<string> } for every file in the zip.
  function unzip(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let end = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('not an .xlsx file');
    const count = dv.getUint16(end + 10, true);
    let p = dv.getUint32(end + 16, true);
    const files = {};
    const text = new TextDecoder();
    for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
      const method = dv.getUint16(p + 10, true);
      const size = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const skip = nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = text.decode(u8.subarray(p + 46, p + 46 + nameLen));
      files[name] = async () => {
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        const raw = u8.subarray(start, start + size);
        return text.decode(method === 8 ? await inflate(raw) : raw);
      };
      p += 46 + skip;
    }
    return files;
  }

  const unxml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });
  const textOf = (xml) => unxml((xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || [])
    .map((t) => t.replace(/^<t\b[^>]*>|<\/t>$/g, '')).join(''));

  // Sheet names of a workbook, and a reader for one sheet: { 'A1': { v, f } } (v: number or text).
  async function readWorkbook(bytes) {
    const zip = unzip(bytes);
    const book = await zip['xl/workbook.xml']();
    const rels = await zip['xl/_rels/workbook.xml.rels']();
    const target = {};
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]+)"/.exec(m[0]);
      const t = /\bTarget="([^"]+)"/.exec(m[0]);
      if (id && t) target[id[1]] = t[1].startsWith('/') ? t[1].slice(1) : `xl/${t[1]}`;
    }
    const sheets = {};
    for (const m of book.matchAll(/<sheet\b[^>]*>/g)) {
      const name = /\bname="([^"]*)"/.exec(m[0]);
      const rid = /\br:id="([^"]+)"/.exec(m[0]) || /\bid="([^"]+)"/.exec(m[0]);
      if (name && rid && target[rid[1]]) sheets[unxml(name[1])] = target[rid[1]];
    }
    let shared = null;
    async function strings() {
      if (!shared) {
        const xml = zip['xl/sharedStrings.xml'] ? await zip['xl/sharedStrings.xml']() : '';
        shared = (xml.match(/<si\b[\s\S]*?<\/si>/g) || []).map(textOf);
      }
      return shared;
    }
    async function sheet(name) {
      const path = sheets[name];
      if (!path || !zip[path]) return null;
      const xml = await zip[path]();
      const ss = await strings();
      const cells = {};
      for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\br="([A-Z]+\d+)"/.exec(m[1]);
        if (!ref) continue;
        const type = (/\bt="([^"]+)"/.exec(m[1]) || [])[1] || 'n';
        const inner = m[2] || '';
        const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner);
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        let value = null;
        if (type === 's' && v) value = ss[Number(v[1])] ?? '';
        else if (type === 'inlineStr') value = textOf(inner);
        else if (type === 'str' || type === 'e') value = v ? unxml(v[1]) : null;
        else if (type === 'b') value = v ? v[1] === '1' : null;
        else if (v) value = Number(v[1]);
        cells[ref[1]] = { v: value, f: f ? unxml(f[1]) : null };
      }
      return cells;
    }
    return { names: Object.keys(sheets), sheet };
  }

  // ---- The app's merged BOQ: its files, items and rates -------------------------------------

  const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const col = (i) => (i < 26 ? COLS[i] : COLS[Math.floor(i / 26) - 1] + COLS[i % 26]);
  // A number, also when the cell holds it as text ("557").
  const num = (c) => {
    if (!c || c.v == null) return null;
    if (typeof c.v === 'number') return Number.isFinite(c.v) ? c.v : null;
    return /^\s*-?\d+(\.\d+)?\s*$/.test(String(c.v)) ? Number(c.v) : null;
  };
  const str = (c) => (c && c.v != null ? String(c.v).trim() : '');
  const round2 = (x) => Math.round(x * 100) / 100;
  const lastRow = (cells) => (cells.__last ??= Object.keys(cells).reduce((m, k) => Math.max(m, Number(k.replace(/^[A-Z]+/, '')) || 0), 0));

  // The header row (within the first 12 rows) that has every one of `names`: { name: column letter, row }.
  function header(cells, names) {
    for (let r = 1; r <= 12; r++) {
      const found = { row: r };
      for (let i = 0; i < 40; i++) {
        const t = str(cells[`${col(i)}${r}`]).toLowerCase();
        for (const n of names) if (!found[n] && t.startsWith(n.toLowerCase())) found[n] = col(i);
      }
      if (names.every((n) => found[n])) return found;
    }
    return null;
  }

  // null when the workbook is not the app's merged BOQ. Otherwise
  // { files: [{ name, type, count, items: [...] }], factors }, every item with
  // { description, uom, quantity, cost, service, source, brand } (cost and service per unit,
  // before margin, transport and accessories; null when the app has no rate).
  async function mergedBoq(bytes) {
    const wb = await readWorkbook(bytes);
    if (!['BOQ', 'Rates', 'Sources'].every((n) => wb.names.includes(n))) return null;
    const [boq, rates, sources] = await Promise.all([wb.sheet('BOQ'), wb.sheet('Rates'), wb.sheet('Sources')]);
    const bh = header(boq, ['S. No.', 'Description', 'Unit of Measurement', 'Quantity', 'Supply Rate', 'Margin %']);
    const rh = header(rates, ['S. No.', 'Description', 'UOM', 'List / Market Price', 'Discount %', 'Service Rate', 'Source']);
    const sh = header(sources, ['S. No.', 'File', 'Type', 'Items found']);
    if (!bh || !rh || !sh) return null;
    // The yellow factors above the BOQ header: Discount %, Supply margin %, Transport %, Accessories %, Service margin %.
    const factorAt = (label) => {
      for (let r = 1; r < bh.row; r++) {
        for (let i = 0; i < 40; i++) {
          if (str(boq[`${col(i)}${r}`]).toLowerCase().startsWith(label)) return num(boq[`${col(i)}${r + 1}`]) || 0;
        }
      }
      return 0;
    };
    const factors = {
      discount: factorAt('discount %'),
      supplyMargin: factorAt('supply margin %'),
      transport: factorAt('transport %'),
      accessories: factorAt('accessories %'),
      serviceMargin: factorAt('service margin %'),
    };
    const gstCol = (header(rates, ['S. No.', 'GST in price']) || {})['GST in price'];
    const brandCol = (header(rates, ['S. No.', 'Brand considered']) || {})['Brand considered'];
    const checkedCol = (header(rates, ['S. No.', 'Checked on']) || {})['Checked on'];
    const byNo = new Map();
    for (let r = rh.row + 1; r <= lastRow(rates); r++) {
      const no = num(rates[`${rh['S. No.']}${r}`]);
      if (no == null) continue;
      const list = num(rates[`${rh['List / Market Price']}${r}`]);
      const discCell = rates[`${rh['Discount %']}${r}`];
      const disc = num(discCell) ?? (discCell && discCell.f ? factors.discount : 0);
      const gst = (gstCol && num(rates[`${gstCol}${r}`])) || 0;
      byNo.set(no, {
        cost: list == null ? null : round2((list * (1 - disc)) / (1 + gst)),
        service: num(rates[`${rh['Service Rate']}${r}`]),
        source: str(rates[`${rh.Source}${r}`]),
        brand: brandCol ? str(rates[`${brandCol}${r}`]) : '',
        date: checkedCol ? str(rates[`${checkedCol}${r}`]) : '',
      });
    }
    const items = [];
    for (let r = bh.row + 1; r <= lastRow(boq); r++) {
      const no = num(boq[`${bh['S. No.']}${r}`]);
      if (no == null) continue;
      const rate = byNo.get(no) || {};
      const own = num(boq[`${bh['Margin %']}${r}`]); // a row whose margin was typed over
      items.push({
        no,
        description: str(boq[`${bh.Description}${r}`]),
        uom: str(boq[`${bh['Unit of Measurement']}${r}`]),
        quantity: num(boq[`${bh.Quantity}${r}`]),
        margin: own == null ? factors.supplyMargin : own,
        cost: rate.cost ?? null,
        service: rate.service ?? null,
        source: rate.source || '',
        brand: rate.brand || '',
        date: rate.date || '',
      });
    }
    const files = [];
    let at = 0;
    for (let r = sh.row + 1; r <= sh.row + 500; r++) {
      const name = str(sources[`${sh.File}${r}`]);
      if (!name) break;
      const count = num(sources[`${sh['Items found']}${r}`]) || 0;
      files.push({ name, type: str(sources[`${sh.Type}${r}`]).toUpperCase(), count, items: items.slice(at, at + count) });
      at += count;
    }
    // The counts must add up to the BOQ's items, or the order cannot be trusted.
    if (at !== items.length) return { files: [], factors, items, mismatch: true };
    return { files, factors, items };
  }

  // ---- Matching a client file's lines to the app's items ------------------------------------

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // A text prepared once for comparing: its normal form, its words and its numbers (sizes, ratings).
  const prep = (s) => {
    const n = norm(s);
    const nums = (String(s || '').match(/\d+(?:\.\d+)?/g) || []).map(Number).sort((a, b) => a - b);
    return { n, w: new Set(n.split(' ').filter((x) => x.length > 1)), nums };
  };
  // True when the numbers of `a` are all among those of `b` (counting repeats).
  const within = (a, b) => {
    const left = [...b];
    for (const x of a) { const i = left.indexOf(x); if (i < 0) return false; left.splice(i, 1); }
    return true;
  };
  // 0..1: how alike two descriptions are. Different sizes or ratings (3Cx2.5 and 3Cx1.5) are never alike.
  function likeness(a, b) {
    const x = typeof a === 'string' ? prep(a) : a;
    const y = typeof b === 'string' ? prep(b) : b;
    if (!x.n || !y.n) return 0;
    if (x.n === y.n) return 1;
    const sameNums = x.nums.length === y.nums.length && within(x.nums, y.nums);
    if (x.n.length >= 8 && y.n.length >= 8) {
      if (x.n.includes(y.n) && within(y.nums, x.nums)) return 0.9;
      if (y.n.includes(x.n) && within(x.nums, y.nums)) return 0.9;
    }
    if (!sameNums) return 0;
    let both = 0;
    for (const w of x.w) if (y.w.has(w)) both++;
    return both / Math.max(1, x.w.size + y.w.size - both);
  }

  // Pairs the app's items of one file (in order) with the client file's lines (core.readItems).
  // A description can repeat (the same cable in two sections): the quantity, then the order, decide.
  // Returns [{ item, line }] for the pairs found.
  function pairUp(items, lines) {
    const used = new Set();
    const pairs = [];
    const own = lines.map((l) => prep(l.description));
    let next = 0;
    for (const item of items) {
      const d = prep(item.description);
      const u = norm(item.uom);
      let best = null;
      let bestScore = 0;
      for (let j = 0; j < lines.length; j++) {
        if (used.has(j)) continue;
        const l = lines[j];
        let s = likeness(d, own[j]);
        if (s < 0.7) continue;
        if (item.quantity != null && l.quantity != null) s += Math.abs(item.quantity - l.quantity) < 1e-9 ? 0.3 : -0.1;
        else if (item.quantity == null && l.quantity == null) s += 0.15;
        if (u && u === norm(l.uom)) s += 0.05;
        s -= Math.min(0.2, Math.abs(j - next) * 0.002) + (j < next ? 0.02 : 0); // prefer the next line in order
        if (s > bestScore) { bestScore = s; best = j; }
      }
      if (best == null) continue;
      used.add(best);
      pairs.push({ item, line: lines[best] });
      next = best + 1;
    }
    return pairs;
  }

  const kindOf = (source) => (/^computed|estimate/i.test(source) ? 'estimate' : /market|online|web|shop/i.test(source) ? 'web' : 'db');

  // The writer's build-ups and factors for one client file, from the app's rates.
  function buildUpsFor(merged, file, lines) {
    const f = merged.factors;
    const pairs = pairUp(file.items, lines);
    const buildUps = [];
    for (const { item, line } of pairs) {
      if (item.cost == null && item.service == null) continue;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : '';
      const source = [item.source, item.brand && !item.source.startsWith(item.brand) ? item.brand : ''].filter(Boolean).join(' · ');
      // One margin for both supply and service in the writer: a row's own margin and the
      // service margin are folded into the rates, so the prices come out as in the app.
      const supplyRate = item.cost == null ? null : round2((item.cost * (1 + item.margin)) / (1 + f.supplyMargin));
      const serviceRate = item.service == null ? null : round2((item.service * (1 + f.serviceMargin)) / (1 + f.supplyMargin));
      buildUps.push({
        sheet: line.sheet,
        row: line.row,
        description: line.description,
        uom: line.uom || item.uom,
        quantity: line.quantity,
        supply: supplyRate == null ? [] : [{ name: 'Supply rate', spec: '', qty: 1, uom: item.uom, rate: supplyRate, source: source || 'Estimation app', sourceType: kindOf(item.source), date }],
        service: serviceRate == null ? [] : [{ name: 'Installation / service rate', spec: '', qty: 1, uom: item.uom, rate: serviceRate, source: source || 'Estimation app', sourceType: kindOf(item.source), date }],
        notes: item.cost == null ? 'No supply rate in the app; please fill it.' : '',
      });
    }
    return {
      buildUps,
      paired: pairs.length,
      priced: buildUps.length,
      factors: { discount: 1, transport: 1 + f.transport, accessories: 1 + f.accessories, margin: f.supplyMargin },
    };
  }

  const pricedName = (name) => `${name.replace(/\.xlsx$/i, '')} - priced.xlsx`;
  const api = { readWorkbook, mergedBoq, pairUp, buildUpsFor, pricedName, likeness };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || !root.estimation) { root.estimationBoqFiles = api; return; }

  // ---- In the website ----------------------------------------------------------------------

  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const est = root.estimation;
  const picked = new Map(); // file name -> bytes of every .xlsx chosen or dropped this session
  const remember = (list) => {
    for (const f of list || []) if (f && /\.xlsx$/i.test(f.name) && f.bytes) picked.set(f.name, f.bytes);
    return list;
  };
  const pickFiles = est.pickFiles;
  const takeDropped = est.takeDropped;
  const saveFile = est.saveFile;
  est.pickFiles = (...a) => Promise.resolve(pickFiles.apply(est, a)).then(remember);
  est.takeDropped = (...a) => remember(takeDropped.apply(est, a));

  let corePromise = null;
  function loadCore() {
    if (root.estimationCore) return Promise.resolve(root.estimationCore);
    corePromise ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL(CORE_SRC, document.baseURI).href;
      s.onload = () => (root.estimationCore ? resolve(root.estimationCore) : reject(new Error('the workbook writer did not load')));
      s.onerror = () => { corePromise = null; reject(new Error('the workbook writer did not load; check the connection')); };
      document.head.appendChild(s);
    });
    return corePromise;
  }

  // ---- A small notice at the bottom left ----
  let box = null;
  function notice(html, buttons = []) {
    if (!box) {
      const css = document.createElement('style');
      css.textContent = `#boq-files{position:fixed;left:18px;bottom:18px;z-index:2147483000;max-width:min(460px,calc(100vw - 36px));
        background:#fff;color:#1b1f24;border:1px solid #d0d7de;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);
        font:14px/1.45 system-ui,"Segoe UI",sans-serif;padding:14px 16px}
        #boq-files b{font-weight:600}#boq-files ul{margin:6px 0 0;padding-left:18px;max-height:180px;overflow:auto}
        #boq-files .row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}
        #boq-files button{font:600 13px system-ui,"Segoe UI",sans-serif;border-radius:8px;padding:7px 12px;cursor:pointer;border:1px solid #d0d7de;background:#f6f8fa;color:#1b1f24}
        #boq-files button.main{background:#1a56db;border-color:#1a56db;color:#fff}
        @media (prefers-color-scheme:dark){#boq-files{background:#1c2128;color:#e6edf3;border-color:#30363d}
        #boq-files button{background:#2d333b;color:#e6edf3;border-color:#444c56}}`;
      document.head.appendChild(css);
      box = document.createElement('div');
      box.id = 'boq-files';
      box.setAttribute('role', 'status');
      document.body.appendChild(box);
    }
    box.innerHTML = html;
    box.style.display = 'block';
    return new Promise((resolve) => {
      const all = [...buttons, { label: 'Close', value: null }];
      const row = document.createElement('div');
      row.className = 'row';
      for (const b of all) {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = b.label;
        if (b.main) el.className = 'main';
        el.onclick = () => { if (b.value === null) box.style.display = 'none'; resolve(b.value); };
        row.appendChild(el);
      }
      box.appendChild(row);
    });
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const list = (names) => `<ul>${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;

  // The client .xlsx files behind a merged BOQ, as [{ file, bytes }]; asks for the ones this
  // page no longer holds (after a reload). Resolves with null if the person closes the notice.
  async function originals(merged, what, asked = { yes: false }) {
    const wanted = merged.files.filter((f) => f.type === 'XLSX' && f.count > 0);
    for (;;) {
      const missing = wanted.filter((f) => !picked.has(f.name));
      if (!missing.length) return wanted.map((file) => ({ file, bytes: picked.get(file.name) }));
      asked.yes = true;
      const go = await notice(`<b>${esc(what)}</b><br>Choose the original BOQ file${missing.length > 1 ? 's' : ''} again so ${missing.length > 1 ? 'each' : 'it'} can be kept exactly as sent:${list(missing.map((f) => f.name))}`,
        [{ label: 'Choose files', value: true, main: true }]);
      if (!go) return null;
      remember(await pickFiles.call(est, '.xlsx'));
    }
  }

  async function writeEach(bytes) {
    let merged;
    try { merged = await mergedBoq(bytes); } catch (_) { return; }
    if (!merged || merged.mismatch || !merged.files.some((f) => f.type === 'XLSX' && f.count > 0)) return;
    const what = 'One priced workbook per BOQ file';
    const inputs = await originals(merged, what);
    if (!inputs) return;
    notice(`<b>${esc(what)}</b><br>Writing ${inputs.length} file${inputs.length > 1 ? 's' : ''}…`);
    const done = [];
    const problems = [];
    try {
      const core = await loadCore();
      for (const { file, bytes: input } of inputs) {
        try {
          const lines = JSON.parse(core.readItems(new Uint8Array(input))).lines || [];
          const plan = buildUpsFor(merged, file, lines);
          const out = core.buildOutput(new Uint8Array(input), JSON.stringify(plan.buildUps), JSON.stringify(plan.factors));
          await saveFile.call(est, pricedName(file.name), out, XLSX);
          done.push(`${pricedName(file.name)}: ${plan.priced} of ${file.count} items priced${plan.paired < file.count ? ` (${file.count - plan.paired} not found in the file)` : ''}`);
          await new Promise((r) => setTimeout(r, 400));
        } catch (e) {
          problems.push(`${file.name}: ${e && e.message ? e.message : e}`);
        }
      }
    } catch (e) {
      problems.push(e && e.message ? e.message : String(e));
    }
    const skipped = merged.files.filter((f) => f.type !== 'XLSX' && f.count > 0).map((f) => `${f.name}: not an Excel BOQ, its items are only in the combined BOQ`);
    notice(`<b>${esc(what)}</b><br>${done.length ? `Saved ${done.length} file${done.length > 1 ? 's' : ''}, each the client's workbook unchanged with the rate columns added:${list(done)}` : ''}` +
      `${problems.length || skipped.length ? `<br>Not written:${list([...problems, ...skipped])}` : ''}` +
      `${done.length > 1 ? '<br>If the browser asks, allow this site to download several files.' : ''}`);
  }

  est.saveFile = function (name, bytes, mime) {
    const result = saveFile.apply(est, arguments);
    if (/\.xlsx$/i.test(String(name)) && bytes && bytes.length < 40 * 1024 * 1024) {
      const copy = new Uint8Array(bytes);
      Promise.resolve(result).then((r) => { if (r !== 'cancelled') writeEach(copy); }, () => {});
    }
    return result;
  };

  // For "Compute with AI Agent" (agent-button.js): the client files behind the merged BOQ the
  // app built, as [{ name, bytes }], or null to send the merged BOQ as it is.
  async function agentFiles(bytes) {
    let merged;
    try { merged = await mergedBoq(bytes); } catch (_) { return null; }
    if (!merged || merged.mismatch) return null;
    if (merged.files.some((f) => f.type !== 'XLSX' && f.count > 0)) return null; // drawings or PDFs: only the merged BOQ has their items
    const asked = { yes: false };
    const inputs = await originals(merged, 'AI agent: one priced workbook per BOQ file', asked);
    if (asked.yes && box) box.style.display = 'none';
    return inputs && inputs.map(({ file, bytes: b }) => ({ name: file.name, bytes: b }));
  }

  const CORE_SRC = 'core/estimation_core.v-568f5c32fa.js';
  root.estimationBoqFiles = Object.assign(api, { agentFiles, loadCore });
})(typeof window !== 'undefined' ? window : globalThis);
