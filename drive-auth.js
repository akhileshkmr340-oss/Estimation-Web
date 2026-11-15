// Google Drive access for "Save project files to my Google Drive" (Settings), with the
// narrow drive.file scope: Arzimate can only see and change the files and folders it
// makes itself in the user's own Drive, nothing else there. The token comes from Google
// Identity Services in this browser tab and is kept in this tab only (sessionStorage, so a
// reload keeps it; it runs out after about an hour); it is never sent to Arzimate's servers. Needs `googleClientId` in accounts-config.js (an
// OAuth web client ID of the Google Cloud project, public by design); without it the
// setting stays off and nothing is loaded.
(function () {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const clientId = String((window.estimationAccounts || {}).googleClientId || '').trim();
  const GRANTED = 'arzimate.googleDriveGranted';
  let loading = null;
  let client = null;
  const KEPT = 'arzimate.googleDriveToken';
  let token = null;
  let expires = 0;
  let owner = ''; // the Arzimate account the token was given to
  try {
    const k = JSON.parse(sessionStorage.getItem(KEPT) || 'null');
    if (k && k.token && k.expires > Date.now()) { token = k.token; expires = k.expires; owner = k.owner || ''; }
  } catch (_) {}
  function keep() {
    try { token ? sessionStorage.setItem(KEPT, JSON.stringify({ token, expires, owner })) : sessionStorage.removeItem(KEPT); } catch (_) {}
  }
  let asking = '';
  let waiting = null;

  function settle(ok, value) {
    const w = waiting;
    waiting = null;
    if (w) (ok ? w.resolve : w.reject)(value);
  }

  function load() {
    if (!clientId) return Promise.reject(new Error('Google Drive saving is not set up on this website yet.'));
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = resolve;
        s.onerror = () => { loading = null; reject(new Error('Google sign-in could not load. Check the internet and try again.')); };
        document.head.appendChild(s);
      });
    }
    return loading.then(() => {
      if (!client) {
        client = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE,
          callback: (r) => {
            if (r.error) return settle(false, new Error(r.error_description || r.error));
            if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
              return settle(false, new Error('Google Drive access was not allowed. Tick the Drive box when Google asks.'));
            }
            token = r.access_token;
            expires = Date.now() + (Number(r.expires_in) - 120) * 1000;
            owner = asking;
            keep();
            try { localStorage.setItem(GRANTED, '1'); } catch (_) {}
            settle(true, token);
          },
          error_callback: (e) => settle(false, new Error(e && e.type === 'popup_failed_to_open'
            ? 'The Google window was blocked. Allow pop-ups for this site and try again.'
            : 'Google sign-in was closed before it finished.')),
        });
      }
      return client;
    });
  }

  window.arzimateGoogle = {
    configured() { return !!clientId; },
    // Loads Google's script ahead of time, so a later button press can open its window at once.
    preload() { return load().then(() => true, () => false); },
    // A Drive token. interactive=false never opens a window (background saving): it fails
    // with 'reconnect' once the token has run out, and the page offers Retry. interactive=true
    // must be called from a button press.
    // `user` is the Arzimate account (uid): a token given to another account is never used.
    token(interactive, hint, user) {
      user = String(user || '');
      if (token && Date.now() < expires && owner === user) return Promise.resolve(token);
      if (!interactive) return Promise.reject(new Error('reconnect'));
      return load().then((c) => new Promise((resolve, reject) => {
        settle(false, new Error('Google sign-in was started again.'));
        waiting = { resolve, reject };
        asking = user;
        let granted = false;
        try { granted = localStorage.getItem(GRANTED) === '1'; } catch (_) {}
        c.requestAccessToken({ prompt: granted ? '' : 'consent', login_hint: hint || undefined });
      }));
    },
    // Switch off: forget the token in this tab.
    forget() { token = null; expires = 0; keep(); },
  };
})();
