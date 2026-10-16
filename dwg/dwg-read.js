// Reads a DWG drawing with LibreDWG (WebAssembly) and flattens it into the
// small JSON the website analyses: every text and attribute with its
// position in model space (block contents expanded, nested blocks included)
// and how many times each block is placed.

function transformer(t) {
  // t = {a, b, c, d, e, f}: x' = a*x + c*y + e, y' = b*x + d*y + f
  return (p) => ({ x: t.a * p.x + t.c * p.y + t.e, y: t.b * p.x + t.d * p.y + t.f });
}

function compose(parent, ins, base) {
  const sx = ins.xScale || 1, sy = ins.yScale || 1;
  const r = ins.rotation || 0;
  const cos = Math.cos(r), sin = Math.sin(r);
  // Local: translate(-base), scale, rotate, translate(insertion point).
  const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
  const p = ins.insertionPoint || { x: 0, y: 0 };
  const bx = base ? base.x : 0, by = base ? base.y : 0;
  const e = p.x - (a * bx + c * by), f = p.y - (b * bx + d * by);
  // parent ∘ local
  return {
    a: parent.a * a + parent.c * b,
    b: parent.b * a + parent.d * b,
    c: parent.a * c + parent.c * d,
    d: parent.b * c + parent.d * d,
    e: parent.a * e + parent.c * f + parent.e,
    f: parent.b * e + parent.d * f + parent.f,
  };
}

function scaleOf(t) { return Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) || 1; }

export function flatten(db) {
  const records = (db.tables && db.tables.BLOCK_RECORD && db.tables.BLOCK_RECORD.entries) || [];
  const blocks = new Map();
  for (const b of records) blocks.set(b.name, b);
  const modelHandle = (records.find((b) => /^\*model_space$/i.test(b.name)) || {}).handle || '2';

  const texts = [];
  const blockCounts = {};
  let truncated = false;
  const MAX_TEXTS = 200000;

  function addText(raw, kind, p, h, tf, depth, layer, tag) {
    if (raw == null) return;
    const s = String(raw);
    if (!s.trim()) return;
    if (texts.length >= MAX_TEXTS) { truncated = true; return; }
    const w = transformer(tf)(p || { x: 0, y: 0 });
    texts.push({ t: s, k: kind, x: w.x, y: w.y, h: (h || 0) * scaleOf(tf), d: depth, l: layer || '', g: tag || '' });
  }

  function walk(entities, tf, depth, stack) {
    for (const e of entities) {
      if (!e || e.isVisible === false) continue;
      switch (e.type) {
        case 'TEXT':
          addText(e.text, 'T', e.startPoint || e.insertionPoint, e.textHeight, tf, depth, e.layer);
          break;
        case 'MTEXT':
          addText(e.text, 'M', e.insertionPoint, e.textHeight, tf, depth, e.layer);
          break;
        case 'INSERT': {
          const name = e.name || '';
          const n = Math.max(1, e.columnCount || 1) * Math.max(1, e.rowCount || 1);
          blockCounts[name] = (blockCounts[name] || 0) + n;
          for (const a of e.attribs || []) {
            // This LibreDWG build nests the value: a.text = { text, startPoint, textHeight }.
            const v = a.text && typeof a.text === 'object' ? a.text : a;
            const mt = a.mtext && typeof a.mtext === 'object' && a.mtext.text ? a.mtext : null;
            const raw = typeof v.text === 'string' && v.text ? v.text : mt ? mt.text : null;
            addText(raw, 'A', v.startPoint || v.insertionPoint || a.startPoint || a.insertionPoint,
              v.textHeight || a.textHeight || (mt && mt.textHeight), tf, depth, a.layer, a.tag);
          }
          const block = blocks.get(name);
          if (!block || !block.entities || depth >= 12 || stack.includes(name)) break;
          const child = compose(tf, e, block.basePoint);
          // Arrays (MINSERT) repeat the contents; positions of the copies are not needed.
          for (let i = 0; i < n; i++) walk(block.entities, child, depth + 1, stack.concat(name));
          break;
        }
        default:
          break;
      }
    }
  }

  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const model = (db.entities || []).filter((e) => e.ownerBlockRecordSoftId === modelHandle);
  walk(model, identity, 0, []);
  return { texts, blockCounts, truncated };
}

export async function readDwg(LibreDwg, Dwg_File_Type, wasmDir, bytes) {
  const lib = await LibreDwg.create(wasmDir);
  const dwg = lib.dwg_read_data(bytes, Dwg_File_Type.DWG);
  if (!dwg) throw new Error('This DWG file could not be opened.');
  try {
    const db = lib.convert(dwg);
    return flatten(db);
  } finally {
    try { lib.dwg_free(dwg); } catch (_) {}
  }
}
