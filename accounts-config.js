// Settings for sign-up and login (see accounts/README.md).
//  firebase: the Firebase project's public web config (Firebase console >
//    Project settings > Your apps > Web app > Config). These values are
//    public by design.
//  profileScript: the Web app URL of the Apps Script (accounts/profiles.gs)
//    that keeps the profiles in a Google Sheet.
// While either is empty, accounts are off and the website works without
// logging in.
window.estimationAccounts = {
  firebase: {
    apiKey: 'AIzaSyDn181WEUUq6Dw9F0-2OgXzm0vbe6cfLkI',
    authDomain: 'estimation-6fa32.firebaseapp.com',
    projectId: 'estimation-6fa32',
    storageBucket: 'estimation-6fa32.firebasestorage.app',
    messagingSenderId: '532959505940',
    appId: '1:532959505940:web:bbca06110ffa1ed628c101',
  },
  profileScript: 'https://script.google.com/macros/s/AKfycby_oL7V9tj9bHlM1EHNwuPkJCP-WUpnEWdIIwUmjx1FY37fgHKfNEsKNnuyQusBRnEB/exec',
};
