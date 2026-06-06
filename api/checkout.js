// Creates a Stripe checkout session
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe not configured' });

  const { plan } = req.body || {};
  const validPlans = ['single', 'early_adopter', 'pro'];
  if (!plan || !validPlans.includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  const prices = {
    single:        { amount: 1900, mode: 'payment',      name: 'Single Contract Review' },
    early_adopter: { amount: 2900, mode: 'subscription', name: 'Early Adopter Plan — $29/month' },
    pro:           { amount: 9900, mode: 'subscription', name: 'Pro Plan — $99/month' },
  };

  const selected = prices[plan];
  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'mode': selected.mode,
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': selected.name,
        'line_items[0][price_data][unit_amount]': selected.amount,
        ...(selected.mode === 'subscription'
          ? { 'line_items[0][price_data][recurring][interval]': 'month' }
          : {}),
        'line_items[0][quantity]': '1',
        'success_url': `${origin}/app.html?payment=success&plan=${plan}`,
        'cancel_url':  `${origin}/app.html?payment=cancelled`,
        'allow_promotion_codes': 'true',
        ...(selected.mode === 'subscription'
          ? { 'subscription_data[metadata][plan]': plan }
          : { 'payment_intent_data[metadata][plan]': plan }),
      }).toString()
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) throw new Error(session.error?.message || 'Stripe error');
    return res.status(200).json({ url: session.url });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
