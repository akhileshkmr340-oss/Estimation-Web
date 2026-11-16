// One developer only: the account that owns the price database (RATES_OWNER)
// is NOT the developer. It still gets its main rates for pricing, but no
// price counts and every developer action is refused; the script owner's
// account (GMAIL, argv[2]) is the developer. Run on a fresh gas_stub.mjs
// (no RATES_OWNER yet) with the Auth emulator.
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
const owner = await account(`work${t}@symatic.example`);
const dev = await account(devEmail);
const user = await account(`normal${t}@example.com`);

// The work account becomes the price database owner (as on the live Sheet).
let r = await call(owner, 'saveSuppliers', { suppliers: [] });
check(r.ok, 'the work account becomes RATES_OWNER');
r = await call(owner, 'saveRates', { rates: [{ item: 'MCB 16A SP', unit: 'Nos', supply: 150, category: 'Electrical' }, { item: 'Duct 600x400', unit: 'Sqm', supply: 950, category: 'HVAC' }], uplift: 5, updated: '2026-11-16', file: '' });
check(r.ok, 'the owner can still replace the main price database');
r = await call(owner, 'addPrices', { rows: [{ material: 'Owner cable', unit: 'Mtr', price: 10, brand: '', category: 'Electrical' }], replace: false });
check(r.ok, 'the owner adds a price of their own');

r = await call(owner, 'devCheck');
check(r.ok && r.developer === false, 'devCheck: the owner is not the developer');
r = await call(owner, 'getRates');
check(r.ok && Array.isArray(r.rates) && r.rates.length === 2, 'the owner still gets the main rates for pricing');
check(r.developer === false && !('counts' in r), 'the owner gets no price counts and no developer flag');
check(!r.file, 'the owner gets no Drive file link');
for (const act of ['devUsers', 'devPrices', 'devUpdatePrice', 'devDeletePrices', 'devProfiles', 'devDeleteUserData', 'devAudit']) {
  r = await call(owner, act, { target: 'main', id: 'row:2:MCB 16A SP', ids: ['row:2:MCB 16A SP'], price: { material: 'x', price: 1, category: 'Others' }, uid: user.uid, what: 'delete' });
  check(!r.ok && /developer/.test(r.error), `${act} refused for the owner`);
}

r = await call(user, 'addPrices', { rows: [{ material: 'User lamp', unit: 'Nos', price: 99, brand: '', category: 'Electrical' }], replace: false });
check(r.ok, 'a normal account adds a price');
r = await call(user, 'getRates');
check(r.ok && r.rates === null && r.developer === false && !('counts' in r), 'a normal account: no main rates, no counts');

r = await call(dev, 'devCheck');
check(r.ok && r.developer === true, 'devCheck: the script owner\'s account is the developer');
r = await call(dev, 'getRates');
check(r.ok && r.developer === true && r.counts && r.counts.Electrical === 1 && r.counts.HVAC === 1, 'the developer gets the counts: ' + JSON.stringify(r.counts));
check(Array.isArray(r.rates) && r.rates.length === 2, 'the developer gets the main rates too');
r = await call(dev, 'devUsers');
check(r.ok && r.users.some((u) => u.uid === owner.uid) && r.users.some((u) => u.uid === user.uid), 'the developer lists accounts with prices');
r = await call(dev, 'devPrices', { target: 'main' });
check(r.ok && r.prices.length === 2, 'the developer lists the main database');
console.log(fail.length ? `${fail.length} FAILED` : 'ALL PASSED');
process.exit(fail.length ? 1 : 0);
