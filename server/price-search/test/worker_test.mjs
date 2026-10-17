// Runs the worker against stubbed Firebase, Serper and OpenAI answers.
import assert from 'node:assert/strict';
import worker, { rupees } from '../worker.js';

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push(String(url));
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (String(url).includes('identitytoolkit')) {
    const { idToken } = JSON.parse(init.body);
    return idToken === 'good' ? json({ users: [{ localId: 'u1' }] }) : json({ error: { message: 'INVALID_ID_TOKEN' } }, 400);
  }
  if (String(url).endsWith('/shopping')) {
    assert.equal(init.headers['X-API-KEY'], 'serper');
    assert.equal(JSON.parse(init.body).gl, 'in');
    return json({ shopping: [{ title: 'Havells 32A DP RCCB 100mA', source: 'Moglix', link: 'https://www.moglix.com/x', price: '₹2,899.00' }, { title: 'no price', link: 'https://a.b' }] });
  }
  if (String(url).endsWith('/search')) return json({ organic: [{ title: 'RCCB price list', link: 'https://brand.example/list', snippet: 'DP 32A 100mA Rs. 3,334 MRP' }] });
  if (String(url).includes('api.openai.com')) {
    const b = JSON.parse(init.body);
    assert.deepEqual(b.tools, [{ type: 'web_search' }]);
    return json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Here: {"offers":[{"price":3100,"title":"Havells RCCB","seller":"Industrybuying","brand":"Havells","url":"https://www.industrybuying.com/y","gst":"incl"},{"price":0,"url":"https://z"}]}' }] }] });
  }
  throw new Error('unexpected ' + url);
};

const env = { FIREBASE_API_KEY: 'fb', SERPER_API_KEY: 'serper', OPENAI_API_KEY: 'oa' };
const origin = 'https://akhileshkmr340-oss.github.io';
const req = (token, body, o = origin) =>
  new Request('https://w.example/', { method: 'POST', headers: { Origin: o, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

assert.equal(rupees('₹1,23,456.50'), 123456.5);
assert.equal(rupees('Rs. 999 only'), 999);
assert.equal(rupees('no price'), null);

let r = await worker.fetch(req('bad', { description: 'RCCB' }), env);
assert.equal(r.status, 401);
r = await worker.fetch(req('good', { description: 'RCCB' }, 'https://evil.example'), env);
assert.equal(r.status, 403);
r = await worker.fetch(new Request('https://w.example/', { method: 'OPTIONS', headers: { Origin: origin } }), env);
assert.equal(r.status, 204);
assert.equal(r.headers.get('Access-Control-Allow-Origin'), origin);

r = await worker.fetch(req('good', { description: '32A DP RCCB', rating: '100mA', uom: 'Nos' }), env);
assert.equal(r.status, 200);
const d = await r.json();
assert.equal(d.ok, true);
assert.deepEqual(d.candidates.map((c) => [c.provider, c.price]), [['google', 2899], ['chatgpt', 3100], ['google', 3334]]);
assert.equal(d.candidates[1].note, 'price includes GST');
assert.equal(d.errors.length, 0);

r = await worker.fetch(req('good', { description: 'x', providers: 'google' }), { FIREBASE_API_KEY: 'fb' });
assert.equal(r.status, 503);
r = await worker.fetch(new Request('https://w.example/', { headers: { Origin: origin } }), env);
assert.deepEqual(await r.json(), { ok: true, google: true, chatgpt: true });
console.log('worker tests passed');
