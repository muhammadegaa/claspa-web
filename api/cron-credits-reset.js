// Vercel Cron handler. Runs daily; resets monthly credits for any Pro user
// whose period has elapsed, and expires top-up credits older than 365 days.
//
// Vercel authenticates cron invocations by setting Authorization: Bearer
// CRON_SECRET (where CRON_SECRET is an env var we configure). Reject
// requests without this header to prevent manual abuse.

const { db } = require('./lib/firebase-admin');
const { maybeResetMonthly, maybeExpireTopup } = require('./lib/credits');

module.exports = async (req, res) => {
  // Only accept authenticated cron calls
  const expected = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!expected || auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const CREDITS_ENABLED = process.env.CREDITS_SYSTEM_ENABLED === 'true';
  if (!CREDITS_ENABLED) {
    return res.status(200).json({ skipped: true, reason: 'credits system disabled' });
  }

  const stats = {
    scanned: 0,
    reset: 0,
    expired: 0,
    errors: 0,
  };

  try {
    // Only active Pro tiers need resets. Legacy Pro too.
    const snap = await db().collection('users')
      .where('tier', 'in', ['pro', 'pro_legacy'])
      .get();

    for (const doc of snap.docs) {
      stats.scanned++;
      try {
        const resetResult = await maybeResetMonthly(doc.id);
        if (resetResult.reset) stats.reset++;

        const expireResult = await maybeExpireTopup(doc.id);
        if (expireResult.expired) stats.expired++;
      } catch (e) {
        stats.errors++;
        console.error(`Reset failed for ${doc.id}:`, e.message);
      }
    }

    console.log('Credits reset cron completed:', stats);
    return res.status(200).json(stats);
  } catch (err) {
    console.error('Credits reset cron error:', err.message);
    return res.status(500).json({ error: 'Cron failed', stats });
  }
};
