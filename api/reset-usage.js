const { db } = require('./lib/firebase-admin');

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'Missing idToken' });

  try {
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    const data = await verifyRes.json();
    const user = data.users?.[0];
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    const uid = user.localId;
    const today = new Date().toISOString().slice(0, 10);

    await db().doc(`users/${uid}`).update({
      usage: { date: today, count: 0 },
      updatedAt: new Date().toISOString(),
    });

    res.status(200).json({ ok: true, usage: { date: today, count: 0 } });
  } catch (err) {
    console.error('Reset usage error:', err.message);
    res.status(500).json({ error: 'Reset failed' });
  }
};
