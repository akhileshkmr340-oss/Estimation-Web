// Live price search for the Estimation website, as a Cloudflare Worker.
//
// The website sends one item (description, rating, unit) with the signed-in
// user's Firebase ID token. The worker checks the token with Firebase, asks
// Google results (through Serper) and/or ChatGPT web search (OpenAI) for
// current Indian prices, and returns the prices it found with their links.
// It keeps nothing: no item, price or user is stored or logged.
//
// Secrets (Cloudflare > Worker > Settings > Variables and Secrets):
//   FIREBASE_API_KEY  the website's public Firebase web API key
//   SERPER_API_KEY    serper.dev key, for Google results (optional)
//   OPENAI_API_KEY    platform.openai.com key, for ChatGPT search (optional)
// Plain variables (optional):
//   OPENAI_MODEL      default gpt-5-mini
//   ALLOWED_ORIGINS   comma-separated, default https://akhileshkmr340-oss.github.io

const DEFAULT_ORIGINS = 'https://estimation-6fa32.web.app,https://estimation-6fa32.firebaseapp.com,https://akhileshkmr340-oss.github.io';

export default {
  async fetch(request, env) {
    const origins = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': origins.includes(origin) ? origin : origins[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') {
      return reply(200, { ok: true, google: !!env.SERPER_API_KEY, chatgpt: !!env.OPENAI_API_KEY });
    }
    if (request.method !== 'POST') return reply(405, { ok: false, error: 'Use POST.' });
    if (!origins.includes(origin)) return reply(403, { ok: false, error: 'This website is not allowed to use the price search.' });

    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return reply(401, { ok: false, error: 'Log in to search prices.' });
    if (!(await signedIn(token, env))) return reply(401, { ok: false, error: 'Your login has expired. Log in again.' });

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return reply(400, { ok: false, error: 'Bad request.' });
    }
    const item = {
      description: clip(body.description, 200),
      rating: clip(body.rating, 120),
      uom: clip(body.uom, 20),
      brand: clip(body.brand, 60),
    };
    if (!item.description) return reply(400, { ok: false, error: 'Give the item description.' });
    const want = String(body.providers || 'both');

    const jobs = [];
    if (want !== 'chatgpt' && env.SERPER_API_KEY) jobs.push(google(item, env).catch((e) => ({ provider: 'google', error: String(e.message || e) })));
    if (want !== 'google' && env.OPENAI_API_KEY) jobs.push(chatgpt(item, env).catch((e) => ({ provider: 'chatgpt', error: String(e.message || e) })));
    if (!jobs.length) return reply(503, { ok: false, error: 'No search key is set up on the price search service yet.' });

    const results = await Promise.all(jobs);
    const candidates = [];
    const errors = [];
    for (const r of results) {
      if (r.error) errors.push(`${r.provider}: ${r.error}`);
      for (const c of r.candidates || []) candidates.push(c);
    }
    // Same link and price once; cheapest first.
    const seen = new Set();
    const unique = candidates.filter((c) => {
      const k = `${c.url}|${c.price}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return c.price > 0 && /^https?:\/\//.test(c.url);
    });
    unique.sort((a, b) => a.price - b.price);
    return reply(200, { ok: true, query: query(item), candidates: unique.slice(0, 20), errors, checked: new Date().toISOString().slice(0, 10) });
  },
};

function clip(v, n) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function query(item) {
  return [item.brand, item.description, item.rating, 'price'].filter(Boolean).join(' ');
}

/** True when Firebase accepts the ID token of the website's project. */
async function signedIn(idToken, env) {
  if (!env.FIREBASE_API_KEY) return false;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) return false;
  const data = await res.json().catch(() => null);
  return !!(data && data.users && data.users.length);
}

/** "₹1,23,456.50" or "Rs. 999" as a number. */
export function rupees(text) {
  const m = String(text || '').match(/(?:₹|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/** Google Shopping and web results through Serper, in India. */
async function google(item, env) {
  const q = query(item);
  const post = (path) =>
    fetch(`https://google.serper.dev/${path}`, {
      method: 'POST',
      headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, gl: 'in', hl: 'en', num: 10 }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`Google search failed (${r.status})`);
      return r.json();
    });
  const [shop, web] = await Promise.all([post('shopping'), post('search')]);
  const candidates = [];
  for (const s of shop.shopping || []) {
    const price = rupees(s.price);
    if (price) candidates.push({ provider: 'google', price, title: clip(s.title, 160), seller: clip(s.source, 60) || host(s.link), url: s.link, note: 'Google Shopping listing' });
  }
  for (const o of web.organic || []) {
    const price = rupees(`${o.price || ''} ${o.snippet || ''}`);
    if (price) candidates.push({ provider: 'google', price, title: clip(o.title, 160), seller: host(o.link), url: o.link, note: clip(o.snippet, 200) });
  }
  return { provider: 'google', candidates };
}

/** ChatGPT with web search: asks for prices seen on pages, with links. */
async function chatgpt(item, env) {
  const prompt =
    'Find current prices in India (INR) for this electrical item, from brand price lists, distributors or marketplaces ' +
    '(Moglix, Industrybuying, IndiaMART, Amazon.in, brand sites). Only give prices you saw on a page, with that page\'s link. ' +
    'Never estimate. Say whether the price includes GST when the page says so.\n' +
    `Item: ${item.description}\nRating: ${item.rating || 'not given'}\nUnit: ${item.uom || 'not given'}\n` +
    (item.brand ? `Preferred brand: ${item.brand}\n` : '') +
    'Answer with JSON only: {"offers":[{"price":number,"title":"","seller":"","brand":"","url":"","gst":"incl|excl|unknown"}]}';
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.OPENAI_MODEL || 'gpt-5-mini', tools: [{ type: 'web_search' }], input: prompt }),
  });
  if (!res.ok) throw new Error(`ChatGPT search failed (${res.status})`);
  const data = await res.json();
  let text = data.output_text || '';
  if (!text) {
    for (const o of data.output || []) {
      for (const c of o.content || []) if (c.type === 'output_text') text += c.text;
    }
  }
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let offers = [];
  try {
    offers = JSON.parse(json).offers || [];
  } catch (_) {
    throw new Error('ChatGPT gave no price list');
  }
  const candidates = [];
  for (const o of offers) {
    const price = Number(o.price);
    if (!(price > 0) || !/^https?:\/\//.test(String(o.url || ''))) continue;
    candidates.push({
      provider: 'chatgpt',
      price,
      title: clip(o.title, 160),
      seller: clip(o.seller, 60) || host(o.url),
      brand: clip(o.brand, 60),
      url: String(o.url),
      note: o.gst === 'incl' ? 'price includes GST' : o.gst === 'excl' ? 'price before GST' : '',
    });
  }
  return { provider: 'chatgpt', candidates };
}
