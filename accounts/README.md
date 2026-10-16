# Sign-up and login

The website's accounts use **Firebase Authentication** (email and password) and
keep each user's profile as one row of a **Google Sheet in the owner's Drive**.

- Firebase keeps the passwords. They never reach the Sheet.
- `profiles.gs` is a Google Apps Script web app bound to the Sheet. Before it
  reads or writes, it checks the caller's Firebase ID token with Google, and it
  only ever reads or writes the row for that token's user ID. A request without
  a valid token is refused.
- Columns: User ID, First name, Last name, Organization, Department, Mobile,
  Email, Signed up, Updated. The email comes from the verified token.
- Drawings and Excel outputs are still never stored or uploaded.

Until `web/accounts-config.js` is filled in, accounts are off and the website
opens straight to the projects screen.

## One-time setup (owner)

### 1. Firebase project (login)
1. Open https://console.firebase.google.com, click **Create a project**, name it
   (for example `estimation-web`), and finish (Google Analytics is not needed).
2. **Build > Authentication > Get started > Sign-in method > Email/Password >
   Enable > Save.**
3. **Authentication > Settings > Authorized domains > Add domain:**
   `akhileshkmr340-oss.github.io`
4. **Project settings (gear) > General > Your apps > Web (`</>`)**, give it a
   nickname, **Register app** (no Hosting). Copy the `firebaseConfig` block it
   shows. These values are public by design; they are not a password.

### 2. Google Sheet and script (profile store)
1. Create a new Google Sheet in your Drive, for example "Estimation users".
2. In the Sheet: **Extensions > Apps Script.** Delete what is there and paste
   the whole of `profiles.gs`.
3. On the line `const FIREBASE_API_KEY = 'PASTE_YOUR_FIREBASE_API_KEY';` put the
   `apiKey` value from the Firebase config. Save.
4. **Deploy > New deployment > Select type: Web app.**
   Execute as: **Me**. Who has access: **Anyone**. Click **Deploy**, allow the
   permissions Google asks for, and copy the **Web app URL** (ends in `/exec`).

### 3. Send two things
Send the `firebaseConfig` block and the Web app URL. They go into
`web/accounts-config.js`:

```js
window.estimationAccounts = {
  firebase: { apiKey: '...', authDomain: '...', projectId: '...', appId: '...' },
  profileScript: 'https://script.google.com/macros/s/.../exec',
};
```

If `profiles.gs` is changed later, use **Deploy > Manage deployments > Edit >
Version: New version** so the URL stays the same.

## Projects tab (project details)

Since 16 Oct 2026 the script also keeps each user's project details in a
"Projects" tab: name, client / site, pricing (Auto or Manual), margin % and
discount %. Drawings, extracted items and Excel files are never saved. The
tab is created by the script the first time a project is saved.

To update an existing script to this version:

1. Open the Google Sheet, then **Extensions > Apps Script**.
2. Select everything in `Code.gs` and delete it. Paste the whole of
   `profiles.gs` (its `FIREBASE_API_KEY` already holds your web API key).
   Click **Save** (the disk icon).
3. Click **Deploy > Manage deployments**. Select the existing web app, click
   the pencil (**Edit**), set **Version** to **New version**, and click
   **Deploy**. The web app URL stays the same.

Until this is done the website keeps projects in the open tab only and says
so on the Projects page.

## Testing locally

1. `firebase emulators:start --only auth --project demo-estimation` (Auth emulator on port 9099).
2. `node accounts/test/gas_stub.mjs accounts/profiles.gs` runs the script with an
   in-memory Sheet on port 8787 (`/rows` shows the Sheet).
3. Serve `build/web` on port 8080 with an `accounts-config.js` whose `firebase`
   block has `apiKey: 'fake-api-key'`, `projectId: 'demo-estimation'` and
   `emulator: 'http://127.0.0.1:9099'`, and `profileScript: 'http://127.0.0.1:8787/exec'`.
4. `node accounts/test/e2e_auth.mjs` (Playwright): sign up, the row, log out,
   wrong password, log in, reload, duplicate email.
