const { auth, db } = require('./lib/firebase-admin');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { googleToken } = req.body || {};
  if (!googleToken) return res.status(400).json({ error: 'Missing googleToken' });

  try {
    // Verify Google token and get user info
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${googleToken}` },
    });
    if (!userInfoRes.ok) return res.status(401).json({ error: 'Invalid Google token' });
    const userInfo = await userInfoRes.json();

    const uid = userInfo.sub;
    const email = userInfo.email || '';
    const displayName = userInfo.name || '';
    const photoURL = userInfo.picture || '';

    // Create Firebase custom token
    const customToken = await auth().createCustomToken(uid, { email, displayName });

    // Ensure user doc exists in Firestore
    const userRef = db().doc(`users/${uid}`);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      await userRef.set({
        uid,
        email,
        displayName,
        photoURL,
        tier: 'free',
        licenseKey: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        usage: { date: new Date().toISOString().slice(0, 10), count: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else {
      // Update profile fields
      await userRef.update({
        email,
        displayName,
        photoURL,
        updatedAt: new Date().toISOString(),
      });
    }

    // Also create email index for Stripe webhook matching
    if (email) {
      await db().doc(`emailIndex/${email.toLowerCase()}`).set({ uid }, { merge: true });
    }

    // Return the user's current tier data
    const freshDoc = await userRef.get();
    const userData = freshDoc.data();

    res.status(200).json({
      customToken,
      uid,
      email,
      displayName,
      photoURL,
      tier: userData.tier || 'free',
      usage: userData.usage || { date: new Date().toISOString().slice(0, 10), count: 0 },
    });
  } catch (err) {
    console.error('Auth exchange error:', err.message);
    res.status(500).json({ error: 'Auth exchange failed' });
  }
};
