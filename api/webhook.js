const Stripe = require('stripe');
const crypto = require('crypto');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function generateLicenseKey() {
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `CLASPA-${seg()}-${seg()}-${seg()}-${seg()}`;
}

// Simple in-memory + KV store for licenses
// In production, use Vercel KV, Upstash Redis, or a database
async function storeLicense(key, data) {
  // Using Vercel KV if available, fallback to edge config
  if (process.env.KV_REST_API_URL) {
    const { kv } = require('@vercel/kv');
    await kv.set(`license:${key}`, JSON.stringify(data));
    // Also index by email for lookups
    if (data.email) await kv.set(`email:${data.email}`, key);
    return;
  }
  // Fallback: store in Stripe metadata (works without external DB)
  // The validate endpoint will check Stripe directly
  console.log('License stored (Stripe-only mode):', key, data.tier);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Vercel sends raw body as buffer when configured
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (process.env.STRIPE_WEBHOOK_SECRET && sig) {
      event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      // Development mode — parse directly
      event = typeof req.body === 'object' ? { type: req.body.type, data: req.body.data } : JSON.parse(rawBody);
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const plan = session.metadata?.plan || 'lifetime';
    const email = session.customer_email || session.customer_details?.email || '';
    const licenseKey = generateLicenseKey();

    await storeLicense(licenseKey, {
      tier: plan,
      email,
      stripeSessionId: session.id,
      stripeCustomerId: session.customer,
      stripeSubscriptionId: session.subscription || null,
      createdAt: new Date().toISOString(),
      active: true,
    });

    // Store license key in Stripe session metadata for retrieval on success page
    try {
      if (session.payment_intent) {
        await stripe.paymentIntents.update(session.payment_intent, {
          metadata: { licenseKey, plan },
        });
      }
      // Also update the checkout session metadata
      await stripe.checkout.sessions.update(session.id, {
        metadata: { ...session.metadata, licenseKey },
      });
    } catch (e) {
      console.error('Failed to update Stripe metadata:', e.message);
    }

    console.log(`License created: ${licenseKey} (${plan}) for ${email}`);
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const email = subscription.metadata?.email || '';
    console.log(`Subscription cancelled for customer: ${subscription.customer}`);
    // In production: look up license by customer ID and mark inactive
  }

  res.status(200).json({ received: true });
};

// Vercel config: need raw body for webhook signature verification
module.exports.config = {
  api: { bodyParser: false },
};
