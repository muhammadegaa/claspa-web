const admin = require('firebase-admin');

let _app = null;

function getAdmin() {
  if (_app) return _app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');

  const serviceAccount = typeof raw === 'string' ? JSON.parse(raw) : raw;

  _app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id || 'claspa-7ef52',
  });

  return _app;
}

function db() {
  return getAdmin().firestore();
}

function auth() {
  return getAdmin().auth();
}

module.exports = { getAdmin, db, auth };
