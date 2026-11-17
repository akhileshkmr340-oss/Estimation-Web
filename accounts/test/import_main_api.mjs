// "Import price file" into the main price database (devImportMain): the
// developer only. A normal account and the database owner (RATES_OWNER, not
// the developer) are refused and change nothing. Run on a fresh gas_stub.mjs
// with the Auth emulator; argv[2] = the developer's (script owner's) email.
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
const sheet = async () => (await fetch('http://127.0.0.1:8787/rows?sheet=' + encodeURIComponent('Rate database'))).json();
const t = Date.now();
const owner = await account(`work${t}@symatic.example`);
const user = await account(`normal${t}@example.com`);
const dev = await account(devEmail);

let r = await call(owner, 'saveSuppliers', { suppliers: [] });
check(r.ok, 'the work account becomes RATES_OWNER');
r = await call(owner, 'saveRates', { rates: [{ item: 'MCB 16A SP', unit: 'Nos', supply: 150, category: 'Electrical' }, { item: 'Duct 600x400', unit: 'Sqm', supply: 950, category: 'HVAC' }], uplift: 5, updated: '2026-11-17' });
check(r.ok, 'the owner saves the main database (2 rows)');
const rows = [
  { material: 'MCB 16A SP', unit: 'Nos', price: 160, brand: '', category: 'Electrical', file: 'quote.xlsx' },
  { material: '4MP IP dome camera', unit: 'Nos', price: 4200, brand: 'Hikvision', category: 'CCTV', file: 'quote.xlsx' },
];
for (const who of [['a normal account', user], ['the database owner', owner]]) {
  for (const mode of ['add', 'replace']) {
    r = await call(who[1], 'devImportMain', { rows, mode });
    check(!r.ok && /developer/.test(r.error), `${who[0]} cannot import into the main database (${mode})`);
  }
}
r = await post(GAS, { action: 'devImportMain', rows, mode: 'replace' });
check(!r.ok, 'no sign-in: refused');
let s = await sheet();
check(s.length === 3 && s[1][0] === 'MCB 16A SP' && s[1][3] === 150, 'the main database is unchanged after the refusals');

r = await call(dev, 'devImportMain', { rows: [{ material: '', price: 5, category: 'Electrical' }], mode: 'add' });
check(!r.ok, 'a row with no material is refused');
r = await call(dev, 'devImportMain', { rows, mode: 'add' });
check(r.ok && r.added === 2 && r.replaced === 1 && r.total === 3, 'developer, add: 2 added, 1 replaced (same material and unit), 3 in all: ' + JSON.stringify(r));
s = await sheet();
const mcb = s.filter((v) => v[0] === 'MCB 16A SP');
check(mcb.length === 1 && mcb[0][3] === 160 && mcb[0][5] === 'Imported: quote.xlsx', 'the MCB now has the imported price');
const cam = s.find((v) => v[0] === '4MP IP dome camera');
check(cam && cam[1] === 'Make: Hikvision' && cam[8] === 'CCTV', 'brand kept as "Make:", category kept');
check(s.some((v) => v[0] === 'Duct 600x400' && v[3] === 950), 'other rows are kept');
r = await call(owner, 'getRates');
check(r.ok && r.rates.length === 3 && !('counts' in r), 'the owner prices with the new rows, still without counts');

r = await call(dev, 'devImportMain', { rows: [rows[1]], mode: 'replace' });
check(r.ok && r.added === 1 && r.total === 1, 'developer, replace: the database is only the new rows');
s = await sheet();
check(s.length === 2 && s[1][0] === '4MP IP dome camera', 'the sheet holds the heading and one row');
r = await call(dev, 'getRates');
check(r.ok && r.uplift === 0 && r.rates.length === 1 && r.counts.CCTV === 1, 'after replace: no uplift, the developer sees the count');
console.log(fail.length ? `${fail.length} FAILED` : 'ALL PASSED');
process.exit(fail.length ? 1 : 0);
