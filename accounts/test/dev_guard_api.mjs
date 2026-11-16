// The price database stays the developer's: a signed-in normal account gets
// no main rates and every developer action is refused. Run with the Auth
// emulator and gas_stub.mjs (GMAIL=<developer email>, passed as argv[2]).
const EMU = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key';
const GAS = 'http://127.0.0.1:8787/exec';
const devEmail = process.argv[2] || 'owner@gmail.com';
const fail = [];
const check = (ok, what) => { console.log(ok ? 'OK  ' : 'FAIL', what); if (!ok) fail.push(what); };
const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
async function account(email) {
  const r = await post(EMU, { email, password: 'secret123', returnSecureToken: true });
  if (!r.idToken) throw new Error(JSON.stringify(r));
  return { token: r.idToken, uid: r.localId };
}
const call = (who, action, body = {}) => post(GAS, { idToken: who.token, action, ...body });
const t = Date.now();
const user = await account(`guard${t}@example.com`);

// Before any main database exists, a normal account cannot create it.
let r = await call(user, 'saveRates', { rates: [{ item: 'MCB', unit: 'Nos', supply: 100 }], uplift: 5, updated: 'x' });
check(!r.ok, 'a normal account cannot save the main price database: ' + r.error);

const dev = await account(devEmail);
r = await call(dev, 'saveRates', { rates: [{ item: 'MCB 16A SP', unit: 'Nos', supply: 150, category: 'Electrical' }, { item: 'Duct 600x400', unit: 'Sqm', supply: 950, category: 'HVAC' }], uplift: 5, updated: '2026-11-16', file: '' });
check(r.ok, 'the developer saves the main price database');

r = await call(user, 'getRates');
check(r.ok && r.rates === null && r.developer === false, 'getRates for a normal account: rates null, not the developer');
check(!JSON.stringify(r).includes('MCB 16A SP') && !JSON.stringify(r).includes('950'), 'no main price reaches a normal account');
r = await call(dev, 'getRates');
check(r.ok && Array.isArray(r.rates) && r.rates.length === 2 && r.developer === true, 'the developer gets the main database');

for (const act of ['devUsers', 'devPrices', 'devUpdatePrice', 'devDeletePrices', 'devProfiles', 'devDeleteUserData', 'devAudit']) {
  r = await call(user, act, { target: 'main', id: 'row:2:MCB 16A SP', ids: ['row:2:MCB 16A SP'], price: { material: 'x', price: 1, category: 'Others' }, uid: dev.uid, what: 'delete' });
  check(!r.ok && /developer/.test(r.error), `${act} refused for a normal account`);
}
r = await call(user, 'devPrices', { target: 'main', developer: true });
check(!r.ok, 'a "developer" flag from the browser changes nothing');
r = await post(GAS, { action: 'devPrices', target: 'main' });
check(!r.ok, 'no sign-in: refused');
r = await call(dev, 'devPrices', { target: 'main' });
check(r.ok && r.prices.length === 2, 'the main database is unchanged (2 rows) and the developer can list it');
console.log(fail.length ? `${fail.length} FAILED` : 'ALL PASSED');
process.exit(fail.length ? 1 : 0);
