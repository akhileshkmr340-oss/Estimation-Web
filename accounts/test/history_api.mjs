// Price history: a new price is added beside the old one (never over it),
// pricing uses the newest, and an old price goes only when it is more than
// 5 years old AND a newer price of the same item exists. Existing rows get a
// date once, without losing any. Run on a fresh gas_stub.mjs with the Auth
// emulator; argv[2] = the developer's (script owner's) email.
const EMU = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key';
const GAS = 'http://127.0.0.1:8787';
const devEmail = process.argv[2] || 'owner@gmail.com';
const fail = [];
const check = (ok, what) => { console.log(ok ? 'OK  ' : 'FAIL', what); if (!ok) fail.push(what); };
const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
async function account(email) {
  const r = await post(EMU, { email, password: 'secret123', returnSecureToken: true });
  if (!r.idToken) throw new Error(JSON.stringify(r));
  return { token: r.idToken, uid: r.localId };
}
const call = (who, action, body = {}) => post(GAS + '/exec', { idToken: who.token, action, ...body });
const sheet = async (n) => (await fetch(GAS + '/rows?sheet=' + encodeURIComponent(n))).json();
const seed = (n, rows) => post(GAS + '/seed?sheet=' + encodeURIComponent(n), rows);
const t = Date.now();
const owner = await account(`work${t}@symatic.example`);
const a = await account(`a${t}@example.com`);
const dev = await account(devEmail);

// Data as the live version 22 script left it: no date column.
let r = await call(owner, 'saveSuppliers', { suppliers: [] });
check(r.ok, 'the work account owns the price database');
await post(GAS + '/props', { RATES_UPDATED: '20 Oct 2026', RATES_UPLIFT: '5' });
const RH = ['Description', 'Heading above it in the BOQ', 'UOM', 'Supply rate (₹)', 'Service rate (₹)', 'Source sheet', 'Row', 'Single quoted rate', 'Category'];
await seed('Rate database', [RH,
  ['MCB 16A SP', 'MCB', 'Nos', 150, 20, 'BOQ A', 4, 'No', 'Electrical'],
  ['Duct 600x400', 'HVAC', 'Sqm', 950, '', 'BOQ A', 9, 'No', 'HVAC'],
  ['Cable 4C x 16', 'CABLES', 'Mtr', 600, 40, 'BOQ A', 12, 'No', 'Electrical'],
  ['Cable 4C x 16', 'CABLES', 'Mtr', 620, 45, 'BOQ B', 30, 'No', 'Electrical']]);
const PH = ['User ID', 'Material', 'Unit', 'Price (₹, excl. GST)', 'Brand', 'Category', 'Added', 'Source file', 'Row ID'];
await seed('User prices', [PH,
  [a.uid, 'Lamp', 'Nos', 99, '', 'Electrical', '2019-03-01 10:00', '', 'id1'],
  [a.uid, 'Fan', 'Nos', 120, '', 'Electrical', '2025-01-10 09:00', '', 'id2'],
  [a.uid, 'Old only', 'Nos', 50, '', 'Electrical', '2018-01-01 08:00', '', 'id3']]);

// 1. The one-off dating keeps every row and changes nothing else; running it again changes nothing.
r = await call(dev, 'getRates');
let main = await sheet('Rate database');
let up = await sheet('User prices');
check(main.length === 5 && main[0][9] === 'Price date' && main.slice(1).every((v) => v[9] === '2026-10-20'), 'main database: 4 rows kept, each dated 20 Oct 2026 (when it was saved)');
check(main.slice(1).every((v, i) => JSON.stringify(v.slice(0, 9)) === JSON.stringify([['MCB 16A SP', 'MCB', 'Nos', 150, 20, 'BOQ A', 4, 'No', 'Electrical'], ['Duct 600x400', 'HVAC', 'Sqm', 950, '', 'BOQ A', 9, 'No', 'HVAC'], ['Cable 4C x 16', 'CABLES', 'Mtr', 600, 40, 'BOQ A', 12, 'No', 'Electrical'], ['Cable 4C x 16', 'CABLES', 'Mtr', 620, 45, 'BOQ B', 30, 'No', 'Electrical']][i])), 'main database: every value unchanged');
check(up.length === 4 && up[0][9] === 'Price date' && up[1][9] === '2019-03-01' && up[2][9] === '2025-01-10' && up[3][9] === '2018-01-01', 'user prices: 3 rows kept, dated from when they were added');
const snap = JSON.stringify([main, up]);
await call(dev, 'getRates');
await call(a, 'getRates');
check(JSON.stringify([await sheet('Rate database'), await sheet('User prices')]) === snap, 'dating again changes nothing');
check(r.ok && r.rates.length === 4, 'pricing: all 4 main rates still used (both rates of the cable, same date)');

// 2. Own prices: a newer price is added; pricing uses it; the old row goes only if > 5 years old.
r = await call(a, 'addPrices', { rows: [{ material: 'lamp ', unit: 'nos', price: 110, category: 'Electrical' }], mode: 'replace' });
check(r.ok && r.added === 1 && r.replaced === 1 && r.pruned === 1, 'newer Lamp price added; the 2019 Lamp price (over 5 years, newer exists) removed: ' + JSON.stringify(r));
up = await sheet('User prices');
check(up.filter((v) => v[1].toLowerCase().trim() === 'lamp').length === 1, 'one Lamp row left (the new one)');
let log = await sheet('Price history log');
check(log.length === 2 && log[1][4] === 1 && log[1][5] === '2019-03-01' && log[1][3] === 'lamp|nos|' && !JSON.stringify(log).includes('99'), 'logged: item, 1 removed, its date, no price');
r = await call(a, 'addPrices', { rows: [{ material: 'Fan', unit: 'Nos', price: 130, category: 'Electrical' }] });
check(r.ok && r.added === 1 && r.pruned === 0, 'newer Fan price added; the 2025 Fan price (under 5 years) kept');
up = await sheet('User prices');
check(up.filter((v) => v[1] === 'Fan').length === 2, 'both Fan rows are in the sheet');
r = await call(a, 'getRates');
const mine = Object.fromEntries(r.mine.map((p) => [p.item.trim().toLowerCase(), p.supply]));
check(mine.lamp === 110 && mine.fan === 130 && mine['old only'] === 50 && r.mine.length === 3, 'pricing uses the newest price of each item: ' + JSON.stringify(mine));
r = await call(a, 'addPrices', { rows: [{ material: 'Old only', unit: 'Nos', price: 40, category: 'Electrical', date: '01.05.2017' }] });
up = await sheet('User prices');
const old = up.filter((v) => v[1] === 'Old only');
check(old.length === 1 && old[0][3] === 50 && old[0][9] === '2018-01-01', 'the newest price of an item is never removed, even from 2018 (an older 2017 price is not kept over it)');
r = await call(a, 'addPrices', { rows: [{ material: 'Socket', unit: 'Nos', price: 75, category: 'Electrical', date: '15.08.2024' }] });
up = await sheet('User prices');
check(up.some((v) => v[1] === 'Socket' && v[9] === '2024-08-15'), "a price's own date from the file is kept (15.08.2024)");
r = await call(a, 'addPrices', { rows: [{ material: 'Socket', unit: 'Nos', price: 75, category: 'Electrical', date: '15.08.2024' }] });
check(r.ok && r.added === 0, 'the same price on the same day is not added twice');

// 3. Main database: no replace; import only adds; the row count never drops.
const before = (await sheet('Rate database')).length;
r = await call(dev, 'devImportMain', { rows: [{ material: 'MCB 16A SP', unit: 'Nos', price: 1, category: 'Electrical' }], mode: 'replace' });
check(!r.ok && /never replaced/.test(r.error), 'devImportMain has no replace mode: ' + r.error);
check((await sheet('Rate database')).length === before, 'nothing changed by the refused replace');
r = await call(dev, 'devImportMain', { rows: [{ material: 'MCB 16A SP', unit: 'Nos', price: 160, category: 'Electrical', file: 'quote.xlsx' }], mode: 'add' });
check(r.ok && r.added === 1 && r.replaced === 1 && r.pruned === 0, 'import: the newer MCB price is added beside the old one');
main = await sheet('Rate database');
check(main.length === before + 1 && main.filter((v) => v[0] === 'MCB 16A SP').length === 2, 'the main database grew by one; both MCB prices are there');
r = await call(owner, 'getRates');
const mcb = r.rates.filter((x) => x.item === 'MCB 16A SP');
check(mcb.length === 1 && mcb[0].supply === 160 && r.rates.filter((x) => x.item === 'Cable 4C x 16').length === 2 && r.rates.some((x) => x.item === 'Duct 600x400'), 'pricing: MCB at the new 160, the other items as before');
check(!('counts' in r), 'the owner still gets no counts');

await seed('Rate database', [['Old breaker', '', 'Nos', 900, '', 'BOQ 2018', 3, 'No', 'Electrical', '2019-06-30']]);
r = await call(dev, 'devImportMain', { rows: [{ material: 'Old breaker', unit: 'Nos', price: 1100, category: 'Electrical' }] });
check(r.ok && r.added === 1 && r.pruned === 1, 'main: the 2019 Old breaker price goes once a newer one is saved');
log = await sheet('Price history log');
check(log.some((v) => v[2] === 'Main price database' && v[3] === 'old breaker|nos|' && v[5] === '2019-06-30'), 'main pruning logged');

const rowsNow = (await sheet('Rate database')).length;
r = await call(owner, 'saveRates', { rates: [{ item: 'Duct 600x400', context: 'HVAC', unit: 'Sqm', supply: 990, sheet: 'BOQ C', row: 2, category: 'HVAC' }], uplift: 5 });
check(r.ok && r.added === 1, 'uploading a database workbook adds its rates');
check((await sheet('Rate database')).length === rowsNow + 1, 'the upload removed nothing');
r = await call(owner, 'saveRates', { rates: [{ item: 'Duct 600x400', context: 'HVAC', unit: 'Sqm', supply: 990, sheet: 'BOQ C', row: 2, category: 'HVAC' }], uplift: 5 });
check(r.ok && r.added === 0, 'the same workbook again adds nothing');
r = await call(owner, 'getRates');
check(r.rates.filter((x) => x.item === 'Duct 600x400').map((x) => x.supply).join() === '990', 'pricing: the duct at the newest 990');

// 4. Developer table data: every dated row, so the website can show the history.
r = await call(dev, 'devPrices', { target: 'main' });
check(r.ok && r.dated === true && r.prices.filter((p) => p.material === 'MCB 16A SP').length === 2 && r.prices.every((p) => /^\d{4}-\d\d-\d\d$/.test(p.date)), 'devPrices: dated rows, old and new');
const oldMcb = r.prices.find((p) => p.material === 'MCB 16A SP' && p.price === 150);
r = await call(dev, 'devUpdatePrice', { target: 'main', id: oldMcb.id, price: { material: 'MCB 16A SP', unit: 'Nos', price: 170, category: 'Electrical' } });
check(r.ok && r.added === 1, 'a developer change of price adds a dated row: ' + JSON.stringify(r));
r = await call(dev, 'devPrices', { target: 'main' });
check(r.prices.filter((p) => p.material === 'MCB 16A SP').length === 3, 'the MCB now has 3 dated prices');
r = await call(dev, 'devUsers');
check(r.ok && r.users.find((u) => u.uid === a.uid).count === 4, 'devUsers counts items, not dated rows: ' + r.users.find((u) => u.uid === a.uid).count);

// 5. Normal accounts: still no main database writes, no lists, no counts.
for (const act of ['devImportMain', 'devPrices', 'devUpdatePrice', 'devDeletePrices', 'devUsers']) {
  r = await call(a, act, { rows: [{ material: 'x', unit: 'Nos', price: 1, category: 'Others' }], target: 'main', ids: ['x'], id: 'x', price: { material: 'x', price: 1, category: 'Others' } });
  check(!r.ok && /developer/.test(r.error), `${act} refused for a normal account`);
}
r = await call(a, 'saveRates', { rates: [{ item: 'x', unit: 'Nos', supply: 1 }] });
check(!r.ok, 'a normal account cannot add to the main database');
r = await call(a, 'getRates');
check(r.ok && r.rates === null && !('counts' in r) && r.developer === false, 'a normal account: its own prices only, no counts');
console.log(fail.length ? `${fail.length} FAILED` : 'ALL PASSED');
process.exit(fail.length ? 1 : 0);
