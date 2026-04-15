const STRIPE_API = 'https://api.stripe.com/v1';

function stripeGet(path) {
  return fetch(`${STRIPE_API}${path}`, {
    headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  }).then(r => r.json());
}

async function kvGet(key) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const res = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  const data = await res.json();
  return data.result || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { key } = req.query;
  if (!key || !key.startsWith('CLASPA-')) {
    return res.status(400).json({ valid: false, error: 'Invalid license key format' });
  }

  try {
    // Try Vercel KV first
    const kvData = await kvGet(`license:${key}`);
    if (kvData) {
      const parsed = typeof kvData === 'string' ? JSON.parse(kvData) : kvData;
      // For subscriptions, verify still active with Stripe
      if (parsed.tier === 'pro' && parsed.stripeSubscriptionId) {
        try {
          const sub = await stripeGet(`/subscriptions/${parsed.stripeSubscriptionId}`);
          if (sub.status !== 'active' && sub.status !== 'trialing') {
            return res.status(200).json({ valid: false, tier: parsed.tier, reason: 'Subscription inactive' });
          }
        } catch (e) {
          // If we can't verify, trust stored state
        }
      }
      return res.status(200).json({ valid: parsed.active !== false, tier: parsed.tier, email: parsed.email });
    }

    // Fallback: search Stripe checkout sessions by metadata
    const sessions = await stripeGet('/checkout/sessions?limit=100');
    const match = (sessions.data || []).find(s => s.metadata?.licenseKey === key);
    if (match) {
      const tier = match.metadata?.plan || 'lifetime';
      if (tier === 'pro' && match.subscription) {
        const sub = await stripeGet(`/subscriptions/${match.subscription}`);
        if (sub.status !== 'active' && sub.status !== 'trialing') {
          return res.status(200).json({ valid: false, tier, reason: 'Subscription cancelled' });
        }
      }
      return res.status(200).json({ valid: true, tier, email: match.customer_email || '' });
    }

    return res.status(200).json({ valid: false, error: 'License key not found' });
  } catch (err) {
    console.error('Validate error:', err.message);
    res.status(500).json({ valid: false, error: 'Validation service error' });
  }
};
