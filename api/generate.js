const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { licenseKey, messages, model, temperature, max_tokens } = req.body || {};

  if (!licenseKey || !licenseKey.startsWith('CLASPA-')) {
    return res.status(401).json({ error: 'Invalid license key' });
  }

  // Validate license is Pro tier
  let isValid = false;
  try {
    if (process.env.KV_REST_API_URL) {
      const { kv } = require('@vercel/kv');
      const data = await kv.get(`license:${licenseKey}`);
      if (data) {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        isValid = parsed.active !== false && parsed.tier === 'pro';
      }
    }
    if (!isValid) {
      // Fallback: check Stripe sessions
      const sessions = await stripe.checkout.sessions.list({ limit: 100 });
      const match = sessions.data.find(s => s.metadata?.licenseKey === licenseKey && s.metadata?.plan === 'pro');
      if (match && match.subscription) {
        const sub = await stripe.subscriptions.retrieve(match.subscription);
        isValid = sub.status === 'active' || sub.status === 'trialing';
      }
    }
  } catch (e) {
    console.error('License check error:', e.message);
    return res.status(500).json({ error: 'License validation failed' });
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
        'HTTP-Referer': 'https://claspa.app',
        'X-Title': 'Claspa Pro',
      },
      body: JSON.stringify({
        model: model || 'anthropic/claude-3.5-haiku',
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
