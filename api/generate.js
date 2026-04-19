const STRIPE_API = 'https://api.stripe.com/v1';
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_GEN = 'https://openrouter.ai/api/v1/generation';

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

// Fetch actual billed cost for a generation from OpenRouter. Retries briefly
// since the generation record sometimes lags the chat response by ~1s.
async function fetchActualCost(genId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 700));
    try {
      const r = await fetch(`${OPENROUTER_GEN}?id=${genId}`, {
        headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (data?.data?.total_cost !== undefined) return data.data;
    } catch {}
  }
  return null;
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

  const CREDITS_ENABLED = process.env.CREDITS_SYSTEM_ENABLED === 'true';

  // Validate Pro tier via Firebase idToken OR legacy license key
  let isValid = false;
  let uid = null;
  let tier = null;
  try {
    if (idToken) {
      const { db } = require('../lib/firebase-admin');
      const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
      const verifyRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
      );
      const verifyData = await verifyRes.json();
      const user = verifyData.users?.[0];
      if (user) {
        uid = user.localId;
        const userDoc = await db().doc(`users/${uid}`).get();
        if (userDoc.exists) {
          tier = userDoc.data().tier;
          isValid = tier === 'pro' || tier === 'pro_legacy';
        }
      }
    } else if (licenseKey?.startsWith('CLASPA-')) {
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

  // ─── Credit check (gated by feature flag, Firebase-auth users only) ───
  let creditsState = null;
  if (CREDITS_ENABLED && uid) {
    try {
      const { ensureCreditFields, maybeResetMonthly, canAfford, getBalance } = require('../lib/credits');
      const { estimateMaxCostCents } = require('../lib/model-pricing');

      await ensureCreditFields(uid);
      await maybeResetMonthly(uid);

      const estimateCents = estimateMaxCostCents(
        model || 'anthropic/claude-sonnet-4.6',
        messages,
        max_tokens || 1600
      );

      const balance = await getBalance(uid);
      if (balance.total_cents < estimateCents) {
        try {
          const { Events } = require('../lib/analytics');
          Events.creditsExhausted();
        } catch {}
        return res.status(402).json({
          error: 'INSUFFICIENT_CREDITS',
          balance_cents: balance.total_cents,
          estimated_cost_cents: estimateCents,
          topup_url: 'https://ravenote.xyz/topup',
        });
      }

      creditsState = { uid, estimateCents, model };
    } catch (e) {
      console.error('Credit check error (non-fatal, proceeding):', e.message);
      // On infra error we still serve the call — don't block user over our bug.
    }
  }

  // ─── Forward to OpenRouter ───
  let orData;
  try {
    const orRes = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ravenote.xyz',
        'X-Title': 'Ravenote Pro',
      },
      body: JSON.stringify({
        model: model || 'anthropic/claude-sonnet-4.6',
        messages,
        temperature: temperature || 0.25,
        max_tokens: max_tokens || 1600,
      }),
    });

    orData = await orRes.json();
    if (!orRes.ok) {
      return res.status(orRes.status).json({ error: orData.error?.message || 'AI request failed' });
    }
  } catch (e) {
    console.error('OpenRouter proxy error:', e.message);
    return res.status(500).json({ error: 'AI service error' });
  }

  // ─── Post-call credit deduction (async, after response sent) ───
  if (creditsState) {
    const genId = orData?.id;
    const { deduct } = require('../lib/credits');
    const { actualCostCents } = require('../lib/model-pricing');

    // Run deduction but don't block response on it. We return the AI output
    // immediately; ledger updates happen in background.
    (async () => {
      try {
        let costCents = creditsState.estimateCents;
        let wasEstimate = true;

        if (genId) {
          const genData = await fetchActualCost(genId);
          if (genData) {
            costCents = actualCostCents(genData);
            wasEstimate = false;
          }
        }

        await deduct(creditsState.uid, costCents, {
          model: creditsState.model,
          gen_id: genId,
          was_estimate: wasEstimate,
        });
        try {
          const { Events } = require('../lib/analytics');
          Events.creditsDeducted(costCents);
        } catch {}
      } catch (e) {
        console.error(`Credit deduction failed for uid=${creditsState.uid} gen=${genId}:`, e.message);
      }
    })();
  }

  res.status(200).json(orData);
};
