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
    for (const f of list || []) if (f && f.name && f.bytes && TENDER_FILE.test(f.name)) chosen.set(String(f.name), f.bytes);
    // Keep at most about 300 MB, dropping the files chosen first.
    for (const [n, b] of [...chosen].reverse()) { total += b.length; if (total > 300 * 1024 * 1024) chosen.delete(n); }
    return list;
  }
  if (est) {
    const pickFiles = est.pickFiles;
    const takeDropped = est.takeDropped;
    est.pickFiles = (...a) => Promise.resolve(pickFiles.apply(est, a)).then(remember);
    est.takeDropped = (...a) => remember(takeDropped.apply(est, a));
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
  });
})();
