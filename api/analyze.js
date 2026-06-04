export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Basic rate limiting by IP
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfigured — API key missing.' });
  }

  let body;
  try {
    body = req.body;
    if (!body || !body.prompt) {
      return res.status(400).json({ error: 'Missing prompt in request body.' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  // Validate prompt length (prevent huge payloads)
  if (body.prompt.length > 35000) {
    return res.status(400).json({ error: 'Contract text too long.' });
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.2,
        max_tokens: 2048,
        messages: [{ role: 'user', content: body.prompt }]
      })
    });

    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      return res.status(groqRes.status).json({ 
        error: err?.error?.message || `Groq API error ${groqRes.status}` 
      });
    }

    const data = await groqRes.json();
    const content = data?.choices?.[0]?.message?.content || '';
    return res.status(200).json({ content });

  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error — please try again.' });
  }
}
