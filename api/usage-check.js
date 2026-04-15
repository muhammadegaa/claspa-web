const { db } = require('./lib/firebase-admin');

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FREE_DAILY_LIMIT = 3;

async function verifyIdToken(idToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );
  const data = await res.json();
  if (!res.ok || !data.users?.[0]) return null;
  return data.users[0];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'Missing idToken' });

  try {
    const user = await verifyIdToken(idToken);
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    const uid = user.localId;
    const userRef = db().doc(`users/${uid}`);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(200).json({ allowed: true, tier: 'free', used: 0, limit: FREE_DAILY_LIMIT });
    }

    const userData = userDoc.data();
    const tier = userData.tier || 'free';

    // Paid users: unlimited
    if (tier === 'lifetime' || tier === 'pro') {
      return res.status(200).json({ allowed: true, tier, used: 0, limit: -1 });
    }

    // Free tier: check + increment atomically
    const today = new Date().toISOString().slice(0, 10);
    const usage = userData.usage || { date: today, count: 0 };

    // Reset if new day
    if (usage.date !== today) {
      usage.date = today;
      usage.count = 0;
    }

    if (usage.count >= FREE_DAILY_LIMIT) {
      return res.status(200).json({
        allowed: false,
        tier: 'free',
        used: usage.count,
        limit: FREE_DAILY_LIMIT,
        reason: 'LIMIT_REACHED',
      });
    }

    // Increment
    usage.count++;
    await userRef.update({ usage, updatedAt: new Date().toISOString() });

    return res.status(200).json({
      allowed: true,
      tier: 'free',
      used: usage.count,
      limit: FREE_DAILY_LIMIT,
    });
  } catch (err) {
    console.error('Usage check error:', err.message);
    res.status(500).json({ error: 'Usage check failed' });
  }
};
