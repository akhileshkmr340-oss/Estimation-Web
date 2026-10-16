// Settings for sign-up and login (see accounts/README.md).
//  firebase: the Firebase project's public web config (Firebase console >
//    Project settings > Your apps > Web app > Config). These values are
//    public by design.
//  profileScript: the Web app URL of the Apps Script (accounts/profiles.gs)
//    that keeps the profiles in a Google Sheet.
// While either is empty, accounts are off and the website works without
// logging in.
window.estimationAccounts = {
  firebase: null,
  profileScript: '',
};
