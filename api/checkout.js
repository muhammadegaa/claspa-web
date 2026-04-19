// Stripe Checkout session creator. Supports:
//   plan=lifetime   -> one-time $9, BYOK (no change)
//   plan=pro        -> $5/mo subscription with $3 credits allowance (new v2 price)
//   plan=topup_5    -> one-time top-up, credits added via webhook
//   plan=topup_10   -> one-time top-up
//   plan=topup_25   -> one-time top-up
//
// Top-ups require idToken so we can attach the user's uid to session metadata
// and credit their balance on webhook success.

const PLANS = {
  lifetime: {
    mode: 'payment',
    priceEnv: null, // legacy hardcoded below for backward compat
    priceLegacy: 'price_1TM0wHAgPm8MkVOnVWJOTDuQ',
    metadata: { plan: 'lifetime' },
  },
  pro: {
    mode: 'subscription',
    priceEnv: 'STRIPE_PRICE_PRO_MONTHLY',
    priceLegacy: 'price_1TM0wIAgPm8MkVOnPdZNs1Wl',
    metadata: { plan: 'pro' },
  },
  topup_5: {
    mode: 'payment',
    priceEnv: 'STRIPE_PRICE_TOPUP_5',
    metadata: { type: 'topup', credits_cents: '400' },
  },
  topup_10: {
    mode: 'payment',
    priceEnv: 'STRIPE_PRICE_TOPUP_10',
    metadata: { type: 'topup', credits_cents: '900' },
  },
  topup_25: {
    mode: 'payment',
    priceEnv: 'STRIPE_PRICE_TOPUP_25',
    metadata: { type: 'topup', credits_cents: '2400' },
  },
};

function resolvePrice(plan) {
  const cfg = PLANS[plan];
  if (!cfg) return null;
  if (cfg.priceEnv && process.env[cfg.priceEnv]) return process.env[cfg.priceEnv];
  if (cfg.priceLegacy) return cfg.priceLegacy;
  return null;
}

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

  try {
    const { plan, email, idToken } = req.body || {};
    const cfg = PLANS[plan];
    if (!cfg) return res.status(400).json({ error: 'Invalid plan' });

    const price = resolvePrice(plan);
    if (!price) {
      return res.status(500).json({ error: `Price not configured for ${plan}` });
    }

    // Top-ups require authenticated user (so we know who to credit).
    // Pro/lifetime: idToken is optional for backward compat, but when present
    // we attach uid so the webhook can link the purchase to the Firebase user.
    let uid = null;
    let userEmail = email || null;
    if (plan.startsWith('topup_')) {
      if (!idToken) return res.status(401).json({ error: 'Sign-in required for top-ups' });
      const user = await verifyIdToken(idToken);
      if (!user) return res.status(401).json({ error: 'Invalid token' });
      uid = user.localId;
      userEmail = user.email || userEmail;
    } else if (idToken) {
      const user = await verifyIdToken(idToken);
      if (user) {
        uid = user.localId;
        userEmail = user.email || userEmail;
      }
    }

    const baseUrl = process.env.BASE_URL || 'https://ravenote.xyz';
    const params = new URLSearchParams();
    params.append('mode', cfg.mode);
    params.append('line_items[0][price]', price);
    params.append('line_items[0][quantity]', '1');
    params.append('success_url', `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `${baseUrl}/#pricing`);

    // Metadata
    for (const [k, v] of Object.entries(cfg.metadata)) {
      params.append(`metadata[${k}]`, v);
    }
    if (uid) params.append('metadata[uid]', uid);
    params.append('metadata[plan]', plan);

    if (userEmail) params.append('customer_email', userEmail);

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await response.json();
    if (!response.ok) {
      console.error('Stripe API error:', JSON.stringify(session));
      return res.status(500).json({ error: session.error?.message || 'Stripe error' });
    }

    res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
