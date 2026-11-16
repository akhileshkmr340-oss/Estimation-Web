// "Forgot password?" through the Sheet script: the link is emailed from the
// owner's Gmail, the answer never says whether the account exists, requests
// are rate limited, and the link is never logged. Run with the Auth emulator
// (project demo-estimation) and gas_stub.mjs.
const EMU = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key';
const GAS = 'http://127.0.0.1:8787/exec';
const fail = [];
const check = (ok, what) => { console.log(ok ? 'OK  ' : 'FAIL', what); if (!ok) fail.push(what); };
const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const reset = (email) => post(GAS, { action: 'resetPassword', email });
const mails = async () => (await fetch('http://127.0.0.1:8787/mails')).json();
const rows = async () => (await fetch('http://127.0.0.1:8787/rows?sheet=' + encodeURIComponent('Password resets'))).json();

const t = Date.now();
const known = `Known${t}@Example.com`;
const r0 = await post(EMU, { email: known, password: 'secret123', returnSecureToken: true });
if (!r0.idToken) throw new Error(JSON.stringify(r0));
const before = (await mails()).length;

const a = await reset(known);
const b = await reset(`nobody${t}@example.com`);
check(a.ok === true && JSON.stringify(a) === JSON.stringify(b), 'known and unknown email get the same answer: ' + a.message);
check(/a reset link is on its way from Arzimate\. Check Junk too\./.test(a.message), 'the answer is the generic message');
check(!(await reset('not-an-email')).ok, 'an invalid email is refused');

const sent = (await mails()).slice(before);
check(sent.length === 1 && sent[0].to === known.toLowerCase(), 'one mail, to the known account only');
const m = sent[0] || {};
check(m.subject === 'Reset your Arzimate password' && m.name === 'Arzimate', 'subject and sender name');
const link = (String(m.text).match(/https?:\/\/\S*oobCode=\S+/) || [])[0] || '';
check(!!link && m.htmlBody.includes('Reset password') && m.htmlBody.includes(link.replace(/&/g, '&amp;')), 'the link is in the text and as a button: ' + link.slice(0, 70) + '…');
check(m.text.includes('This link works once and expires in about an hour. If you did not ask for it, ignore this email.'), 'the expiry line is there');

// The link really resets the password (the Auth emulator's action handler).
const code = new URL(link).searchParams.get('oobCode');
const done = await post('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=fake-api-key', { oobCode: code, newPassword: 'newsecret456' });
check(done.email && done.email.toLowerCase() === known.toLowerCase(), 'the emailed link resets the password');

// Rate limit: 3 an hour per email; the 4th gets the same answer but no mail.
await reset(known); await reset(known);
const n = (await mails()).length;
const over = await reset(known);
check(JSON.stringify(over) === JSON.stringify(a) && (await mails()).length === n, 'the 4th request this hour: same answer, no mail');

// Log: masked email, result, never the link.
const log = await rows();
const flat = JSON.stringify(log);
check(log.length >= 6 && !flat.includes('oobCode') && !flat.includes(code) && !flat.includes(known.toLowerCase()), 'log has no link and no full email');
check(log.slice(1).some((r) => r[2] === 'sent') && log.slice(1).some((r) => r[2] === 'no such account, not sent') && log.slice(1).some((r) => r[2] === 'over the limit, not sent'), 'log results: ' + [...new Set(log.slice(1).map((r) => r[2]))].join('; '));
check(log.slice(1).every((r) => /^.\*\*\*@/.test(r[1])), 'emails are masked: ' + log[1][1]);
console.log(fail.length ? `${fail.length} FAILED` : 'ALL PASSED');
process.exit(fail.length ? 1 : 0);
