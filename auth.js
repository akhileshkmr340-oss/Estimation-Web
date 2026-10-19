// Accounts for the Estimation website: sign up and log in with email and
// password (Firebase Authentication). Each user's profile (name,
// organization, department, mobile, email) is a row of a Google Sheet in the
// owner's Drive, written by a Google Apps Script web app (accounts/
// profiles.gs) that checks the user's Firebase ID token first. Passwords stay
// with Firebase. Only account data is kept; drawings and outputs never leave
// the browser. The settings are in accounts-config.js; until they are filled
// in, accounts are off and the website works without logging in.
(function () {
  'use strict';

  const base = new URL('.', document.baseURI).href;
  const settings = window.estimationAccounts || {};
  const config = settings.firebase || null;
  const script = settings.profileScript || '';
  // Live price search service (server/price-search); off while empty.
  const priceSearch = settings.priceSearch || '';
  const configured = !!(config && config.apiKey && script);
  let ready = null;
  let auth = null;

  function load(src, ordered) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + src;
      if (ordered) s.async = false;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  function start() {
    if (!configured) return Promise.reject(new Error('Accounts are not set up yet.'));
    if (!ready) {
      ready = (async () => {
        // Both files download at once and run in order (app, then auth).
        await Promise.all([load('firebase/firebase-app-compat.js', true), load('firebase/firebase-auth-compat.js', true)]);
        const { emulator, ...options } = config;
        const app = window.firebase.initializeApp(options);
        auth = app.auth();
        if (emulator) auth.useEmulator(emulator, { disableWarnings: true });
      })();
    }
    return ready;
  }

  const messages = {
    'auth/email-already-in-use': 'An account with this email already exists. Log in instead.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/weak-password': 'Use a password of at least 6 characters.',
    'auth/invalid-credential': 'The email or password is not right.',
    'auth/wrong-password': 'The email or password is not right.',
    'auth/user-not-found': 'The email or password is not right.',
    'auth/user-disabled': 'This account has been turned off.',
    'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
    'auth/network-request-failed': 'No connection. Check the internet and try again.',
    'auth/operation-not-allowed': 'Email sign-in is not switched on for this website yet.',
  };
  const friendly = (e) => new Error(messages[e && e.code] || (e && e.message) || String(e));

  // Calls the profile script. Sent as text/plain so the browser makes a
  // simple request that Apps Script accepts from another site.
  async function call(action, extra) {
    const idToken = await auth.currentUser.getIdToken();
    let res;
    try {
      res = await fetch(script, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, idToken }, extra || {})),
      });
    } catch (e) {
      throw new Error('the profile store (Google Sheet script) did not answer. Check the internet; if it keeps happening, the script must be deployed with access set to Anyone.');
    }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!data || !data.ok) throw new Error((data && data.error) || 'the profile store gave an unexpected answer (' + res.status + ').');
    return data;
  }

  const user = (u) => (u ? JSON.stringify({ uid: u.uid, email: u.email || '' }) : null);

  // Start loading Firebase now, while the app itself downloads.
  if (configured) start().catch(() => {});

  window.estimationAuth = {
    configured: () => configured,

    // Calls back with the signed-in user (JSON) or null, now and on changes.
    onChange: async (cb) => {
      try {
        await start();
        auth.onAuthStateChanged((u) => cb(user(u)));
      } catch (e) {
        cb(null);
      }
    },

    // Creates the account. The profile is saved separately (saveProfile),
    // so the account is kept even if the profile store cannot be reached.
    signUp: async (email, password) => {
      await start();
      try {
        return user((await auth.createUserWithEmailAndPassword(email, password)).user);
      } catch (e) {
        throw friendly(e);
      }
    },

    saveProfile: async (profileJson) => {
      await start();
      const p = JSON.parse(profileJson);
      try {
        await call('save', { profile: p });
      } catch (e) {
        throw friendly(e);
      }
      try { await auth.currentUser.updateProfile({ displayName: (p.firstName + ' ' + p.lastName).trim() }); } catch (_) {}
    },

    signIn: async (email, password) => {
      await start();
      try {
        return user((await auth.signInWithEmailAndPassword(email, password)).user);
      } catch (e) {
        throw friendly(e);
      }
    },

    signOut: async () => {
      await start();
      await auth.signOut();
    },

    resetPassword: async (email) => {
      await start();
      try {
        await auth.sendPasswordResetEmail(email);
      } catch (e) {
        throw friendly(e);
      }
    },

    // The signed-in user's saved project details (JSON list). Throws
    // 'outdated' when the Sheet script has no project support yet.
    projects: async () => {
      await start();
      if (!auth.currentUser) return '[]';
      try {
        return JSON.stringify((await call('listProjects')).projects || []);
      } catch (e) {
        if (/Unknown request/.test(e.message)) throw new Error('outdated');
        throw e;
      }
    },

    saveProject: async (projectJson) => {
      await start();
      if (!auth.currentUser) return;
      try {
        await call('saveProject', { project: JSON.parse(projectJson) });
      } catch (e) {
        if (/Unknown request/.test(e.message)) throw new Error('outdated');
        throw e;
      }
    },

    // Live price search: only for signed-in users, as the search keys cost
    // money. Sends one item and returns the service's answer (JSON).
    priceSearchConfigured: () => configured && !!priceSearch,

    searchPrices: async (itemJson) => {
      await start();
      if (!auth.currentUser) throw new Error('Log in to search prices.');
      const idToken = await auth.currentUser.getIdToken();
      let res;
      try {
        res = await fetch(priceSearch, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
          body: itemJson,
        });
      } catch (e) {
        throw new Error('The price search service did not answer. Check the internet and try again.');
      }
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (!data || !data.ok) throw new Error((data && data.error) || 'The price search gave an unexpected answer (' + res.status + ').');
      return JSON.stringify(data);
    },

    openLink: (url) => {
      if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener');
    },

    deleteProject: async (id) => {
      await start();
      if (!auth.currentUser) return;
      try {
        await call('deleteProject', { id });
      } catch (e) {
        if (/Unknown request/.test(e.message)) throw new Error('outdated');
        throw e;
      }
    },

    // The user's price database from the Sheet (JSON: rates, uplift,
    // updated, file); rates is null when there is none or this account may
    // not use it. Throws 'outdated' when the script predates it.
    rates: async () => {
      await start();
      if (!auth.currentUser) return JSON.stringify({ rates: null });
      try {
        return JSON.stringify(await call('getRates'));
      } catch (e) {
        if (/Unknown request/.test(e.message)) throw new Error('outdated');
        throw e;
      }
    },

    // Saves the price database (rates, uplift, fileName, fileBase64) to the
    // Sheet and the workbook to Drive. Returns JSON: count, updated, file.
    saveRates: async (json) => {
      await start();
      if (!auth.currentUser) throw new Error('Log in to save your price database.');
      try {
        return JSON.stringify(await call('saveRates', JSON.parse(json)));
      } catch (e) {
        if (/Unknown request/.test(e.message)) throw new Error('outdated');
        throw e;
      }
    },

    // The signed-in user's profile as JSON, or null.
    profile: async () => {
      await start();
      if (!auth.currentUser) return null;
      const data = await call('get');
      return data.profile ? JSON.stringify(data.profile) : null;
    },
  };
})();
