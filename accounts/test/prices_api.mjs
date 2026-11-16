// "Add to your prices" on the Sheet script: per-account stores, nothing read back,
// developer-only actions. Run with the Auth emulator and gas_stub.mjs (GMAIL=owner email).
const EMU = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key';
const GAS = 'http://127.0.0.1:8787/exec';
const owner = process.argv[2] || 'owner@gmail.com';
const fail = [];
const check = (ok, what) => { console.log(ok ? 'OK  ' : 'FAIL', what); if (!ok) fail.push(what); };
async function account(email) {
  const r = await (await fetch(EMU, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) })).json();
  if (!r.idToken) throw new Error(JSON.stringify(r));
  return { token: r.idToken, uid: r.localId };
}
const call = async (who, action, body = {}) => (await fetch(GAS, { method: 'POST', body: JSON.stringify({ idToken: who.token, action, ...body }) })).json();
const rows = async () => (await fetch('http://127.0.0.1:8787/rows?sheet=' + encodeURIComponent('User prices'))).json();

const a = await account(`a${Date.now()}@example.com`);
const b = await account(`b${Date.now()}@example.com`);
const dev = await account(owner);

let r = await call(a, 'getRates');
check(r.ok && r.developer === false && r.mine.length === 0, 'new user: no prices, not the developer');
r = await call(a, 'addPrices', { rows: [
  { material: '16A SP MCB', unit: 'Nos', price: 150, brand: 'Schneider', category: 'Electrical' },
  { material: 'Duct 600x400', unit: 'Sqm', price: 950, brand: 'Zeco', category: 'HVAC' },
], mode: 'keep' });
check(r.ok && r.added === 2 && !('rows' in r) && !('prices' in r), 'addPrices answers counts only');
r = await call(a, 'addPrices', { rows: [{ material: 'x', unit: 'Nos', price: 0, category: 'Electrical' }] });
check(!r.ok, 'a price of 0 is refused');
r = await call(a, 'addPrices', { rows: [{ material: 'x', unit: 'Nos', price: 5, category: 'Plumbing' }] });
check(!r.ok, 'an unknown category is refused');
r = await call(a, 'addPrices', { rows: [{ material: '16a sp mcb', unit: 'nos', price: 160, brand: 'schneider', category: 'Electrical' }], mode: 'replace' });
check(r.ok && r.replaced === 1, 'replace: the old price with the same material, unit and brand goes');
r = await call(a, 'addPrices', { rows: [{ material: 'Duct 600x400', unit: 'Sqm', price: 990, brand: 'Zeco', category: 'HVAC' }], mode: 'keep' });
check(r.ok && r.replaced === 0, 'keep both');
r = await call(a, 'getRates');
check(r.mine.length === 3 && !('counts' in r), 'a normal account gets its own prices for pricing but no counts');
check(r.file === undefined || r.file === '', 'the database file link is not sent to a normal user');
r = await call(b, 'getRates');
check(r.mine.length === 0, 'another account does not get these prices');
for (const act of ['devUsers', 'devPrices', 'devUpdatePrice', 'devDeletePrices']) {
  r = await call(a, act, { target: a.uid, ids: ['x'], id: 'x', price: { material: 'x', price: 1, category: 'Others' } });
  check(!r.ok && /developer/.test(r.error), `${act} refused for a normal user`);
}
r = await call(a, 'devPrices', { target: a.uid, developer: true });
check(!r.ok, 'a "developer" flag sent by the browser changes nothing');

r = await call(dev, 'getRates');
check(r.developer === true, 'the account with the script owner\'s email is the developer');
r = await call(dev, 'devUsers');
check(r.ok && r.users.some((u) => u.uid === a.uid && u.count === 3), 'developer lists accounts with counts');
r = await call(dev, 'devPrices', { target: a.uid });
check(r.ok && r.prices.length === 3 && r.prices.some((p) => p.price === 160), 'developer sees an account\'s prices');
const duct = r.prices.find((p) => p.price === 990);
r = await call(dev, 'devUpdatePrice', { target: a.uid, id: duct.id, price: { material: 'Duct 600x400', unit: 'Sqm', price: 975, brand: 'Zeco', category: 'HVAC' } });
check(r.ok, 'developer edits a price');
r = await call(dev, 'devDeletePrices', { target: a.uid, ids: [duct.id] });
check(r.ok && r.deleted === 1, 'developer deletes a price');
r = await call(a, 'getRates');
check(r.mine.length === 2 && !r.mine.some((p) => p.supply === 975 || p.supply === 990), 'the user\'s pricing follows the developer\'s changes');
check((await rows()).filter((x) => x[0] === a.uid).length === 2, 'sheet rows match');
console.log(fail.length ? `${fail.length} FAILED` : 'ALL PASSED');
process.exit(fail.length ? 1 : 0);
