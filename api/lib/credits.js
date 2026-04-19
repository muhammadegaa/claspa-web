// Credit ledger — atomic operations on user credit balance.
//
// Two balance buckets per user:
//   credits_balance_cents  — monthly Pro allowance, resets each billing period
//   credits_topup_cents    — purchased top-up credits, expire 12 months after
//                            last purchase (checked lazily on read)
//
// Deduction priority: monthly allowance first, then top-up. This way the
// monthly "use it or lose it" pool is spent before purchased credits that
// the user paid real money for.
//
// All mutations use Firestore transactions to serialize concurrent requests.

const { db } = require('./firebase-admin');
const admin = require('firebase-admin');

const PRO_MONTHLY_CREDITS_CENTS = 300;     // $3.00 included with Pro
const TOPUP_EXPIRY_DAYS = 365;

// Initialize credit fields on a user doc. Idempotent — skips if already set.
// Called lazily when a Pro user first hits the proxy after credits go live.
async function ensureCreditFields(uid) {
  const ref = db().doc(`users/${uid}`);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const d = snap.data();
    if (d.credits_balance_cents !== undefined) return;
    tx.update(ref, {
      credits_balance_cents: d.tier === 'pro' || d.tier === 'pro_legacy'
        ? PRO_MONTHLY_CREDITS_CENTS
        : 0,
      credits_topup_cents: 0,
      credits_period_start: new Date().toISOString(),
      credits_included_cents: PRO_MONTHLY_CREDITS_CENTS,
      lifetime_spend_cents: 0,
      updatedAt: new Date().toISOString(),
    });
  });
}

// Read balance. Returns { monthly_cents, topup_cents, total_cents, period_start }.
// Note: this does NOT run the reset check; callers that need fresh-period
// behavior should call maybeResetMonthly() first.
async function getBalance(uid) {
  const snap = await db().doc(`users/${uid}`).get();
  if (!snap.exists) return { monthly_cents: 0, topup_cents: 0, total_cents: 0, period_start: null };
  const d = snap.data();
  return {
    monthly_cents: d.credits_balance_cents || 0,
    topup_cents: d.credits_topup_cents || 0,
    total_cents: (d.credits_balance_cents || 0) + (d.credits_topup_cents || 0),
    period_start: d.credits_period_start || null,
    included_cents: d.credits_included_cents || PRO_MONTHLY_CREDITS_CENTS,
    tier: d.tier || 'free',
  };
}

// Check if user has enough credits for an estimated cost. Does not deduct.
async function canAfford(uid, estimatedCents) {
  const b = await getBalance(uid);
  return b.total_cents >= estimatedCents;
}

// Deduct a cost from user's balance atomically. Returns the updated balance
// and a transaction log entry. Throws if balance would go negative.
//
// Deduction order: monthly first, then top-up.
async function deduct(uid, costCents, meta = {}) {
  if (costCents <= 0) return { deducted: 0, balance: await getBalance(uid) };

  const ref = db().doc(`users/${uid}`);
  const txRef = db().collection(`users/${uid}/credit_transactions`).doc();

  return await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('User not found');
    const d = snap.data();
    const monthly = d.credits_balance_cents || 0;
    const topup = d.credits_topup_cents || 0;

    if (monthly + topup < costCents) {
      throw new Error('INSUFFICIENT_CREDITS');
    }

    // Deduct monthly first
    let remaining = costCents;
    const fromMonthly = Math.min(monthly, remaining);
    remaining -= fromMonthly;
    const fromTopup = remaining;

    const newMonthly = monthly - fromMonthly;
    const newTopup = topup - fromTopup;
    const newLifetimeSpend = (d.lifetime_spend_cents || 0) + costCents;

    tx.update(ref, {
      credits_balance_cents: newMonthly,
      credits_topup_cents: newTopup,
      lifetime_spend_cents: newLifetimeSpend,
      updatedAt: new Date().toISOString(),
    });

    tx.set(txRef, {
      timestamp: new Date().toISOString(),
      type: 'usage',
      amount_cents: -costCents,
      from_monthly_cents: fromMonthly,
      from_topup_cents: fromTopup,
      balance_after_monthly_cents: newMonthly,
      balance_after_topup_cents: newTopup,
      model: meta.model || null,
      openrouter_gen_id: meta.gen_id || null,
      was_estimate: meta.was_estimate || false,
    });

    return {
      deducted: costCents,
      fromMonthly,
      fromTopup,
      balance: {
        monthly_cents: newMonthly,
        topup_cents: newTopup,
        total_cents: newMonthly + newTopup,
      },
    };
  });
}

// Add top-up credits. Called from Stripe webhook after successful payment.
// Updates last_topup_at which governs expiry.
async function addTopup(uid, amountCents, meta = {}) {
  if (amountCents <= 0) throw new Error('Invalid topup amount');

  const ref = db().doc(`users/${uid}`);
  const txRef = db().collection(`users/${uid}/credit_transactions`).doc();

  return await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('User not found');
    const d = snap.data();
    const topup = d.credits_topup_cents || 0;
    const newTopup = topup + amountCents;

    tx.update(ref, {
      credits_topup_cents: newTopup,
      last_topup_at: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    tx.set(txRef, {
      timestamp: new Date().toISOString(),
      type: 'topup',
      amount_cents: amountCents,
      balance_after_monthly_cents: d.credits_balance_cents || 0,
      balance_after_topup_cents: newTopup,
      stripe_payment_intent: meta.payment_intent || null,
      stripe_session_id: meta.session_id || null,
    });

    return { added: amountCents, balance: { topup_cents: newTopup } };
  });
}

// Reset monthly Pro credits if user's period has elapsed. Called lazily from
// the proxy on each request (cheap — only a read if no reset needed) and
// also by the scheduled cron for active users who haven't hit the proxy.
async function maybeResetMonthly(uid) {
  const ref = db().doc(`users/${uid}`);

  return await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { reset: false };
    const d = snap.data();

    if (d.tier !== 'pro' && d.tier !== 'pro_legacy') return { reset: false };

    const periodStart = d.credits_period_start ? new Date(d.credits_period_start) : null;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    if (periodStart && periodStart > thirtyDaysAgo) return { reset: false };

    const included = d.credits_included_cents || PRO_MONTHLY_CREDITS_CENTS;
    tx.update(ref, {
      credits_balance_cents: included,
      credits_period_start: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    const txRef = db().collection(`users/${uid}/credit_transactions`).doc();
    tx.set(txRef, {
      timestamp: now.toISOString(),
      type: 'monthly_reset',
      amount_cents: included,
      balance_after_monthly_cents: included,
      balance_after_topup_cents: d.credits_topup_cents || 0,
    });

    return { reset: true, credits_cents: included };
  });
}

// Expire top-up credits older than 12 months since last top-up. Called from
// monthly reset cron. Writes an adjustment transaction.
async function maybeExpireTopup(uid) {
  const ref = db().doc(`users/${uid}`);

  return await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { expired: false };
    const d = snap.data();

    const topup = d.credits_topup_cents || 0;
    if (topup <= 0) return { expired: false };

    const lastTopup = d.last_topup_at ? new Date(d.last_topup_at) : null;
    if (!lastTopup) return { expired: false };

    const cutoff = new Date(Date.now() - TOPUP_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    if (lastTopup > cutoff) return { expired: false };

    tx.update(ref, {
      credits_topup_cents: 0,
      updatedAt: new Date().toISOString(),
    });

    const txRef = db().collection(`users/${uid}/credit_transactions`).doc();
    tx.set(txRef, {
      timestamp: new Date().toISOString(),
      type: 'topup_expiry',
      amount_cents: -topup,
      balance_after_monthly_cents: d.credits_balance_cents || 0,
      balance_after_topup_cents: 0,
      reason: `Top-up credits expired (${TOPUP_EXPIRY_DAYS} days since last purchase)`,
    });

    return { expired: true, amount_cents: topup };
  });
}

module.exports = {
  PRO_MONTHLY_CREDITS_CENTS,
  TOPUP_EXPIRY_DAYS,
  ensureCreditFields,
  getBalance,
  canAfford,
  deduct,
  addTopup,
  maybeResetMonthly,
  maybeExpireTopup,
};
