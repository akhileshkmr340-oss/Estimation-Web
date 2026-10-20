// Browser services for the Estimation web app: file picking, background reading
// of files in a worker, OCR (Tesseract.js), scanned-PDF rendering (pdf.js) and
// downloads. Everything runs in the browser; nothing is uploaded.
(function () {
  'use strict';

  // ---- Files -------------------------------------------------------------

  const ACCEPT = '.dwg,.dxf,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.jpg,.jpeg,.png,.bmp,.webp,.gif,.tif,.tiff';

  // Resolves with [{name, bytes}] (empty when the picker is closed).
  function pickFiles(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = accept === undefined ? ACCEPT : accept;
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

  // ---- Storage -------------------------------------------------------------

  // The website keeps nothing in the browser. Earlier versions saved
  // projects and files in IndexedDB; this deletes that database.
  function clearStorage() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.deleteDatabase('estimation');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }

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

  // ---- Reading files (Dart, in workers) ----------------------------------

  // The same reading code as the page's, compiled for workers
  // (worker/extract.js), so large drawings never freeze the page. Large PDFs
  // are read in parts by several workers at once.
  const exPending = new Map();
  const exPool = [];
  let exSeq = 0;
  const workerCount = () => Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

  function exWorker() {
    let best = null;
    for (const w of exPool) if (!best || w.busy < best.busy) best = w;
    if (best && (best.busy === 0 || exPool.length >= workerCount())) return best;
    const w = { worker: new Worker(base + 'worker/extract.js'), busy: 0, jobs: new Set() };
    w.worker.onmessage = (e) => {
      const p = exPending.get(e.data.id);
      if (!p) return;
      if (e.data.status !== undefined) {
        if (p.onStatus) p.onStatus(e.data.status);
        return;
      }
      exPending.delete(e.data.id);
      w.jobs.delete(e.data.id);
      w.busy--;
      p.resolve({ json: e.data.json, bytes: e.data.bytes || null });
    };
    w.worker.onerror = (e) => {
      // A crash (for example out of memory) fails this worker's files; the
      // next file starts a fresh worker.
      const err = new Error(e.message || 'The file reader stopped (the browser may be out of memory).');
      for (const id of w.jobs) {
        const p = exPending.get(id);
        exPending.delete(id);
        if (p) p.reject(err);
      }
      w.worker.terminate();
      exPool.splice(exPool.indexOf(w), 1);
    };
    exPool.push(w);
    return w;
  }

  // job: {mode, name, bytes, dwgJson, from, to}. With move, the bytes are
  // moved to the worker and handed back with the result; otherwise the
  // worker gets a copy.
  function extract(job, move, onStatus) {
    if (typeof Worker === 'undefined') return Promise.reject(new Error('no workers'));
    const w = exWorker();
    const id = ++exSeq;
    return new Promise((resolve, reject) => {
      exPending.set(id, { resolve, reject, onStatus });
      w.jobs.add(id);
      w.busy++;
      const msg = Object.assign({ id, back: !!move }, job);
      if (move && job.bytes) w.worker.postMessage(msg, [job.bytes.buffer]);
      else w.worker.postMessage(msg);
    });
  }

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
    clearStorage, ocrAvailable, ocrImage, ocrPdf, readDwg, extract, workerCount,
  };
})();
