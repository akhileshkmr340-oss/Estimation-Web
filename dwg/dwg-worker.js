// Module worker: converts a DWG file off the main thread.
import { LibreDwg, Dwg_File_Type } from './dist/libredwg-web.js';
import { readDwg } from './dwg-read.js';

const wasmDir = new URL('./wasm', import.meta.url).href;

self.onmessage = async (event) => {
  const { id, bytes } = event.data;
  try {
    const result = await readDwg(LibreDwg, Dwg_File_Type, wasmDir, bytes);
    self.postMessage({ id, ok: true, json: JSON.stringify(result) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
};
