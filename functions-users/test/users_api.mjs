// listUsers / setUserDisabled / deleteUser through the Functions and Auth
// emulators, with gas_stub.mjs standing in for the profile Sheet script.
// Run: firebase emulators:exec in this folder with SHEET_SCRIPT_URL=http://127.0.0.1:8787/exec
// and the stub started with GMAIL=<developer email> (passed here as argv[2]).
const KEY = 'fake-api-key';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
const FN = 'http://127.0.0.1:5001/demo-estimation/us-central1/';
const GAS = 'http://127.0.0.1:8787/exec';
const devEmail = process.argv[2] || 'owner@gmail.com';
const fail = [];
const check = (ok, what) => { console.log(ok ? 'OK  ' : 'FAIL', what); if (!ok) fail.push(what); };
const post = async (url, body, token) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })).json();
async function account(email) {
  const r = await post(`${AUTH}:signUp?key=${KEY}`, { email, password: 'secret123', returnSecureToken: true });
  if (!r.idToken) throw new Error(JSON.stringify(r));
  return { token: r.idToken, uid: r.localId, email };
}
const signIn = (email) => post(`${AUTH}:signInWithPassword?key=${KEY}`, { email, password: 'secret123', returnSecureToken: true });
const call = (who, name, data = {}) => post(FN + name, { data }, who && who.token);
const gas = (who, action, body = {}) => post(GAS, { idToken: who.token, action, ...body });
const rows = async (sheet) => (await fetch('http://127.0.0.1:8787/rows?sheet=' + encodeURIComponent(sheet))).json();
const status = (r) => r.error && r.error.status;

const t = Date.now();
const dev = await account(devEmail);
const a = await account(`a${t}@example.com`);
const b = await account(`b${t}@example.com`);
for (const [who, first] of [[a, 'Asha'], [b, 'Bala']]) {
  const r = await gas(who, 'save', { profile: { firstName: first, lastName: 'Test', organization: 'Acme ' + first, department: 'Estimation', mobile: '+91 98765 43210' } });
  if (!r.ok) throw new Error('profile: ' + JSON.stringify(r));
}
await gas(b, 'addPrices', { rows: [{ material: 'MCB', unit: 'Nos', price: 150, category: 'Electrical' }], mode: 'keep' });

// Not signed in, and a normal user: refused for all three.
check(status(await call(null, 'listUsers')) === 'UNAUTHENTICATED', 'not signed in: unauthenticated');
for (const [name, data] of [['listUsers', {}], ['setUserDisabled', { uid: b.uid, disabled: true }], ['deleteUser', { uid: b.uid }]]) {
  const r = await call(a, name, data);
  check(status(r) === 'PERMISSION_DENIED', `normal user: ${name} permission-denied`);
}
check(status(await call(a, 'listUsers', { developer: true })) === 'PERMISSION_DENIED', 'a "developer" flag from the browser changes nothing');

// Developer: list.
let r = await call(dev, 'listUsers');
const list = (r.result && r.result.users) || [];
const ua = list.find((u) => u.uid === a.uid);
check(list.length >= 3 && r.result.profiles === 'ok' && r.result.you === dev.uid, `developer lists ${list.length} accounts with profiles`);
check(ua && ua.name === 'Asha Test' && ua.organization === 'Acme Asha' && ua.department === 'Estimation' && ua.mobile === '+91 98765 43210' && ua.created && ua.lastSignIn && ua.disabled === false, 'profile details and dates merged: ' + JSON.stringify(ua));

// Developer: disable, then enable.
r = await call(dev, 'setUserDisabled', { uid: a.uid, disabled: true });
check(r.result && r.result.disabled === true, 'developer disables an account');
let s = await signIn(a.email);
check(s.error && /USER_DISABLED/.test(s.error.message), 'the disabled account cannot sign in');
r = await call(dev, 'listUsers');
check(r.result.users.find((u) => u.uid === a.uid).disabled === true, 'the list shows it as disabled');
r = await call(dev, 'setUserDisabled', { uid: a.uid, disabled: false });
s = await signIn(a.email);
check(r.result && r.result.disabled === false && s.idToken, 'developer enables it again; it can sign in');

// Never the developer's own account.
check(status(await call(dev, 'setUserDisabled', { uid: dev.uid, disabled: true })) === 'FAILED_PRECONDITION', 'own account cannot be disabled');
check(status(await call(dev, 'deleteUser', { uid: dev.uid })) === 'FAILED_PRECONDITION', 'own account cannot be deleted');
check(status(await call(dev, 'deleteUser', { uid: 'nobody' })) === 'NOT_FOUND', 'unknown account: not-found');

// Developer: delete removes the account and the Sheet rows.
r = await call(dev, 'deleteUser', { uid: b.uid });
check(r.result && r.result.removed.account === true && r.result.removed.profile === 1 && r.result.removed.prices === 1, 'delete removes: ' + JSON.stringify(r.result && r.result.removed));
s = await signIn(b.email);
check(s.error && /EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS/.test(s.error.message), 'the deleted account is gone from Auth');
const users = await rows('Users');
check(!users.some((v) => v[0] === b.uid) && users.some((v) => v[0] === a.uid), 'its profile row is gone, others kept');
check(!(await rows('User prices')).some((v) => v[0] === b.uid), 'its prices are gone');

// Audit: who, whom, when.
const log = (await rows('User admin log')).slice(1);
check(log.length === 3 && log.map((v) => v[3]).join(',') === 'disable,enable,delete' && log.every((v) => v[1] === dev.uid && v[2] === devEmail && v[0]), 'audit log: ' + log.map((v) => `${v[3]} ${v[5]}`).join('; '));
check(log[2][5] === b.email && /profile 1/.test(log[2][6]), 'the delete line names the account and what went');

// The Sheet actions themselves refuse normal users.
for (const act of ['devCheck', 'devProfiles', 'devDeleteUserData', 'devAudit']) {
  r = await gas(a, act, { uid: dev.uid, what: 'delete' });
  check(act === 'devCheck' ? r.ok && r.developer === false : !r.ok, `script ${act}: no developer rights for a normal user`);
}
console.log(fail.length ? `${fail.length} FAILED` : 'ALL PASSED');
process.exit(fail.length ? 1 : 0);
