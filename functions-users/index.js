/**
 * Arzimate website: user management for the developer only (codebase 'users').
 *
 *   listUsers({pageToken})          every Firebase account, 1000 per page, with
 *                                   name / organisation / department / mobile
 *                                   from the profile Sheet when it can be read
 *   setUserDisabled({uid, disabled}) turns an account off (and signs it out
 *                                   everywhere) or back on
 *   deleteUser({uid})               removes the account and what the profile
 *                                   Sheet keeps for it (profile row, project
 *                                   details, its own prices)
 *
 * Who is the developer is decided on the server, never by the website: the
 * caller's verified ID token is sent to the profile Sheet script, whose
 * isDeveloper_ check (DEVELOPER_UIDS script property, the price database
 * owner, or the script owner's own Gmail) answers. A 'developer' custom claim,
 * which only someone with admin rights on the project can set, also counts.
 * Nobody can disable or delete their own account here. Every disable, enable
 * and delete is logged to Cloud Logging and to the Sheet's "User admin log".
 *
 * Deploy (needs the project owner's Firebase login):
 *   firebase deploy --only functions:users --project estimation-6fa32
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

// The profile Sheet script (public address, also in accounts-config.js).
const SCRIPT = process.env.SHEET_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycby_oL7V9tj9bHlM1EHNwuPkJCP-WUpnEWdIIwUmjx1FY37fgHKfNEsKNnuyQusBRnEB/exec';

const OPTIONS = { region: 'us-central1', cors: true, maxInstances: 2, timeoutSeconds: 120 };

/** Calls the Sheet script as the caller. Returns its JSON, or {ok:false, error}. */
async function script(action, idToken, extra) {
  try {
    const res = await fetch(SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, idToken }, extra || {})),
      redirect: 'follow',
    });
    const data = await res.json().catch(() => null);
    return data || { ok: false, error: 'The profile Sheet gave an unexpected answer (' + res.status + ').' };
  } catch (e) {
    return { ok: false, error: 'The profile Sheet did not answer.' };
  }
}

const outdated = (r) => !r.ok && /Unknown request/i.test(String(r.error || ''));

/** The caller, if they are the developer; otherwise throws permission-denied. */
async function developer(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Log in first.');
  const header = String((request.rawRequest && request.rawRequest.headers.authorization) || '');
  const idToken = header.replace(/^Bearer\s+/i, '');
  const me = { uid: request.auth.uid, email: String(request.auth.token.email || ''), idToken };
  if (request.auth.token.developer === true) return me;
  const r = await script('devCheck', idToken);
  if (outdated(r)) throw new HttpsError('failed-precondition', 'The Google Sheet script needs the update first.');
  if (!r.ok) throw new HttpsError('unavailable', r.error || 'Could not check your account.');
  if (r.developer !== true || r.uid !== me.uid) throw new HttpsError('permission-denied', 'Only the Arzimate developer can do this.');
  return me;
}

/** The account the request names, never the caller's own. */
async function target(request, me) {
  const uid = String((request.data && request.data.uid) || '');
  if (!uid || uid.length > 128) throw new HttpsError('invalid-argument', 'No account given.');
  if (uid === me.uid) throw new HttpsError('failed-precondition', 'You cannot change your own account here.');
  try {
    return await admin.auth().getUser(uid);
  } catch (e) {
    if (e.code === 'auth/user-not-found') throw new HttpsError('not-found', 'That account no longer exists.');
    throw e;
  }
}

/** Logs who did what to whom, in Cloud Logging and in the Sheet's "User admin log". */
async function audit(me, what, user, details) {
  const entry = { audit: 'user-admin', what, by: me.uid, byEmail: me.email, uid: user.uid, email: user.email || '', details: details || '', at: new Date().toISOString() };
  logger.info('User admin: ' + what + ' ' + (user.email || user.uid), entry);
  const r = await script('devAudit', me.idToken, { what, uid: user.uid, email: user.email || '', details: details || '' });
  return r.ok ? 'Cloud Logging and the Sheet' : 'Cloud Logging only (' + (outdated(r) ? 'the Sheet script needs the update' : r.error) + ')';
}

exports.listUsers = onCall(OPTIONS, async (request) => {
  const me = await developer(request);
  const pageToken = request.data && request.data.pageToken ? String(request.data.pageToken) : undefined;
  const page = await admin.auth().listUsers(1000, pageToken);
  const p = await script('devProfiles', me.idToken);
  const profiles = {};
  if (p.ok) for (const x of p.profiles || []) profiles[x.uid] = x;
  return {
    you: me.uid,
    profiles: p.ok ? 'ok' : outdated(p) ? 'outdated' : 'unavailable',
    nextPageToken: page.pageToken || null,
    users: page.users.map((u) => {
      const x = profiles[u.uid] || {};
      return {
        uid: u.uid,
        email: u.email || x.email || '',
        displayName: u.displayName || '',
        name: [x.firstName, x.lastName].filter(Boolean).join(' ') || u.displayName || '',
        organization: x.organization || '',
        department: x.department || '',
        mobile: x.mobile || '',
        created: u.metadata.creationTime ? new Date(u.metadata.creationTime).toISOString() : '',
        lastSignIn: u.metadata.lastSignInTime ? new Date(u.metadata.lastSignInTime).toISOString() : '',
        disabled: !!u.disabled,
        emailVerified: !!u.emailVerified,
        you: u.uid === me.uid,
      };
    }),
  };
});

exports.setUserDisabled = onCall(OPTIONS, async (request) => {
  const me = await developer(request);
  const user = await target(request, me);
  const disabled = !!(request.data && request.data.disabled);
  await admin.auth().updateUser(user.uid, { disabled });
  if (disabled) await admin.auth().revokeRefreshTokens(user.uid); // signed out everywhere
  const logged = await audit(me, disabled ? 'disable' : 'enable', user);
  return { uid: user.uid, disabled, logged };
});

exports.deleteUser = onCall(OPTIONS, async (request) => {
  const me = await developer(request);
  const user = await target(request, me);
  const r = await script('devDeleteUserData', me.idToken, { uid: user.uid });
  const sheet = r.ok ? r.removed : null;
  await admin.auth().deleteUser(user.uid);
  const details = sheet
    ? `account; Sheet rows: profile ${sheet.profile}, projects ${sheet.projects}, prices ${sheet.prices}`
    : 'account only; Sheet rows kept (' + (outdated(r) ? 'the Sheet script needs the update' : r.error) + ')';
  const logged = await audit(me, 'delete', user, details);
  return {
    uid: user.uid,
    removed: { account: true, profile: sheet ? sheet.profile : null, projects: sheet ? sheet.projects : null, prices: sheet ? sheet.prices : null },
    sheetError: sheet ? null : (outdated(r) ? 'The Google Sheet script needs the update first.' : r.error),
    logged,
  };
});
