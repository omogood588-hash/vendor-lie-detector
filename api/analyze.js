// ─── IN-MEMORY IP RATE LIMITER ───────────────────────────────────────────────
// Vercel serverless functions are stateless but this works well enough
// for limiting bursts — the map resets when the function cold-starts
const ipMap = new Map();
const IP_LIMIT  = 1;                // 1 free analysis per IP per day
const IP_WINDOW = 24 * 60 * 60 * 1000; // per day (ms)

function isIPRateLimited(ip) {
  const now = Date.now();
  const entry = ipMap.get(ip);

  if (!entry || now - entry.windowStart > IP_WINDOW) {
    ipMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  if (entry.count >= IP_LIMIT) return true;

  entry.count++;
  return false;
}

// ─── SENTRY ERROR REPORTING ──────────────────────────────────────────────────
async function reportError(error, context = {}) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // silently skip if not configured

  try {
    // Parse DSN to get endpoint
    const url = new URL(dsn);
    const projectId = url.pathname.replace('/', '');
    const sentryUrl = `https://sentry.io/api/${projectId}/store/`;
    const key = url.username;

    await fetch(sentryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${key}, sentry_client=vld/1.0`
      },
      body: JSON.stringify({
        event_id: crypto.randomUUID().replace(/-/g, ''),
        timestamp: new Date().toISOString(),
        platform: 'node',
        level: 'error',
        logger: 'api.analyze',
        message: error.message || String(error),
        extra: context,
        exception: {
          values: [{
            type: error.name || 'Error',
            value: error.message || String(error),
            stacktrace: { frames: [] }
          }]
        }
      })
    });
  } catch {
    // Never let Sentry errors crash the handler
  }
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────
export default async function handler(req, res) {

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS — restrict to same origin in production
  const origin = req.headers.origin || '';
  const host   = req.headers.host   || '';
  const allowedOrigin = origin.includes(host) ? origin : '';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Get real IP (Vercel puts it in x-forwarded-for)
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';

  // Server-side IP rate limit
  if (isIPRateLimited(ip)) {
    return res.status(429).json({
      error: 'Too many requests from your IP. Please wait an hour before trying again.'
    });
  }

  // ─── TOKEN / AUTH CHECK ─────────────────────────────────────────────────────
  const TOKEN_SECRET = process.env.TOKEN_SECRET;
  const authHeader   = req.headers['x-auth-token'] || '';
  let   userPlan     = 'free';
  let   tokenValid   = false;

  if (authHeader && TOKEN_SECRET) {
    try {
      const [encoded, sig] = authHeader.split('.');
      const expectedSig = Buffer.from(TOKEN_SECRET + encoded).toString('base64').slice(0, 32);
      if (sig === expectedSig) {
        const payload = JSON.parse(Buffer.from(encoded, 'base64').toString());
        if (payload.exp > Date.now() && payload.paid) {
          userPlan   = payload.plan || 'paid';
          tokenValid = true;
        }
      }
    } catch {}
  }

  // Free tier — one analysis per IP per day (server-side enforcement)
  if (!tokenValid) {
    if (isIPRateLimited(ip)) {
      return res.status(429).json({
        error: 'Free analysis used. Please upgrade to continue.',
        upgrade: true
      });
    }
  }

  // API key check
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    await reportError(new Error('GROQ_API_KEY not set'), { ip });
    return res.status(500).json({ error: 'Server misconfigured — please try again later.' });
  }

  // Parse body
  let body;
  try {
    body = req.body;
    if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return res.status(400).json({ error: 'Missing or invalid prompt.' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  // Payload size guard
  if (body.prompt.length > 35000) {
    return res.status(400).json({ error: 'Contract text too long.' });
  }

  // Additional input sanitation
  const safePrompt = body.prompt
    .split('')
    .filter(ch => {
      const code = ch.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join('');

  // Call Groq
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.2,
        max_tokens: 2048,
        messages: [{ role: 'user', content: safePrompt }]
      })
    });

    clearTimeout(timeout);

    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      const msg = err?.error?.message || `Groq API error ${groqRes.status}`;
      await reportError(new Error(msg), { ip, status: groqRes.status });
      return res.status(groqRes.status).json({ error: msg });
    }

    const data = await groqRes.json();
    const content = data?.choices?.[0]?.message?.content || '';

    if (!content) {
      await reportError(new Error('Empty response from Groq'), { ip });
      return res.status(500).json({ error: 'AI returned an empty response. Please try again.' });
    }

    return res.status(200).json({ content });

  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: 'Request timed out. Please try again.' });
    }
    await reportError(e, { ip });
    return res.status(500).json({ error: e.message || 'Server error — please try again.' });
  }
}
