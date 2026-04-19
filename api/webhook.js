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

// Find a Firebase uid by email (via emailIndex). Fallback: scan users.
async function findUidByEmail(db, email) {
  if (!email) return null;
  try {
    const emailDoc = await db.doc(`emailIndex/${email.toLowerCase()}`).get();
    if (emailDoc.exists) return emailDoc.data().uid || null;
  } catch {}
  return null;
}

async function handleTopupCompleted(session) {
  const uid = session.metadata?.uid;
  const creditsCents = parseInt(session.metadata?.credits_cents || '0', 10);
  if (!uid || creditsCents <= 0) {
    console.error('Top-up webhook missing uid or credits_cents:', session.id, session.metadata);
    return;
  }

  try {
    const { addTopup, ensureCreditFields } = require('../lib/credits');
    await ensureCreditFields(uid);
    const result = await addTopup(uid, creditsCents, {
      session_id: session.id,
      payment_intent: session.payment_intent,
    });
    console.log(`Top-up credited: uid=${uid} +${creditsCents}¢ (new topup=${result.balance.topup_cents}¢)`);
    try {
      const { Events } = require('../lib/analytics');
      Events.topupPurchased(session.amount_total || 0);
    } catch {}
  } catch (e) {
    console.error(`Top-up credit failed for uid=${uid} session=${session.id}:`, e.message);
    // TODO: push to a retry queue; for now rely on logs + manual reconciliation
  }
}

async function handleSubscriptionCompleted(session, db) {
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

  try {
    await stripeReq('POST', `/checkout/sessions/${session.id}`, {
      'metadata[licenseKey]': licenseKey,
      'metadata[plan]': plan,
    });
  } catch (e) {
    console.error('Failed to update Stripe metadata:', e.message);
  }

  console.log(`License created: ${licenseKey} (${plan}) for ${email}`);

  // Update Firestore user if we can match by email or uid from metadata
  const uid = session.metadata?.uid || await findUidByEmail(db, email);
  if (uid) {
    try {
      const update = {
        tier: plan,
        licenseKey,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription || null,
        updatedAt: new Date().toISOString(),
      };

      // Initialize credit fields for new Pro subscribers
      if (plan === 'pro') {
        const { PRO_MONTHLY_CREDITS_CENTS } = require('../lib/credits');
        update.credits_balance_cents = PRO_MONTHLY_CREDITS_CENTS;
        update.credits_included_cents = PRO_MONTHLY_CREDITS_CENTS;
        update.credits_period_start = new Date().toISOString();
        update.credits_topup_cents = 0;
        update.lifetime_spend_cents = 0;
      }

      await db.doc(`users/${uid}`).set(update, { merge: true });
      console.log(`Firestore updated for uid: ${uid}`);
      try {
        const { Events } = require('../lib/analytics');
        if (plan === 'pro') Events.proSubscribed();
        else if (plan === 'lifetime') Events.lifetimeBought();
      } catch {}
    } catch (e) {
      console.error('Firestore write failed (non-fatal):', e.message);
    }
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await getRawBody(req);

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error('STRIPE_WEBHOOK_SECRET not configured, rejecting webhook');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });
    if (!verifySignature(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    event = JSON.parse(rawBody);
  } catch (err) {
    console.error('Webhook parse/verify failed:', err.message);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const { db } = require('../lib/firebase-admin');

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const metaType = session.metadata?.type;
      const plan = session.metadata?.plan;

      if (metaType === 'topup' || (plan && plan.startsWith('topup_'))) {
        await handleTopupCompleted(session);
      } else {
        await handleSubscriptionCompleted(session, db());
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      console.log(`Subscription cancelled for customer: ${customerId}`);

      // Revoke access: update KV license records + Firestore
      const sessions = await stripeReq('GET', `/checkout/sessions?customer=${customerId}&limit=20`);
      for (const s of (sessions.data || [])) {
        const key = s.metadata?.licenseKey;
        if (key && (s.metadata?.plan === 'pro' || s.metadata?.plan === 'pro_legacy')) {
          if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
            const base = process.env.KV_REST_API_URL;
            const token = process.env.KV_REST_API_TOKEN;
            const existing = await fetch(`${base}/get/license:${key}`, {
              headers: { Authorization: `Bearer ${token}` },
            }).then(r => r.json());
            if (existing.result) {
              const parsed = typeof existing.result === 'string' ? JSON.parse(existing.result) : existing.result;
              parsed.active = false;
              await fetch(`${base}/set/license:${key}/${encodeURIComponent(JSON.stringify(parsed))}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              });
              console.log(`KV license ${key} deactivated`);
            }
          }
        }
      }

      // Downgrade Firestore user by customer ID. Preserve top-up credits —
      // user paid real money for them, they persist for the expiry window.
      const usersSnapshot = await db().collection('users').where('stripeCustomerId', '==', customerId).get();
      for (const doc of usersSnapshot.docs) {
        await doc.ref.update({
          tier: 'free',
          stripeSubscriptionId: null,
          credits_balance_cents: 0,  // monthly credits cleared
          // credits_topup_cents preserved
          updatedAt: new Date().toISOString(),
        });
        console.log(`Firestore user ${doc.id} downgraded to free (topup credits preserved)`);
      }
      try {
        const { Events } = require('../lib/analytics');
        Events.subscriptionCancelled();
      } catch {}
    }

    if (event.type === 'invoice.payment_failed') {
      // Stripe automatically retries 3 times over 2 weeks. Log for awareness.
      const inv = event.data.object;
      console.warn(`Payment failed for customer ${inv.customer} (attempt ${inv.attempt_count}):`, inv.subscription);
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message, err.stack);
    // Still return 200 so Stripe doesn't retry — we've logged the failure
  }

  res.status(200).json({ received: true });
};

module.exports.config = {
  api: { bodyParser: false },
};
