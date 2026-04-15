module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing session ID' });

  try {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}`, {
      headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    const session = await r.json();
    if (!r.ok) return res.status(404).json({ error: 'Session not found' });

    const licenseKey = session.metadata?.licenseKey || null;
    const plan = session.metadata?.plan || 'lifetime';
    const email = session.customer_email || session.customer_details?.email || '';

    res.status(200).json({ licenseKey, plan, email, status: session.payment_status });
  } catch (err) {
    console.error('Session retrieval error:', err.message);
    res.status(404).json({ error: 'Session not found' });
  }
};
