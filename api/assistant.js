const MAX_MESSAGE_LENGTH = 2000

function sendJson(res, status, payload) {
  res.status(status).setHeader('Cache-Control', 'no-store')
  return res.json(payload)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendJson(res, 405, { error: 'Use POST to send a message.' })
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
  if (!message) return sendJson(res, 400, { error: 'A message is required.' })
  if (message.length > MAX_MESSAGE_LENGTH) return sendJson(res, 413, { error: 'Message is too long.' })

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return sendJson(res, 503, { error: 'The assistant is not configured. Add OPENAI_API_KEY to the Vercel project environment variables.' })

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        instructions: 'You are Smart Clinic’s general platform assistant. Answer questions about using the app and general clinic operations. Do not diagnose, triage, recommend treatment or medication, or ask for personal patient data. For emergencies, direct the person to qualified local emergency services. Be concise.',
        input: message,
        max_output_tokens: 350,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const code = data?.error?.code || data?.error?.type || 'unknown_error'
      console.error('OpenAI assistant request rejected:', response.status, code)
      const error = response.status === 429 && ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded'].includes(code)
        ? 'OpenAI has no available API credit or has reached a usage limit. Check billing and project limits.'
        : `OpenAI could not answer this request (${code}). Check the API key, model access and project limits.`
      return sendJson(res, 502, { error })
    }
    const answer = (data.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n').trim()
    if (!answer) return sendJson(res, 502, { error: 'The assistant returned an empty answer. Please try again.' })
    return sendJson(res, 200, { answer, mode: 'ai' })
  } catch (error) {
    console.error('Assistant request failed:', error instanceof Error ? error.message : 'unknown error')
    return sendJson(res, 502, { error: 'The assistant service could not be reached. Please try again shortly.' })
  }
}
