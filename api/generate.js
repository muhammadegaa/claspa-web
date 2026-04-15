const STRIPE_API = 'https://api.stripe.com/v1';
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';

function stripeGet(path) {
  return fetch(`${STRIPE_API}${path}`, {
    headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  }).then(r => r.json());
}

async function kvGet(key) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  const data = await r.json();
  return data.result || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { licenseKey, idToken, messages, model, temperature, max_tokens } = req.body || {};

  if (!licenseKey && !idToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Validate Pro tier via Firebase idToken OR legacy license key
  let isValid = false;
  try {
    if (idToken) {
      // Firebase auth path — verify token and check Firestore tier
      const { db } = require('./lib/firebase-admin');
      const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
      const verifyRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
      );
      const verifyData = await verifyRes.json();
      const user = verifyData.users?.[0];
      if (user) {
        const userDoc = await db().doc(`users/${user.localId}`).get();
        if (userDoc.exists) {
          const tier = userDoc.data().tier;
          isValid = tier === 'pro';
        }
      }
    } else if (licenseKey?.startsWith('CLASPA-')) {
      // Legacy license key path
      const kvData = await kvGet(`license:${licenseKey}`);
      if (kvData) {
        const parsed = typeof kvData === 'string' ? JSON.parse(kvData) : kvData;
        isValid = parsed.active !== false && parsed.tier === 'pro';
      }
      if (!isValid) {
        const sessions = await stripeGet('/checkout/sessions?limit=100');
        const match = (sessions.data || []).find(s => s.metadata?.licenseKey === licenseKey && s.metadata?.plan === 'pro');
        if (match && match.subscription) {
          const sub = await stripeGet(`/subscriptions/${match.subscription}`);
          isValid = sub.status === 'active' || sub.status === 'trialing';
        }
      }
    }
  } catch (e) {
    console.error('Auth check error:', e.message);
    return res.status(500).json({ error: 'Authorization failed' });
  }

  if (!isValid) {
    return res.status(403).json({ error: 'Pro subscription required for API proxy' });
  }

  // Proxy to OpenRouter with our key
  try {
    const orRes = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://claspa-web.vercel.app',
        'X-Title': 'Claspa Pro',
      },
      body: JSON.stringify({
        model: model || 'anthropic/claude-sonnet-4.6',
        messages,
        temperature: temperature || 0.25,
        max_tokens: max_tokens || 1600,
      }),
    });

    const data = await orRes.json();
    if (!orRes.ok) {
      return res.status(orRes.status).json({ error: data.error?.message || 'AI request failed' });
    }

    res.status(200).json(data);
  } catch (e) {
    console.error('OpenRouter proxy error:', e.message);
    res.status(500).json({ error: 'AI service error' });
  }
};
