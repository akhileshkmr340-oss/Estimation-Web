// The "AI Pricing Agent" button of the Estimation website. Shown to logged-in users at the
// bottom right; it opens the agent (agent/index.html, same site so the same login) in a
// panel over the app, and shows the progress of a running job on the button itself:
// "AI pricing · 186/214 · about 4 min left", then "Priced: download". The agent runs on
// Firebase Functions; this file only asks for the user's recent jobs (agentJobs).
(function () {
  'use strict';

  const FUNCTIONS = 'https://us-central1-estimation-6fa32.cloudfunctions.net/';
  if (!window.estimationAuth || !window.estimationAuth.configured()) return;

  const css = `
  #ai-agent-btn { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; display: none;
    font: 600 14px/1.2 system-ui, "Segoe UI", sans-serif; color: #fff; background: #1a56db; border: 0;
    border-radius: 22px; padding: 11px 18px 11px 14px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25);
    align-items: center; gap: 8px; max-width: calc(100vw - 36px); }
  #ai-agent-btn:hover { background: #1747b5; }
  #ai-agent-btn svg { flex: none; }
  #ai-agent-btn .ai-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #ai-agent-btn .ai-bar { position: absolute; left: 14px; right: 14px; bottom: 5px; height: 3px; border-radius: 2px;
    background: rgba(255,255,255,.3); overflow: hidden; display: none; }
  #ai-agent-btn .ai-bar > i { display: block; height: 100%; width: 0; background: #fff; transition: width .5s; }
  #ai-agent-btn.ai-done { background: #107c41; }
  #ai-agent-panel { position: fixed; inset: 0; z-index: 2147483001; display: none; background: rgba(0,0,0,.35); }
  #ai-agent-panel .ai-box { position: absolute; inset: 24px; max-width: 920px; margin: 0 auto; background: #f7f9fc;
    border-radius: 14px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
  #ai-agent-panel header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px;
    background: #1a56db; color: #fff; font: 600 16px system-ui, "Segoe UI", sans-serif; }
  #ai-agent-panel header button { background: none; border: 0; color: #fff; font-size: 26px; line-height: 1; cursor: pointer; padding: 0 4px; }
  #ai-agent-panel iframe { flex: 1; border: 0; width: 100%; background: #f7f9fc; }
  @media (max-width: 600px) { #ai-agent-panel .ai-box { inset: 0; border-radius: 0; } }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) #ai-agent-panel .ai-box,
    :root:not([data-theme="light"]) #ai-agent-panel iframe { background: #111418; } }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2l1.8 4.9L19 8.7l-4.1 3.2 1.4 5.1L12 14.2 7.7 17l1.4-5.1L5 8.7l5.2-1.8z" fill="currentColor"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" fill="currentColor" opacity=".8"/></svg>';
  const btn = document.createElement('button');
  btn.id = 'ai-agent-btn';
  btn.type = 'button';
  btn.title = 'Price a client BOQ with the AI pricing agent';
  btn.innerHTML = icon + '<span class="ai-text">AI Pricing Agent</span><span class="ai-bar"><i></i></span>';
  document.body.appendChild(btn);
  const text = btn.querySelector('.ai-text');
  const bar = btn.querySelector('.ai-bar');
  const fill = bar.querySelector('i');

  const panel = document.createElement('div');
  panel.id = 'ai-agent-panel';
  panel.innerHTML = '<div class="ai-box" role="dialog" aria-label="AI Pricing Agent"><header><span>AI Pricing Agent</span>' +
    '<button type="button" aria-label="Close">&times;</button></header></div>';
  document.body.appendChild(panel);
  const box = panel.querySelector('.ai-box');
  let frame = null;
  let frameReady = false;
  let pending = null; // a pricing request waiting for the panel page to load

  function open() {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.title = 'AI Pricing Agent';
      frame.src = 'agent/';
      frame.addEventListener('load', () => { frameReady = true; send(); });
      box.appendChild(frame);
    }
    panel.style.display = 'block';
  }
  function send() {
    if (!pending || !frameReady || !frame.contentWindow) return;
    frame.contentWindow.postMessage(pending, location.origin);
    pending = null;
  }
  function toBase64(bytes) {
    // A dropped file can come as an ArrayBuffer, a chosen one as a Uint8Array.
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // For the app (Dart, through js_interop): open the panel, or open it and start pricing
  // a BOQ workbook the app has just built (a Uint8Array of .xlsx bytes). When that BOQ merges
  // several client .xlsx files, each file goes as its own job instead (boq-files.js), so each
  // comes back as its own workbook, kept as the client sent it.
  // The project page that is open (set by the app), for filing jobs in Google Drive.
  let project = null;
  window.estimationAgent = {
    open() { open(); },
    setProject(name) { project = name ? String(name) : null; },
    async price(fileName, bytes, forProject) {
      const proj = forProject ? String(forProject) : project;
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      // A BOQ the app read from tender documents goes to the 7-step tender process instead.
      let tender = null;
      try { tender = await tenderOf(u8, String(fileName || '')); } catch (_) { tender = null; }
      if (tender) { toTender(tender, proj); return; }
      let files = null;
      try { files = window.estimationBoqFiles ? await window.estimationBoqFiles.agentFiles(u8) : null; } catch (_) { files = null; }
      pending = files && files.length
        ? { type: 'estimation-agent-price', project: proj, files: files.map((f) => ({ fileName: f.name, data: toBase64(f.bytes) })) }
        : { type: 'estimation-agent-price', project: proj, fileName: String(fileName || 'BOQ.xlsx'), data: toBase64(u8) };
      open();
      send();
    },
  };
  // ---- Tender documents chosen in the app go through the 7-step tender process ----
  // The app reads every file it is given into one BOQ and prices it from the rate list. That is
  // right for client BOQs and drawings, but a tender's specifications are not a BOQ: read that
  // way they give lines such as "Design maximum wind velocity" with no rate, and the offer skips
  // the tender process (tender details, BOQ check, supplier enquiries, technical documents,
  // costing and its check, technical and commercial offers). So when the app prices or saves
  // a BOQ or offer made from specifications, the original files go to the agent's tender job.
  const est = window.estimation;
  const chosen = new Map(); // file name -> bytes of every file chosen or dropped in the app
  const TENDER_FILE = /\.(pdf|docx|xlsx|xls)$/i;
  // Drawings (an SLD, a layout) belong to a tender but are not one by themselves; a drawing PDF
  // alone is the app's own quantity take-off.
  const DRAWING_NAME = /(^|[^a-z])(sld|ga|gad|drg|dwg|dxf|layout|schematic|elevation|plan)(?![a-z])|single[\s_-]*line/i;
  const SPEC_NAME = /spec|tender|scope|rfp|rfq|(^|[^a-z])nit(?![a-z])|bid|volume|(^|[^a-z])vol(?![a-z])|conditions|enquiry|inquiry|technical|requirement|datasheet|data sheet/i;
  const BOQ_NAME = /boq|bill[\s_-]*of[\s_-]*quantit|price[\s_-]*schedule|schedule[\s_-]*of[\s_-]*(rates|prices)/i;
  const SPEC_WORDS = /scope of work|technical specification|the contractor shall|the bidder|bidders|tenderer|general conditions|instructions to|shall be provided|shall conform|shall comply|shall be suitable/gi;
  function remember(list) {
    let total = 0;
    for (const f of list || []) {
      if (!(f && f.name && f.bytes && TENDER_FILE.test(f.name))) continue;
      chosen.set(String(f.name), f.bytes);
      // The app gets its own copy: it may hand its bytes on to a worker, which empties them
      // everywhere they are shared, and the original is needed later (the client's own workbook).
      if (f.bytes instanceof Uint8Array) f.bytes = f.bytes.slice();
    }
    // Keep at most about 300 MB, dropping the files chosen first.
    for (const [n, b] of [...chosen].reverse()) { total += b.length; if (total > 300 * 1024 * 1024) chosen.delete(n); }
    return list;
  }
  if (est) {
    const pickFiles = est.pickFiles;
    const takeDropped = est.takeDropped;
    est.pickFiles = (...a) => Promise.resolve(pickFiles.apply(est, a)).then(remember).then(atUpload);
    est.takeDropped = (...a) => remember(takeDropped.apply(est, a));
  }

  // Files chosen in the app: tender documents are offered the 7 steps at once, before the app
  // reads them as BOQ lines (the user, 2026-11-23: "website must follow the defined process for
  // tender working"). "Run the 7 steps" opens the agent's Tender form with every file chosen, and
  // the app gets none; "Read them in the app anyway" leaves them to the app.
  async function atUpload(list) {
    const names = (list || []).map((f) => f && f.name).filter((n) => n && TENDER_FILE.test(n));
    if (!names.length) return list;
    const specs = [];
    try { for (const n of names) if (await isSpec(n, chosen.get(n))) specs.push(n); } catch (_) { return list; }
    const key = specs.slice().sort().join('|');
    if (!specs.length) return sldOffer(list, names);
    if (decided.has(key)) return list;
    const go = await ask(`<b>These are tender documents</b><br>${specs.length > 1 ? 'These specifications go' : 'This specification goes'} through your 7 steps in the AI agent:` +
      `<ul>${specs.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` +
      'tender details, BOQ made and checked, supplier enquiry drafts, technical documents, costing with its check, and separate technical and commercial offers. The app itself would read them as BOQ lines and price them only from your rate list.',
      [{ label: 'Run the 7 steps', value: 'tender', main: true }, { label: 'Read them in the app anyway', value: 'app' }]);
    if (!go) return list;
    decided.add(key);
    if (go === 'tender') {
      toTender({ names, specs }, project);
      return [];
    }
    return list;
  }

  // SLD drawings chosen without a specification: the app's own reading gives a quantity
  // take-off, not an offer (the user, 2026-11-27: "arzimate is unable to read and prepare the
  // offer for attached SLD"). The AI agent reads every board and feeder and prices the offer.
  async function sldOffer(list, names) {
    const slds = [];
    try { for (const n of names) if (await isSld(n, chosen.get(n))) slds.push(n); } catch (_) { return list; }
    const key = `sld:${slds.slice().sort().join('|')}`;
    if (!slds.length || decided.has(key)) return list;
    const go = await ask(`<b>${slds.length > 1 ? 'These are SLD drawings' : 'This is an SLD drawing'}</b><br>The AI agent reads every board and its feeders from ${slds.length > 1 ? 'them' : 'it'}:` +
      `<ul>${slds.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` +
      'you check the boards it found, then it prices each board and writes the offer with the BOQ, costing and technical and commercial offers. The app itself only reads the drawings into BOQ lines.',
      [{ label: 'Prepare the offer in the AI agent', value: 'tender', main: true }, { label: 'Read them in the app', value: 'app' }]);
    if (!go) return list;
    decided.add(key);
    if (go === 'tender') {
      toTender({ names, specs: slds }, project);
      return [];
    }
    return list;
  }
  // An SLD: named so, or a drawing sheet (A3 or larger, a few pages) whose text names switchgear.
  const SLD_FILE = /(^|[^a-z])sld(?![a-z])|single[\s_-]*line/i;
  const GEAR = /\b(ACB|MCCB|MCB|VCB|RMU|SFU|busbar|bus\s*bar|bus\s*duct|incomer|outgoing|feeder)\b/gi;
  async function isSld(name, bytes) {
    if (!/\.pdf$/i.test(name)) return false;
    if (SLD_FILE.test(name)) return true;
    if (!bytes) return false;
    let sld = false;
    try {
      const lib = await loadPdf();
      const doc = await lib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
      if (doc.numPages <= 10) {
        for (let p = 1; p <= doc.numPages && !sld; p++) {
          const page = await doc.getPage(p);
          const v = page.getViewport({ scale: 1 });
          if (Math.max(v.width, v.height) <= 1150) continue;
          const text = (await page.getTextContent()).items.map((it) => it.str || '').join(' ');
          sld = (text.match(GEAR) || []).length >= 8;
        }
      }
      await doc.destroy();
    } catch (_) { /* unreadable here: not offered */ }
    return sld;
  }

  let pdfjs = null;
  function loadPdf() {
    pdfjs ||= import(new URL('pdfjs/pdf.min.js', document.baseURI).href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.js', document.baseURI).href;
      return lib;
    }).catch((e) => { pdfjs = null; throw e; });
    return pdfjs;
  }
  // True for a specification, scope or other written tender document; false for a BOQ or drawing.
  const kindCache = new Map();
  async function isSpec(name, bytes) {
    if (!/\.(pdf|docx?)$/i.test(name) || DRAWING_NAME.test(name)) return false;
    if (/\.docx?$/i.test(name)) return true; // a Word file in the app is a written specification or scope
    const byName = SPEC_NAME.test(name) && !BOQ_NAME.test(name);
    if (!bytes) return byName;
    if (kindCache.has(name)) return kindCache.get(name);
    let spec = byName;
    try {
      const lib = await loadPdf();
      const doc = await lib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
      let text = '';
      for (let p = 1; p <= Math.min(doc.numPages, 15); p++) {
        const content = await (await doc.getPage(p)).getTextContent();
        text += content.items.map((it) => it.str || '').join(' ') + '\n';
      }
      // At least two different phrases of a specification (a BOQ may say "as per specification").
      const said = new Set((text.match(SPEC_WORDS) || []).map((w) => w.toLowerCase()));
      spec = spec || said.size >= 2;
      await doc.destroy();
    } catch (_) { /* unreadable here: the name decides */ }
    kindCache.set(name, spec);
    return spec;
  }

  // The file names in the "Sources" sheet of a workbook the app wrote, or null.
  async function sourcesOf(xlsx) {
    const read = window.estimationBoqFiles && window.estimationBoqFiles.readWorkbook;
    if (!read) return null;
    const wb = await read(xlsx);
    if (!wb.names.includes('Sources')) return null;
    const cells = await wb.sheet('Sources');
    const text = (c) => (c && c.v != null ? String(c.v).trim() : '');
    for (let r = 1; r <= 12; r++) {
      let fileCol = null;
      for (const k of Object.keys(cells)) {
        const m = /^([A-Z]+)(\d+)$/.exec(k);
        if (m && Number(m[2]) === r && text(cells[k]).toLowerCase() === 'file') fileCol = m[1];
      }
      if (!fileCol) continue;
      const names = [];
      for (let row = r + 1; row <= r + 500; row++) {
        const n = text(cells[`${fileCol}${row}`]);
        if (!n) break;
        names.push(n);
      }
      return names;
    }
    return null;
  }

  // The files of a zip (an offer package): { name: () => Promise<Uint8Array> }.
  function zipEntries(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let end = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) return {};
    const out = {};
    let p = dv.getUint32(end + 16, true);
    for (let n = dv.getUint16(end + 10, true); n > 0 && dv.getUint32(p, true) === 0x02014b50; n--) {
      const method = dv.getUint16(p + 10, true);
      const size = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      out[name] = async () => {
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        const raw = u8.subarray(start, start + size);
        if (method !== 8) return raw;
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      };
      p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return out;
  }

  // For a file the app made (a BOQ or costing workbook, an offer package, an offer in Word):
  // { names, specs } when it was made from tender documents, else null. `names` are the
  // tender's files to send (specifications, BOQs, drawings), `specs` the specifications.
  async function tenderOf(u8, name) {
    let sources = null;
    if (/\.xlsx$/i.test(name)) sources = await sourcesOf(u8);
    else if (/\.zip$/i.test(name)) {
      const zip = zipEntries(u8);
      for (const n of Object.keys(zip)) {
        if (!/\.xlsx$/i.test(n)) continue;
        sources = await sourcesOf(await zip[n]());
        if (sources) break;
      }
    } else if (/\.docx$/i.test(name)) sources = [...chosen.keys()]; // an offer in Word: the files chosen in the app
    if (!sources) return null;
    const names = sources.filter((n) => TENDER_FILE.test(n));
    const specs = [];
    for (const n of names) if (await isSpec(n, chosen.get(n))) specs.push(n);
    return specs.length ? { names, specs } : null;
  }

  // Opens the agent's Tender form with the tender's files; the person adds the rest and starts.
  function toTender(t, proj) {
    pending = {
      type: 'estimation-agent-tender',
      project: proj,
      title: proj || t.specs[0].replace(/\.[a-z]+$/i, ''),
      files: t.names.filter((n) => chosen.has(n)).map((n) => ({ fileName: n, bytes: chosen.get(n) })),
      missing: t.names.filter((n) => !chosen.has(n)),
    };
    open();
    send();
  }

  // A notice before the app saves a BOQ, costing or offer made from tender documents.
  let note = null;
  function ask(html, buttons) {
    if (!note) {
      const s = document.createElement('style');
      s.textContent = `#ai-tender{position:fixed;left:18px;bottom:18px;z-index:2147483002;max-width:min(520px,calc(100vw - 36px));
        background:#fff;color:#1b1f24;border:1px solid #d0d7de;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);
        font:14px/1.45 system-ui,"Segoe UI",sans-serif;padding:14px 16px}#ai-tender b{font-weight:600}
        #ai-tender ul{margin:6px 0 0;padding-left:18px;max-height:140px;overflow:auto}
        #ai-tender .row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}
        #ai-tender button{font:600 13px system-ui,"Segoe UI",sans-serif;border-radius:8px;padding:7px 12px;cursor:pointer;border:1px solid #d0d7de;background:#f6f8fa;color:#1b1f24}
        #ai-tender button.main{background:#1a56db;border-color:#1a56db;color:#fff}
        @media (prefers-color-scheme:dark){#ai-tender{background:#1c2128;color:#e6edf3;border-color:#30363d}
        #ai-tender button{background:#2d333b;color:#e6edf3;border-color:#444c56}}`;
      document.head.appendChild(s);
      note = document.createElement('div');
      note.id = 'ai-tender';
      note.setAttribute('role', 'alertdialog');
      document.body.appendChild(note);
    }
    note.innerHTML = html;
    note.style.display = 'block';
    return new Promise((resolve) => {
      const row = document.createElement('div');
      row.className = 'row';
      for (const b of buttons) {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = b.label;
        if (b.main) el.className = 'main';
        el.onclick = () => { note.style.display = 'none'; resolve(b.value); };
        row.appendChild(el);
      }
      note.appendChild(row);
    });
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---- "3. Tender" and "4. Specification" in the app: paste or attach, then the 7 steps ----
  // The user (2026-11-23): "when specification is chosen then it also have option to past the
  // specification with no word limit or with attachment option". The app (compiled Flutter, no
  // source here) draws its own screens, so this panel sits beside them. Which of the four input
  // types was chosen is read from the app's accessibility tree (its cards are buttons there,
  // "3. Tender ...", "4. Specification ..."), switched on for project pages only.
  let docType = '';
  let panel2 = null;
  let panelClosed = false;
  const onProject = () => /^#\/p\//.test(location.hash);
  function semanticsOn() {
    if (document.querySelector('flt-semantics')) return;
    const ph = document.querySelector('flt-semantics-placeholder');
    if (ph) ph.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
  function typeAt(x, y) {
    for (const n of document.querySelectorAll('flt-semantics[role="button"]')) {
      const m = /^\s*\d\.\s*(BOQ|SLD|Tender|Specification)\b/.exec(n.textContent || '');
      if (!m) continue;
      const r = n.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return m[1].toLowerCase();
    }
    return null;
  }
  document.addEventListener('pointerup', (e) => {
    if (!onProject()) return;
    semanticsOn();
    const t = typeAt(e.clientX, e.clientY);
    if (t === null) return;
    docType = t;
    panelClosed = false;
    showPanel();
  }, true);
  window.addEventListener('hashchange', () => {
    if (onProject()) setTimeout(semanticsOn, 1500);
    else docType = '';
    showPanel();
  });
  if (onProject()) setTimeout(semanticsOn, 3000);

  const words = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
  function showPanel() {
    const want = onProject() && (docType === 'specification' || docType === 'tender');
    if (!want) { if (panel2) panel2.style.display = 'none'; return; }
    if (!panel2) {
      const s = document.createElement('style');
      s.textContent = `#ai-spec{position:fixed;right:18px;bottom:72px;z-index:2147483000;width:min(420px,calc(100vw - 36px));
        background:#fff;color:#1b1f24;border:1px solid #d0d7de;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);
        font:14px/1.45 system-ui,"Segoe UI",sans-serif;padding:12px 14px}
        #ai-spec .head{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:6px}
        #ai-spec .head button{background:none;border:0;font-size:20px;line-height:1;cursor:pointer;color:inherit;padding:0 4px}
        #ai-spec textarea{width:100%;box-sizing:border-box;min-height:140px;max-height:45vh;resize:vertical;font:13px/1.45 inherit;border:1px solid #d0d7de;border-radius:8px;padding:8px}
        #ai-spec .hint{color:#57606a;font-size:12px;margin:4px 0}
        #ai-spec ul{margin:4px 0;padding-left:18px;max-height:90px;overflow:auto;font-size:12px}
        #ai-spec .row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px;flex-wrap:wrap}
        #ai-spec .row button{font:600 13px system-ui,"Segoe UI",sans-serif;border-radius:8px;padding:7px 12px;cursor:pointer;border:1px solid #d0d7de;background:#f6f8fa;color:#1b1f24}
        #ai-spec .row button.main{background:#1a56db;border-color:#1a56db;color:#fff}
        #ai-spec.min textarea,#ai-spec.min .body{display:none}
        @media (prefers-color-scheme:dark){#ai-spec{background:#1c2128;color:#e6edf3;border-color:#30363d}
        #ai-spec textarea{background:#0d1117;color:#e6edf3;border-color:#30363d}#ai-spec .hint{color:#8b949e}
        #ai-spec .row button{background:#2d333b;color:#e6edf3;border-color:#444c56}}`;
      document.head.appendChild(s);
      panel2 = document.createElement('div');
      panel2.id = 'ai-spec';
      panel2.innerHTML = '<div class="head"><span class="title"></span><button type="button" title="Hide" aria-label="Hide">&times;</button></div>' +
        '<div class="body"><textarea placeholder="Paste the specification or scope here: clauses, ratings, quantities, makes... (no word limit)"></textarea>' +
        '<div class="hint count">No word limit: a long specification is read in parts.</div>' +
        '<div class="row" style="justify-content:flex-start;margin-top:4px"><button type="button" class="attach">Attach files</button></div>' +
        '<input type="file" multiple accept=".pdf,.docx,.xlsx,.xls" style="display:none"><ul class="files"></ul>' +
        '<div class="hint">Tender work follows your 7 steps in the AI agent: tender details, BOQ made and checked, supplier enquiry drafts, technical documents, costing with its check, and separate technical and commercial offers.</div>' +
        '<div class="row"><button type="button" class="app">Add to this project</button><button type="button" class="main run">Run the 7 steps</button></div>' +
        '<div class="hint err" style="color:#cf222e"></div></div>';
      document.body.appendChild(panel2);
      const ta = panel2.querySelector('textarea');
      const input = panel2.querySelector('input[type=file]');
      const attached = [];
      const list = () => { panel2.querySelector('.files').innerHTML = attached.map((f) => `<li>${esc(f.name)}</li>`).join(''); };
      ta.addEventListener('input', () => {
        const n = words(ta.value);
        panel2.querySelector('.count').textContent = n ? `${n.toLocaleString('en-IN')} words, ${ta.value.trim().length.toLocaleString('en-IN')} characters. No word limit.` : 'No word limit: a long specification is read in parts.';
      });
      panel2.querySelector('.attach').onclick = () => input.click();
      input.onchange = async () => {
        for (const f of input.files) attached.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        input.value = '';
        list();
      };
      panel2.querySelector('.head button').onclick = () => { panelClosed = true; panel2.style.display = 'none'; };
      const err = (t) => { panel2.querySelector('.err').textContent = t; };
      // The 7 steps: the agent's Tender form, with the text pasted and the files attached here.
      panel2.querySelector('.run').onclick = () => {
        const text = ta.value.trim();
        if (!text && !attached.length) return err('Paste the specification or attach the files first.');
        err('');
        pending = {
          type: 'estimation-agent-tender',
          project,
          title: project || (attached[0] ? attached[0].name.replace(/\.[a-z]+$/i, '') : 'Specification'),
          files: attached.map((f) => ({ fileName: f.name, bytes: f.bytes })),
          missing: [],
          pasted: text,
        };
        open();
        send();
      };
      // The app's own reading: the text as a .txt file and the attachments, given to the app as
      // if dropped on it (estimation.js queues dropped files for the app).
      panel2.querySelector('.app').onclick = () => {
        const text = ta.value.trim();
        if (!text && !attached.length) return err('Paste the specification or attach the files first.');
        err('');
        const dt = new DataTransfer();
        if (text) dt.items.add(new File([text], 'Pasted specification.txt', { type: 'text/plain' }));
        for (const f of attached) dt.items.add(new File([f.bytes], f.name));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      };
    }
    panel2.querySelector('.title').textContent = docType === 'tender' ? 'Tender: paste the specification or attach the files' : 'Specification: paste it or attach the files';
    panel2.style.display = panelClosed ? 'none' : 'block';
  }

  const decided = new Set(); // the specifications already asked about on this page
  if (est) {
    const saveFile = est.saveFile;
    est.saveFile = async function (name, bytes, mime) {
      const args = arguments;
      let t = null;
      if (/\.(xlsx|zip|docx)$/i.test(String(name)) && bytes && bytes.length < 60 * 1024 * 1024) {
        try { t = await tenderOf(new Uint8Array(bytes), String(name)); } catch (_) { t = null; }
      }
      const key = t ? t.specs.slice().sort().join('|') : '';
      if (!t || decided.has(key)) return saveFile.apply(est, args);
      const go = await ask(`<b>These are tender documents</b><br>The app read ${t.specs.length > 1 ? 'these specifications' : 'this specification'} as BOQ lines and priced ${t.specs.length > 1 ? 'them' : 'it'} only from your rate list:` +
        `<ul>${t.specs.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` +
        'A tender goes through your 7 steps in the AI agent: tender details, BOQ made and checked, supplier enquiry drafts, technical documents, costing with its check, and separate technical and commercial offers.',
        [{ label: 'Run the 7 steps', value: 'tender', main: true }, { label: 'Save the app\'s file anyway', value: 'save' }, { label: 'Cancel', value: null }]);
      if (go) decided.add(key); // asked once per page; Cancel asks again next time
      if (go === 'save') return saveFile.apply(est, args);
      if (go === 'tender') toTender(t, project);
      return 'cancelled';
    };
  }

  // ---- Every row priced in the app's own working (2026-11-25) ----
  // The user: "still the BOQ Unit price were empty in manual working. it was filled in compute
  // with AI. All the prices should be filled. Run all agents in background."
  // The app prices from the Rate_Database and leaves the other rows to its "Search the web" step
  // (Prices for rows not in your database), which runs only when the Sheet script has a Gemini
  // key. Here that step is answered by the AI pricing agent (agentRates, the same pricing as a
  // BOQ line: price book, the user's corrections, shops, AI): the Sheet's own web search still
  // runs where it is set up, and every row it leaves gets the agent's supply and installation
  // cost, marked "Estimate, confirm" with its basis on the Rates sheet. The step starts by itself
  // once the rates are matched, and works in the background while the person carries on.
  const authApi = window.estimationAuth;
  const rfq0 = authApi.rfq;
  let sheetSearch = false; // the Sheet script searches the web itself
  const RATE_BATCH = 3; // rows per call, as a job's batches
  const RATES_AT_ONCE = 4; // calls side by side
  const rates = new Map(); // row id -> Promise of { supply, service, basis } or null
  const rateQueue = [];
  let ratesRunning = 0;
  async function callRates(items) {
    const current = window.firebase && window.firebase.auth().currentUser;
    if (!current) throw new Error('Log in to price the rows.');
    let res;
    try {
      res = await fetch(FUNCTIONS + 'agentRates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await current.getIdToken()) },
        body: JSON.stringify({ data: { items } }),
      });
    } catch (_) {
      throw new Error('The AI pricing agent did not answer. Check the internet and try again.');
    }
    let d = null;
    try { d = await res.json(); } catch (_) { d = null; }
    if (d && d.error) throw new Error(d.error.message || 'The AI pricing agent refused the request.');
    if (!d || !d.result) throw new Error('The AI pricing agent gave an unexpected answer (' + res.status + ').');
    return d.result;
  }
  function pumpRates() {
    while (ratesRunning < RATES_AT_ONCE && rateQueue.length) {
      const batch = rateQueue.splice(0, RATE_BATCH);
      ratesRunning++;
      callRates(batch.map((b) => b.item))
        .then((r) => {
          const by = new Map((r.estimates || []).map((e) => [String(e.id), e]));
          for (const b of batch) b.resolve(by.get(b.item.id) || null);
        }, (e) => { for (const b of batch) b.reject(e); })
        .finally(() => { ratesRunning--; pumpRates(); });
    }
  }
  function agentRate(item) {
    const id = String((item && item.id) || '');
    if (!id) return Promise.resolve(null);
    let p = rates.get(id);
    if (!p) {
      const row = { id, description: item.description, rating: item.rating, uom: item.uom, context: item.context, brand: item.brand };
      p = new Promise((resolve, reject) => rateQueue.push({ item: row, resolve, reject }));
      rates.set(id, p);
      p.then((v) => { if (!v) rates.delete(id); }, () => rates.delete(id)); // asked again next time
      pumpRates();
    }
    return p;
  }
  if (authApi && typeof rfq0 === 'function') {
    authApi.rfq = async function (action, json) {
      if (action === 'priceSearchStatus') {
        let st = {};
        try { st = JSON.parse(await rfq0.call(authApi, action, json)) || {}; } catch (_) { st = {}; }
        sheetSearch = st.allowed === true && (st.gemini === true || st.google === true || st.chatgpt === true);
        // The step is on for every signed-in account: the agent prices, not the Sheet's keys.
        return JSON.stringify(Object.assign({}, st, { allowed: true, gemini: true, agent: true }));
      }
      if (action !== 'searchPrices') return rfq0.call(authApi, action, json);
      let q = {};
      try { q = JSON.parse(json) || {}; } catch (_) { q = {}; }
      const items = Array.isArray(q.items) ? q.items : [];
      const checked = new Date().toISOString().slice(0, 10);
      if (!q.estimate) {
        // The web search: the Sheet's own where it has one; otherwise none, and the agent starts
        // on these rows now, so their rates are ready when the app asks for them.
        if (sheetSearch) {
          try { return await rfq0.call(authApi, action, json); } catch (_) { /* the agent prices them */ }
        }
        for (const it of items) agentRate(it).catch(() => {});
        return JSON.stringify({ checked, results: items.map((it) => ({ id: it.id, candidates: [] })), errors: [] });
      }
      const got = await Promise.allSettled(items.map(agentRate));
      const estimates = [];
      let error = null;
      got.forEach((g, i) => {
        if (g.status === 'fulfilled' && g.value && g.value.supply != null) estimates.push({ id: items[i].id, supply: g.value.supply, service: g.value.service, basis: g.value.basis });
        else if (g.status === 'rejected') error = g.reason;
      });
      if (!estimates.length && error) throw error;
      return JSON.stringify({ checked, estimates });
    };
  }

  // The step starts by itself: its button ("Search the web for 12 rows") is pressed once for each
  // project and count, through the app's accessibility tree (on for project pages, above).
  const autoSearched = new Set();
  function autoSearch() {
    if (!onProject() || !user) return;
    for (const n of document.querySelectorAll('flt-semantics[role="button"]')) {
      const m = /^\s*Search the web for (\d+) rows?\b/.exec(n.textContent || '');
      if (!m || n.getAttribute('aria-disabled') === 'true') continue;
      const key = location.hash.split('?')[0] + '|' + m[1];
      if (autoSearched.has(key)) continue;
      autoSearched.add(key);
      n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  }
  setInterval(autoSearch, 2500);

  // The app labels these rates "Estimate by Gemini with Google Search: ..." in the workbooks it
  // saves; they are the agent's, so the label says so.
  const AGENT_LABEL = /Estimate by Gemini with Google Search: (AI pricing agent)/g;
  let crcTable = null;
  function crc32(u8) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  async function deflate(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // The same zip with some files' contents replaced ({ name: Uint8Array }); the others are
  // copied byte for byte.
  async function rezip(u8, changed) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let end = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) return null;
    const cdStart = dv.getUint32(end + 16, true);
    const entries = [];
    let p = cdStart;
    for (let n = dv.getUint16(end + 10, true); n > 0 && dv.getUint32(p, true) === 0x02014b50; n--) {
      const nameLen = dv.getUint16(p + 28, true);
      const len = 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
      entries.push({ cd: p, cdLen: len, nameLen, local: dv.getUint32(p + 42, true), name: new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen)) });
      p += len;
    }
    const byOffset = entries.slice().sort((a, b) => a.local - b.local);
    byOffset.forEach((e, i) => { e.end = i + 1 < byOffset.length ? byOffset[i + 1].local : cdStart; });
    const parts = [];
    const central = [];
    let at = 0;
    for (const e of byOffset) {
      const offset = at;
      const nameBytes = u8.subarray(e.cd + 46, e.cd + 46 + e.nameLen);
      let cdRec;
      if (changed[e.name]) {
        const data = changed[e.name];
        const comp = await deflate(data);
        const crc = crc32(data);
        const flags = dv.getUint16(e.cd + 8, true) & 0x0800; // keep only the UTF-8 name flag
        const head = new Uint8Array(30 + e.nameLen);
        const h = new DataView(head.buffer);
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, flags, true); h.setUint16(8, 8, true);
        h.setUint16(10, dv.getUint16(e.cd + 12, true), true); h.setUint16(12, dv.getUint16(e.cd + 14, true), true);
        h.setUint32(14, crc, true); h.setUint32(18, comp.length, true); h.setUint32(22, data.length, true);
        h.setUint16(26, e.nameLen, true); h.setUint16(28, 0, true);
        head.set(nameBytes, 30);
        parts.push(head, comp);
        at += head.length + comp.length;
        cdRec = new Uint8Array(46 + e.nameLen);
        cdRec.set(u8.subarray(e.cd, e.cd + 46), 0);
        const c = new DataView(cdRec.buffer);
        c.setUint16(8, flags, true); c.setUint16(10, 8, true); c.setUint32(16, crc, true);
        c.setUint32(20, comp.length, true); c.setUint32(24, data.length, true);
        c.setUint16(30, 0, true); c.setUint16(32, 0, true);
        cdRec.set(nameBytes, 46);
      } else {
        const chunk = u8.subarray(e.local, e.end);
        parts.push(chunk);
        at += chunk.length;
        cdRec = u8.slice(e.cd, e.cd + e.cdLen);
      }
      new DataView(cdRec.buffer).setUint32(42, offset, true);
      central.push({ i: entries.indexOf(e), rec: cdRec });
    }
    central.sort((a, b) => a.i - b.i);
    const cdAt = at;
    let cdSize = 0;
    for (const c of central) { parts.push(c.rec); cdSize += c.rec.length; }
    const eocd = u8.slice(end, u8.length);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdAt, true);
    parts.push(eocd);
    return new Uint8Array(await new Blob(parts).arrayBuffer());
  }
  // The app's own workbook: on its Rates sheet a priced row's Discount % is written as a plain 0,
  // so the "Discount % on list prices" cell at the top of the BOQ sheet changed nothing (the user,
  // 2026-11-27: "discounted % is not calculating in sheet"). Every Discount % cell that holds the
  // same value as that top cell becomes a link to it; a discount typed for one item stays.
  const xmlText = (cell) => {
    const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell);
    return t ? t[1] : '';
  };
  const cellsOf = (xml) => [...xml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((m) => ({ all: m[0], col: m[1], row: Number(m[2]), attrs: m[3], body: m[4] || '' }));
  async function sheetPaths(zip) {
    if (!zip['xl/workbook.xml'] || !zip['xl/_rels/workbook.xml.rels']) return {};
    const wb = new TextDecoder().decode(await zip['xl/workbook.xml']());
    const rels = new TextDecoder().decode(await zip['xl/_rels/workbook.xml.rels']());
    const target = {};
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /Id="([^"]+)"/.exec(m[0]);
      const t = /Target="([^"]+)"/.exec(m[0]);
      if (id && t) target[id[1]] = t[1].startsWith('/') ? t[1].slice(1) : `xl/${t[1].replace(/^\.?\//, '')}`;
    }
    const out = {};
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const name = /name="([^"]*)"/.exec(m[0]);
      const rid = /r:id="([^"]+)"/.exec(m[0]);
      if (name && rid && target[rid[1]]) out[name[1]] = target[rid[1]];
    }
    return out;
  }
  async function linkDiscounts(zip, texts) {
    const paths = await sheetPaths(zip);
    if (!paths.BOQ || !paths.Rates || !zip[paths.BOQ] || !zip[paths.Rates]) return null;
    const boq = texts[paths.BOQ] || new TextDecoder().decode(await zip[paths.BOQ]());
    const head = cellsOf(boq).find((c) => /^Discount % on list prices/.test(xmlText(c.body)));
    if (!head) return null;
    const top = cellsOf(boq).find((c) => c.col === head.col && c.row === head.row + 1);
    const topValue = top ? Number((/<v>([^<]*)<\/v>/.exec(top.body) || [])[1] || 0) : 0;
    const ref = `'BOQ'!$${head.col}$${head.row + 1}`;
    let rates = texts[paths.Rates] || new TextDecoder().decode(await zip[paths.Rates]());
    const cells = cellsOf(rates);
    const dh = cells.find((c) => xmlText(c.body).trim() === 'Discount %');
    if (!dh) return null;
    let n = 0;
    for (const c of cells) {
      if (c.col !== dh.col || c.row <= dh.row || /<f>/.test(c.body) || /t="(s|inlineStr|str)"/.test(c.attrs)) continue;
      const v = /<v>([^<]*)<\/v>/.exec(c.body);
      if (!v || Number(v[1]) !== topValue) continue;
      rates = rates.replace(c.all, `<c r="${c.col}${c.row}"${c.attrs}><f>${ref.replace(/'/g, '&apos;')}</f><v>${v[1]}</v></c>`);
      n++;
    }
    if (!n) return null;
    // Excel works the linked cells out again when the file opens.
    let wbXml = new TextDecoder().decode(await zip['xl/workbook.xml']());
    wbXml = /<calcPr\b/.test(wbXml)
      ? wbXml.replace(/<calcPr\b([^>]*?)\/?>/, (m, a) => `<calcPr${a.replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`)
      : wbXml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
    return { rates: [paths.Rates, rates], workbook: wbXml };
  }
  async function relabel(u8) {
    const zip = zipEntries(u8);
    const changed = {};
    const texts = {};
    for (const name of Object.keys(zip)) {
      if (!/^xl\/(worksheets\/[^/]+|sharedStrings)\.xml$/.test(name)) continue;
      const xml = new TextDecoder().decode(await zip[name]());
      texts[name] = xml;
      if (!AGENT_LABEL.test(xml)) continue;
      AGENT_LABEL.lastIndex = 0;
      texts[name] = xml.replace(AGENT_LABEL, 'Estimate by the $1');
      changed[name] = new TextEncoder().encode(texts[name]);
    }
    AGENT_LABEL.lastIndex = 0;
    try {
      const linked = await linkDiscounts(zip, texts);
      if (linked) {
        changed[linked.rates[0]] = new TextEncoder().encode(linked.rates[1]);
        changed['xl/workbook.xml'] = new TextEncoder().encode(linked.workbook);
      }
    } catch (e) {
      console.warn('Discount links not added:', e);
    }
    return Object.keys(changed).length ? rezip(u8, changed) : null;
  }
  if (est) {
    const saveFile = est.saveFile;
    est.saveFile = async function (name, bytes) {
      const args = Array.prototype.slice.call(arguments);
      if (/\.xlsx$/i.test(String(name)) && bytes && bytes.length < 60 * 1024 * 1024) {
        try {
          const b = await relabel(new Uint8Array(bytes));
          if (b) args[1] = b;
        } catch (e) { console.warn('Rate labels not changed:', e); }
      }
      return saveFile.apply(est, args);
    };
  }

  // ---- A client's Excel BOQ comes back as the client's own workbook (2026-11-26) ----
  // The user: "do not change the file once input is BOQ just add below column. Deploy the Agents
  // for pricing search online for the price if price not available in database and save the
  // current price in database", and "BOQ may contain multiple sheet". When the app saves its
  // priced BOQ made from client Excel BOQs, each client workbook goes to the AI pricing agent
  // instead, with the rates the app found in the user's price database and the project's factors:
  // every sheet is read, database rates are kept, the other lines are priced (price book, online
  // shops, AI), and the workbook comes back as sent with only the factor row and the ten pricing
  // columns added ("<file> - priced.xlsx"). Prices found online are then saved in the user's price
  // database (the Sheet's addPrices). Jobs are remembered, so a reload picks them up again.
  const OWN = 'arzimate.ownBoqJobs';
  const ownJobs = () => { try { return JSON.parse(localStorage.getItem(OWN) || '{}') || {}; } catch (_) { return {}; } };
  const setOwnJobs = (m) => { try { localStorage.setItem(OWN, JSON.stringify(m)); } catch (_) {} };
  async function callFn(name, data) {
    const current = window.firebase && window.firebase.auth().currentUser;
    if (!current) throw new Error('Log in first.');
    const res = await fetch(FUNCTIONS + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await current.getIdToken()) },
      body: JSON.stringify({ data }),
    });
    let d = null;
    try { d = await res.json(); } catch (_) { d = null; }
    if (d && d.error) throw new Error(d.error.message || 'The AI pricing agent refused the request.');
    if (!d || !('result' in d)) throw new Error('The AI pricing agent gave an unexpected answer (' + res.status + ').');
    return d.result;
  }
  let ownBox = null;
  function tell(html) {
    if (!ownBox) {
      const s = document.createElement('style');
      s.textContent = `#ai-own{position:fixed;left:18px;bottom:18px;z-index:2147483002;max-width:min(520px,calc(100vw - 36px));
        background:#fff;color:#1b1f24;border:1px solid #d0d7de;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);
        font:14px/1.45 system-ui,"Segoe UI",sans-serif;padding:14px 16px}#ai-own b{font-weight:600}
        #ai-own ul{margin:6px 0 0;padding-left:18px;max-height:180px;overflow:auto}
        #ai-own .row{display:flex;justify-content:flex-end;margin-top:8px}
        #ai-own button{font:600 13px system-ui,"Segoe UI",sans-serif;border-radius:8px;padding:6px 12px;cursor:pointer;border:1px solid #d0d7de;background:#f6f8fa;color:#1b1f24}
        @media (prefers-color-scheme:dark){#ai-own{background:#1c2128;color:#e6edf3;border-color:#30363d}
        #ai-own button{background:#2d333b;color:#e6edf3;border-color:#444c56}}`;
      document.head.appendChild(s);
      ownBox = document.createElement('div');
      ownBox.id = 'ai-own';
      ownBox.setAttribute('role', 'status');
      document.body.appendChild(ownBox);
    }
    ownBox.innerHTML = html + '<div class="row"><button type="button">Close</button></div>';
    ownBox.querySelector('button').onclick = () => { ownBox.style.display = 'none'; };
    ownBox.style.display = 'block';
  }
  const ownState = {}; // jobId -> line of the notice
  function showOwn() {
    const ids = Object.keys(ownState);
    if (!ids.length) return;
    tell(`<b>Your BOQ as sent, with the pricing columns</b><ul>${ids.map((id) => `<li>${ownState[id]}</li>`).join('')}</ul>`);
  }
  // The rates the app took from the user's price database (not its computed or web estimates),
  // each with its heading where the line only names the work ("Supply & Installation").
  async function appRatesOf(u8, merged) {
    const bySection = new Map();
    try {
      const wb = await window.estimationBoqFiles.readWorkbook(u8);
      const cells = await wb.sheet('BOQ');
      const str = (c) => (c && c.v != null ? String(c.v).trim() : '');
      let head = null;
      for (let r = 1; r <= 12 && !head; r++) {
        const cols = {};
        for (const k of Object.keys(cells)) {
          const m = /^([A-Z]+)(\d+)$/.exec(k);
          if (m && Number(m[2]) === r) cols[str(cells[k]).toLowerCase()] = m[1];
        }
        if (cols['s. no.'] && cols['panel / section']) head = { row: r, no: cols['s. no.'], section: cols['panel / section'] };
      }
      if (head) {
        for (let r = head.row + 1; r <= head.row + 5000; r++) {
          const no = Number(str(cells[`${head.no}${r}`]));
          if (no) bySection.set(no, str(cells[`${head.section}${r}`]));
        }
      }
    } catch (_) { /* the headings only help the matching */ }
    const out = [];
    for (const it of merged.items || []) {
      if (it.cost == null && it.service == null) continue;
      if (/^computed|estimate|market|online|web|shop/i.test(it.source || '')) continue;
      const sec = bySection.get(it.no) || '';
      const d = String(it.description || '');
      const description = sec && d.length < 45 && !d.toLowerCase().includes(sec.toLowerCase()) ? `${sec} - ${d}` : d;
      out.push({ description, uom: it.uom, supply: it.cost, service: it.service, brand: it.brand, source: it.source });
    }
    return out;
  }
  async function startOwn(u8) {
    const api = window.estimationBoqFiles;
    if (!api || !api.mergedBoq || !api.agentFiles) return null;
    let merged = null;
    try { merged = await api.mergedBoq(u8); } catch (_) { merged = null; }
    if (!merged || merged.mismatch || !merged.files.length) return null;
    // Only client Excel BOQs; drawings, PDFs and tender documents keep the app's own workbook.
    if (merged.files.some((f) => f.count > 0 && f.type !== 'XLSX')) return null;
    try { for (const f of merged.files) if (await isSpec(f.name, chosen.get(f.name))) return null; } catch (_) { return null; }
    const inputs = await api.agentFiles(u8);
    if (!inputs || !inputs.length) return null;
    const appRates = await appRatesOf(u8, merged);
    const appFactors = merged.factors;
    const all = ownJobs();
    for (const f of inputs) {
      ownState[f.name] = `${esc(f.name)}: sending to the AI pricing agent...`;
      showOwn();
      try {
        const r = await callFn('agentStart', { fileName: f.name, data: toBase64(f.bytes), appRates, appFactors, margin: appFactors.supplyMargin });
        delete ownState[f.name];
        all[r.jobId] = { name: f.name, at: Date.now(), download: true };
        ownState[r.jobId] = `${esc(f.name)}: reading every sheet...`;
      } catch (e) {
        ownState[f.name] = `${esc(f.name)}: not sent (${esc(e.message || e)})`;
      }
      showOwn();
    }
    setOwnJobs(all);
    followOwn();
    return 'sent to the AI pricing agent';
  }
  let ownTimer = null;
  async function followOwn() {
    if (ownTimer) clearTimeout(ownTimer);
    ownTimer = null;
    const all = ownJobs();
    const ids = Object.keys(all);
    if (!ids.length || !(window.firebase && window.firebase.auth().currentUser)) return;
    let waiting = false;
    for (const id of ids) {
      const j = all[id];
      if (Date.now() - (j.at || 0) > 3 * 86400000) { delete all[id]; continue; }
      let v;
      try { v = await callFn('agentStatus', { jobId: id }); } catch (_) { waiting = true; continue; }
      if (v.status === 'failed' || v.status === 'cancelled') {
        ownState[id] = `${esc(j.name)}: ${v.status === 'failed' ? `could not be priced (${esc(v.error || 'error')})` : 'cancelled'}`;
        delete all[id];
        continue;
      }
      if (v.status !== 'done') {
        waiting = true;
        if (j.download) ownState[id] = `${esc(j.name)}: ${v.total ? `${v.done} of ${v.total} lines priced` : esc((v.columns && v.columns.stage) || 'reading every sheet')}...`;
        continue;
      }
      try {
        const r = await callFn('agentResult', { jobId: id });
        if (j.download && r.data) {
          const bin = atob(r.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          await ownSave.call(est, r.fileName || `${j.name.replace(/\.xlsx$/i, '')} - priced.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        }
        const src = r.priceSources || {};
        const said = [src.database ? `${src.database} from your price database` : '', src.records ? `${src.records} from your past rates` : '', src.online ? `${src.online} online prices` : '', src.estimate ? `${src.estimate} AI estimates (marked to confirm)` : '', src.unpriced ? `${src.unpriced} still need a rate` : ''].filter(Boolean).join(', ');
        let saved = '';
        const rows = Array.isArray(r.dbAdd) ? r.dbAdd : [];
        if (rows.length) {
          try {
            const a = JSON.parse(await rfq0.call(authApi, 'addPrices', JSON.stringify({ rows, mode: 'replace' })));
            saved = `; ${(a.added || 0) + (a.replaced || 0)} online price${rows.length > 1 ? 's' : ''} saved in your price database`;
          } catch (e) {
            saved = `; the ${rows.length} online price${rows.length > 1 ? 's were' : ' was'} not saved in your price database (${esc(e.message || e)})`;
          }
        }
        if (j.download) ownState[id] = `${esc(r.fileName || j.name)}: saved, ${(r.sheets || []).map((s) => `${esc(s.name)} ${s.priced}/${s.lines}`).join(', ')}${said ? ` (${said})` : ''}${saved}`;
        else if (saved) ownState[id] = `${esc(j.name)}${saved}`;
        delete all[id];
      } catch (e) {
        waiting = true; // tried again on the next round
      }
    }
    setOwnJobs(all);
    showOwn();
    if (waiting || Object.keys(ownJobs()).length) ownTimer = setTimeout(followOwn, 10000);
  }
  // Jobs started on the agent page ("Compute with AI Agent") save their online prices too; the
  // page downloads their workbooks itself.
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin || !frame || ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (!m || m.type !== 'estimation-agent-started' || typeof m.jobId !== 'string') return;
    const all = ownJobs();
    all[m.jobId] = { name: String(m.fileName || 'BOQ'), at: Date.now(), download: false };
    setOwnJobs(all);
    if (!ownTimer) ownTimer = setTimeout(followOwn, 20000);
  });
  let ownSave = null;
  if (est) {
    ownSave = est.saveFile;
    est.saveFile = async function (name, bytes) {
      if (/\.xlsx$/i.test(String(name)) && bytes && bytes.length < 40 * 1024 * 1024) {
        let sent = null;
        try { sent = await startOwn(new Uint8Array(bytes)); } catch (e) { console.warn('Client BOQ not sent to the agent:', e); sent = null; }
        if (sent) return sent;
      }
      return ownSave.apply(est, arguments);
    };
  }

  // ---- Google Drive filing of AI Agent jobs (only while "Save project files to my Google
  // Drive" is on in Settings; the app's window.arzimateDrive does the saving) ----
  // The agent panel reports each job it starts; its BOQ is filed at once and the job is kept
  // here until its priced workbook can be filed too:
  //   Arzimate/<project>/AI Agent/<yyyy-mm-dd hh-mm> <file>, or Arzimate/AI Agent jobs/... .
  const FILED = 'arzimate.agentDrive';
  function filed() { try { return JSON.parse(localStorage.getItem(FILED) || '{}') || {}; } catch (_) { return {}; } }
  function setFiled(m) { try { localStorage.setItem(FILED, JSON.stringify(m)); } catch (_) {} }
  const drive = () => (window.arzimateDrive && window.arzimateDrive.on() ? window.arzimateDrive : null);
  window.addEventListener('message', (ev) => {
    // Only this site's own agent page, in this panel.
    if (ev.origin !== location.origin || !frame || ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (!m || m.type !== 'estimation-agent-started' || typeof m.jobId !== 'string') return;
    const d = drive();
    if (!d) return;
    const proj = m.project === undefined ? project : (m.project ? String(m.project) : null);
    const at = Number(m.at) || Date.now();
    const all = filed();
    all[m.jobId] = { project: proj, at };
    setFiled(all);
    if (typeof m.fileName === 'string' && typeof m.data === 'string') {
      d.saveAgent(proj, at, m.fileName, m.data).catch((e) => console.warn('AI agent BOQ not saved to Drive:', e));
    }
    check(); // follow the job from now on, so its workbook is filed soon after it is done
  });
  const filing = {};
  async function fileResults(jobs) {
    const all = filed();
    const ids = Object.keys(all);
    if (!ids.length) return;
    let changed = false;
    for (const id of ids) {
      const job = jobs.find((j) => j.jobId === id);
      const old = Date.now() - (all[id].at || 0) > 7 * 86400000;
      if ((job && ['failed', 'cancelled'].includes(job.status)) || (!job && old)) { delete all[id]; changed = true; continue; }
      const d = drive();
      if (!job || job.status !== 'done' || !d || filing[id]) continue;
      filing[id] = true;
      try {
        const current = window.firebase.auth().currentUser;
        const res = await fetch(FUNCTIONS + 'agentResult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await current.getIdToken()) },
          body: JSON.stringify({ data: { jobId: id } }),
        });
        const r = (await res.json()).result || {};
        if (!r.data) throw new Error('no workbook');
        await d.saveAgent(all[id].project, all[id].at, String(r.fileName || 'Priced BOQ.xlsx'), r.data);
        const now = filed();
        delete now[id];
        setFiled(now);
      } catch (e) {
        console.warn('AI agent workbook not saved to Drive yet:', e); // tried again on the next check
      } finally {
        delete filing[id];
      }
    }
    if (changed) {
      const now = filed();
      for (const id of ids) if (!all[id]) delete now[id];
      setFiled(now);
    }
  }

  function close() {
    panel.style.display = 'none';
    check(); // show the latest progress on the button
  }
  btn.addEventListener('click', open);
  panel.querySelector('header button').addEventListener('click', close);
  // Close on a click on the dark backdrop that also started there: the click that opened the
  // panel from the app (a ribbon or page button) ends on the backdrop and must not close it.
  let downOnBackdrop = false;
  panel.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === panel; });
  panel.addEventListener('click', (e) => { if (e.target === panel && downOnBackdrop) close(); downOnBackdrop = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.style.display === 'block') close(); });

  // ---- Progress of the user's latest job, on the button ----
  let user = null;
  let timer = null;
  let seenDone = {};

  function label(t, pct, done) {
    text.textContent = t;
    bar.style.display = pct == null ? 'none' : 'block';
    if (pct != null) fill.style.width = pct + '%';
    btn.classList.toggle('ai-done', !!done);
  }

  async function check() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!user || !window.firebase) return;
    const current = window.firebase.auth().currentUser;
    if (!current) return;
    let jobs = [];
    try {
      const res = await fetch(FUNCTIONS + 'agentJobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await current.getIdToken()) },
        body: '{"data":{}}',
      });
      jobs = ((await res.json()).result || {}).jobs || [];
    } catch (_) {
      timer = setTimeout(check, 60000);
      return;
    }
    fileResults(jobs);
    const running = jobs.find((j) => !['done', 'failed', 'cancelled'].includes(j.status));
    if (running) {
      const pct = running.total ? Math.round((running.done / running.total) * 95) + 3 : 2;
      let t = running.total ? `AI pricing · ${running.done}/${running.total}` : 'AI pricing · starting';
      if (running.createdAt && running.now && running.done > 0 && running.total > running.done) {
        const left = ((running.now - running.createdAt) / running.done) * (running.total - running.done) / 60000;
        t += left < 1 ? ' · under a minute left' : ` · about ${Math.round(left)} min left`;
      }
      if (running.status === 'writing') t = 'AI pricing · writing the workbook';
      label(t, pct, false);
      timer = setTimeout(check, 10000);
      return;
    }
    // A job that finished in the last hour and has not been opened yet: offer the download.
    const recent = jobs.find((j) => j.status === 'done' && j.createdAt && j.now - j.createdAt < 3600000 && !seenDone[j.jobId]);
    if (recent && panel.style.display !== 'block') {
      label('Priced: download', null, true);
      btn.onclick = () => { seenDone[recent.jobId] = true; label('AI Pricing Agent', null, false); btn.onclick = null; };
    } else {
      label('AI Pricing Agent', null, false);
    }
    // While the panel is open the page inside follows the job; check again when it closes.
    timer = setTimeout(check, panel.style.display === 'block' ? 15000 : 120000);
  }

  window.estimationAuth.onChange((json) => {
    user = json ? JSON.parse(json) : null;
    btn.style.display = user ? 'flex' : 'none';
    if (!user) { panel.style.display = 'none'; if (timer) clearTimeout(timer); return; }
    check();
    followOwn(); // client BOQs sent to the agent before a reload
  });
})();
