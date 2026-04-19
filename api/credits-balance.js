// GET-style endpoint (POST for CORS consistency) that returns a user's current
// credit balance. Called by the extension popup to show "remaining this month"
// and the exhaustion modal's exact numbers.

const { db } = require('./lib/firebase-admin');
const {
  ensureCreditFields,
  maybeResetMonthly,
  getBalance,
} = require('./lib/credits');

async function verifyIdToken(idToken) {
  const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  const data = await res.json();
  return data.users?.[0] || null;
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
    const CREDITS_ENABLED = process.env.CREDITS_SYSTEM_ENABLED === 'true';

    if (!CREDITS_ENABLED) {
      // Credits system disabled — return tier only
      const snap = await db().doc(`users/${uid}`).get();
      const tier = snap.exists ? (snap.data().tier || 'free') : 'free';
      return res.status(200).json({
        enabled: false,
        tier,
      });
    }

    await ensureCreditFields(uid);
    await maybeResetMonthly(uid);

    const b = await getBalance(uid);

    // Compute next reset date (30 days after period_start)
    let nextReset = null;
    if (b.period_start) {
      const start = new Date(b.period_start);
      nextReset = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    }

    return res.status(200).json({
      enabled: true,
      tier: b.tier,
      monthly_cents: b.monthly_cents,
      topup_cents: b.topup_cents,
      total_cents: b.total_cents,
      included_cents: b.included_cents,
      period_start: b.period_start,
      next_reset: nextReset,
    });
  } catch (err) {
    console.error('Credit balance error:', err.message);
    return res.status(500).json({ error: 'Balance lookup failed' });
  }
};
