const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRODUCTS = {
  lifetime: {
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: 'Claspa Lifetime', description: 'Unlimited lectures forever. Bring your own OpenRouter API key.' },
        unit_amount: 900, // $9
      },
      quantity: 1,
    }],
  },
  pro: {
    mode: 'subscription',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: 'Claspa Pro', description: 'Unlimited lectures with AI included. No API key needed.' },
        unit_amount: 300, // $3/mo
        recurring: { interval: 'month' },
      },
      quantity: 1,
    }],
  },
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { plan, email } = req.body || {};
    if (!plan || !PRODUCTS[plan]) return res.status(400).json({ error: 'Invalid plan. Use "lifetime" or "pro".' });

    const config = PRODUCTS[plan];
    const session = await stripe.checkout.sessions.create({
      ...config,
      customer_email: email || undefined,
      success_url: `${process.env.BASE_URL || 'https://claspa.app'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL || 'https://claspa.app'}/#pricing`,
      metadata: { plan },
    });

    res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
