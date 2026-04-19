// Lightweight analytics counters. Writes to Firestore doc at:
//   analytics/daily/{YYYY-MM-DD}
// Each field is an integer counter incremented atomically.
//
// We intentionally keep this fire-and-forget — if a counter write fails we
// log and move on. Never block a user action on analytics.

const { db } = require('./firebase-admin');
const admin = require('firebase-admin');

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function bump(field, amount = 1) {
  try {
    const ref = db().doc(`analytics/daily_${today()}`);
    await ref.set({
      [field]: admin.firestore.FieldValue.increment(amount),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (e) {
    console.warn(`Analytics bump failed (${field}):`, e.message);
  }
}

// Common events
const Events = {
  proCheckout:       () => bump('pro_checkout_clicks'),
  proSubscribed:     () => bump('pro_subscribed'),
  lifetimeBought:    () => bump('lifetime_bought'),
  topupPurchased:    (amountCents) => {
    bump('topup_count');
    bump('topup_revenue_cents', amountCents);
  },
  creditsDeducted:   (costCents) => {
    bump('ai_calls');
    bump('ai_cost_cents', costCents);
  },
  creditsExhausted:  () => bump('credits_exhausted_events'),
  subscriptionCancelled: () => bump('subscription_cancelled'),
  grandfatherMigrated: () => bump('grandfather_migrated'),
};

module.exports = { bump, Events };
