const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const data = await kv.get(`license:${key}`);
      if (data) {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        // For subscriptions, verify still active with Stripe
        if (parsed.tier === 'pro' && parsed.stripeSubscriptionId) {
          try {
            const sub = await stripe.subscriptions.retrieve(parsed.stripeSubscriptionId);
            if (sub.status !== 'active' && sub.status !== 'trialing') {
              return res.status(200).json({ valid: false, tier: parsed.tier, reason: 'Subscription inactive' });
            }
          } catch (e) {
            // If we can't verify, trust stored state
          }
        }
        return res.status(200).json({ valid: parsed.active !== false, tier: parsed.tier, email: parsed.email });
      }
    }

    // Fallback: search Stripe checkout sessions by metadata
    const sessions = await stripe.checkout.sessions.list({ limit: 100 });
    const match = sessions.data.find(s => s.metadata?.licenseKey === key);
    if (match) {
      const tier = match.metadata?.plan || 'lifetime';
      // For pro, verify subscription is active
      if (tier === 'pro' && match.subscription) {
        const sub = await stripe.subscriptions.retrieve(match.subscription);
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
