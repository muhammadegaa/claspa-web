const PRODUCTS = {
  lifetime: {
    mode: 'payment',
    line_items: [{ price: 'price_1TM0wHAgPm8MkVOnVWJOTDuQ', quantity: 1 }],
  },
  pro: {
    mode: 'subscription',
    line_items: [{ price: 'price_1TM0wIAgPm8MkVOnPdZNs1Wl', quantity: 1 }],
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
    const baseUrl = process.env.BASE_URL || 'https://ravenote.xyz';

    const params = new URLSearchParams();
    params.append('mode', config.mode);
    params.append('line_items[0][price]', config.line_items[0].price);
    params.append('line_items[0][quantity]', '1');
    params.append('success_url', `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `${baseUrl}/#pricing`);
    params.append('metadata[plan]', plan);
    if (email) params.append('customer_email', email);

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
