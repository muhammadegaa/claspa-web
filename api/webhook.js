const crypto = require('crypto');

const STRIPE_API = 'https://api.stripe.com/v1';

function stripeReq(method, path, params) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (params) opts.body = new URLSearchParams(params).toString();
  return fetch(`${STRIPE_API}${path}`, opts).then(r => r.json());
}

function generateLicenseKey() {
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `CLASPA-${seg()}-${seg()}-${seg()}-${seg()}`;
}

function verifySignature(payload, sig, secret) {
  const items = sig.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const signedPayload = `${items.t}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(items.v1));
}

async function storeLicense(key, data) {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const base = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await fetch(`${base}/set/license:${key}/${encodeURIComponent(JSON.stringify(data))}`, { method: 'POST', headers });
    if (data.email) {
      await fetch(`${base}/set/email:${data.email}/${encodeURIComponent(key)}`, { method: 'POST', headers });
    }
    return;
  }
  console.log('License stored (Stripe-only mode):', key, data.tier);
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await getRawBody(req);

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error('STRIPE_WEBHOOK_SECRET not configured — rejecting webhook');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    if (!sig) {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }
    if (!verifySignature(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    event = JSON.parse(rawBody);
  } catch (err) {
    console.error('Webhook parse/verify failed:', err.message);
    return res.status(400).json({ error: 'Invalid payload' });
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
      await stripeReq('POST', `/checkout/sessions/${session.id}`, {
        'metadata[licenseKey]': licenseKey,
        'metadata[plan]': plan,
      });
    } catch (e) {
      console.error('Failed to update Stripe metadata:', e.message);
    }

    console.log(`License created: ${licenseKey} (${plan}) for ${email}`);

    // Update Firestore user if we can match by email
    if (email) {
      try {
        const { db } = require('./lib/firebase-admin');
        const emailDoc = await db().doc(`emailIndex/${email.toLowerCase()}`).get();
        if (emailDoc.exists) {
          const { uid } = emailDoc.data();
          await db().doc(`users/${uid}`).set({
            tier: plan,
            licenseKey,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription || null,
            updatedAt: new Date().toISOString(),
          }, { merge: true });
          console.log(`Firestore updated for uid: ${uid}`);
        }
      } catch (e) {
        console.error('Firestore write failed (non-fatal):', e.message);
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    console.log(`Subscription cancelled for customer: ${customerId}`);

    // Revoke access: update KV license records + Firestore
    try {
      // Find and deactivate license in KV by searching Stripe sessions
      const sessions = await stripeReq('GET', `/checkout/sessions?customer=${customerId}&limit=20`);
      for (const s of (sessions.data || [])) {
        const key = s.metadata?.licenseKey;
        if (key && s.metadata?.plan === 'pro') {
          // Update KV if available
          if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
            const base = process.env.KV_REST_API_URL;
            const token = process.env.KV_REST_API_TOKEN;
            const existing = await fetch(`${base}/get/license:${key}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
            if (existing.result) {
              const parsed = typeof existing.result === 'string' ? JSON.parse(existing.result) : existing.result;
              parsed.active = false;
              await fetch(`${base}/set/license:${key}/${encodeURIComponent(JSON.stringify(parsed))}`, {
                method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              });
              console.log(`KV license ${key} deactivated`);
            }
          }
        }
      }

      // Downgrade Firestore user by customer ID
      const { db } = require('./lib/firebase-admin');
      const usersSnapshot = await db().collection('users').where('stripeCustomerId', '==', customerId).get();
      for (const doc of usersSnapshot.docs) {
        await doc.ref.update({ tier: 'free', stripeSubscriptionId: null, updatedAt: new Date().toISOString() });
        console.log(`Firestore user ${doc.id} downgraded to free`);
      }
    } catch (e) {
      console.error('Subscription revocation failed:', e.message);
    }
  }

  res.status(200).json({ received: true });
};

module.exports.config = {
  api: { bodyParser: false },
};
