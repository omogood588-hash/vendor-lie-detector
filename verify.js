// Verifies a Stripe session and issues a token
// Called after payment success to unlock analyses
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const TOKEN_SECRET  = process.env.TOKEN_SECRET;
  if (!STRIPE_SECRET || !TOKEN_SECRET) return res.status(500).json({ error: 'Server misconfigured' });

  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'Missing session ID' });

  try {
    const stripeRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` }
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok || session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }

    const plan = session.metadata?.plan
      || session.subscription_data?.metadata?.plan
      || 'single';

    // Issue a simple signed token: base64(payload).signature
    const payload = JSON.stringify({
      plan,
      email: session.customer_details?.email || '',
      paid: true,
      ts: Date.now(),
      exp: Date.now() + (plan === 'single' ? 24 * 60 * 60 * 1000 : 32 * 24 * 60 * 60 * 1000)
    });

    const encoded = Buffer.from(payload).toString('base64');
    const sig = Buffer.from(TOKEN_SECRET + encoded).toString('base64').slice(0, 32);
    const token = `${encoded}.${sig}`;

    return res.status(200).json({ token, plan });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
