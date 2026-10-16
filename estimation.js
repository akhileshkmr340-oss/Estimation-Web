// Browser services for the Estimation web app: file picking, storage
// (IndexedDB), OCR (Tesseract.js), scanned-PDF rendering (pdf.js) and
// downloads. Everything runs in the browser; nothing is uploaded.
(function () {
  'use strict';

  // ---- Files -------------------------------------------------------------

  const ACCEPT = '.dwg,.dxf,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.jpg,.jpeg,.png,.bmp,.webp,.gif,.tif,.tiff';

  // Resolves with [{name, bytes}] (empty when the picker is closed).
  function pickFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = ACCEPT;
      input.style.display = 'none';
      let settled = false;
      const finish = async () => {
        if (settled) return;
        settled = true;
        const files = Array.from(input.files || []);
        const out = [];
        for (const f of files) {
          out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        }
        input.remove();
        resolve(out);
      };
      input.addEventListener('change', finish);
      input.addEventListener('cancel', () => { if (!settled) { settled = true; input.remove(); resolve([]); } });
      document.body.appendChild(input);
      input.click();
    });
  }

  // Files dropped onto the page are queued here until the app asks for them.
  const dropped = [];
  let dropListener = null;
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    for (const f of files) dropped.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    if (files.length && dropListener) dropListener();
  });
  function takeDropped() { return dropped.splice(0, dropped.length); }
  function onDrop(fn) { dropListener = fn; }

  // Offers a generated file to the user. Inside claude.ai the page asks the
  // viewer to confirm the save; on a normal website it downloads directly.
  async function saveFile(name, bytes, mime) {
    if (window.claude && typeof window.claude.use === 'function') {
      let downloads = null;
      try { downloads = await window.claude.use('downloads'); } catch (_) { downloads = null; }
      if (downloads) {
        try {
          await downloads.save({ filename: name, data: new Blob([bytes], { type: mime }) });
          return 'saved';
        } catch (e) {
          if (e && e.code === 'declined') return 'cancelled';
          if (e && e.code !== 'unavailable' && e.code !== 'not_granted') throw new Error(e.message || String(e.code));
        }
      }
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return 'saved';
  }

  async function shareFile(name, bytes, mime) {
    const file = new File([bytes], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return 'shared';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
      }
    }
    return saveFile(name, bytes, mime);
  }

  function canShareFiles() {
    try {
      return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }));
    } catch (_) { return false; }
  }

  // ---- Storage (IndexedDB, with an in-memory fallback) --------------------

  const memory = { projects: new Map(), files: new Map(), settings: new Map() };
  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open('estimation', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            for (const s of ['projects', 'files', 'settings']) {
              if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      });
    }
    return dbPromise;
  }

  async function tx(store, mode, fn) {
    const db = await openDb();
    if (!db) return fn(null, memory[store]);
    return new Promise((resolve, reject) => {
      let result;
      try {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const r = fn(s, null);
        if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Storage is full or blocked.'));
      } catch (e) {
        // Storage refused (private window etc.): keep data for this visit only.
        resolve(fn(null, memory[store]));
      }
    });
  }

  const storage = {
    persistent: async () => !!(await openDb()),
    put: (store, key, value) => tx(store, 'readwrite', (s, m) => (s ? s.put(value, key) : m.set(key, value))),
    get: (store, key) => tx(store, 'readonly', (s, m) => (s ? s.get(key) : m.get(key))),
    remove: (store, key) => tx(store, 'readwrite', (s, m) => (s ? s.delete(key) : m.delete(key))),
    all: async (store) => {
      const values = await tx(store, 'readonly', (s, m) => (s ? s.getAll() : Array.from(m.values())));
      return values || [];
    },
  };

  // ---- OCR -----------------------------------------------------------------

  const base = new URL('.', document.baseURI).href;
  let workerPromise = null;
  function ocrWorker() {
    if (!workerPromise) {
      workerPromise = window.Tesseract.createWorker('eng', 1, {
        workerPath: base + 'ocr/ocr-worker.js',
        corePath: base + 'ocr/',
        langPath: base + 'ocr/lang',
        cacheMethod: 'none',
        workerBlobURL: false,
      }).catch((e) => { workerPromise = null; throw e; });
    }
    return workerPromise;
  }

  // Returns JSON: [{t: text, l, r, y, h}] word boxes in image pixels.
  async function recognize(image) {
    const worker = await ocrWorker();
    const { data } = await worker.recognize(image, {}, { blocks: true });
    const words = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const w of line.words || []) {
            const text = (w.text || '').trim();
            if (!text || w.confidence < 20) continue;
            const b = w.bbox;
            words.push({ t: text, l: b.x0, r: b.x1, y: (b.y0 + b.y1) / 2, h: b.y1 - b.y0 });
          }
        }
      }
    }
    return JSON.stringify(words);
  }

  async function ocrImage(bytes) {
    const blob = new Blob([bytes]);
    return recognize(blob);
  }

  let pdfjsPromise = null;
  function pdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(base + 'pdfjs/pdf.min.js').then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = base + 'pdfjs/pdf.worker.min.js';
        return lib;
      });
    }
    return pdfjsPromise;
  }

  // OCR every page of a scanned PDF. Returns JSON: [[words of page 1], ...].
  async function ocrPdf(bytes, maxPages, onPage) {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
    const pages = [];
    const count = Math.min(doc.numPages, maxPages || 30);
    for (let i = 1; i <= count; i++) {
      if (onPage) onPage(i, count);
      const page = await doc.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(4, 2000 / Math.max(v1.width, 1)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      pages.push(JSON.parse(await recognize(canvas)));
      page.cleanup();
    }
    await doc.destroy();
    return JSON.stringify(pages);
  }

  const ocrAvailable = () => typeof window.Tesseract !== 'undefined';

  // ---- DWG (LibreDWG in a worker) -----------------------------------------

  let dwgWorker = null;
  let dwgSeq = 0;
  const dwgPending = new Map();
  function readDwg(bytes) {
    if (!dwgWorker) {
      dwgWorker = new Worker(base + 'dwg/dwg-worker.js', { type: 'module' });
      dwgWorker.onmessage = (e) => {
        const p = dwgPending.get(e.data.id);
        if (!p) return;
        dwgPending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.json); else p.reject(new Error(e.data.error));
      };
      dwgWorker.onerror = (e) => {
        const err = new Error('The DWG reader could not start (' + (e.message || 'worker error') + ').');
        for (const p of dwgPending.values()) p.reject(err);
        dwgPending.clear();
        dwgWorker = null;
      };
    }
    const id = ++dwgSeq;
    const copy = bytes.slice(0).buffer;
    return new Promise((resolve, reject) => {
      dwgPending.set(id, { resolve, reject });
      dwgWorker.postMessage({ id, bytes: copy }, [copy]);
    });
  }

  window.estimation = {
    pickFiles, takeDropped, onDrop, saveFile, shareFile, canShareFiles,
    storage, ocrAvailable, ocrImage, ocrPdf, readDwg,
  };
})();
