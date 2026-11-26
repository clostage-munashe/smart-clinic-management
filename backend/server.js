import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'

try {
  const localEnv = readFileSync(fileURLToPath(new URL('.env', import.meta.url)), 'utf8')
  for (const line of localEnv.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
} catch { /* environment variables may be supplied by the host */ }

const port = Number(process.env.PORT || 8787)
const allowedOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173'
let apiKey = process.env.OPENAI_API_KEY
let model = process.env.OPENAI_MODEL || 'gpt-6.2-astra'
let resendApiKey = process.env.RESEND_API_KEY
let supportEmail = process.env.CONTACT_RECIPIENT_EMAIL
let fromEmail = process.env.CONTACT_FROM_EMAIL
const limit = 8_000
const lastContactSubmit = new Map()

function refreshIntegrationConfig() {
  try {
    const localEnv = readFileSync(fileURLToPath(new URL('.env', import.meta.url)), 'utf8')
    for (const line of localEnv.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (match && match[2].trim()) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
    }
  } catch { /* environment variables may be supplied by the host */ }
  apiKey = process.env.OPENAI_API_KEY
  model = process.env.OPENAI_MODEL || 'gpt-6.2-astra'
  resendApiKey = process.env.RESEND_API_KEY
  supportEmail = process.env.CONTACT_RECIPIENT_EMAIL
  fromEmail = process.env.CONTACT_FROM_EMAIL
}
const db = new DatabaseSync(fileURLToPath(new URL('./smartclinic.sqlite', import.meta.url)))
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('patient','doctor','nurse')),
    clinic_type TEXT NOT NULL CHECK(clinic_type IN ('Public clinic','Private clinic','Hospital')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service TEXT NOT NULL,
    provider TEXT NOT NULL,
    appointment_date TEXT NOT NULL,
    preferred_time TEXT NOT NULL,
    visit_notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Confirmed','Cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS contact_messages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','sent','failed')),
    provider_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS appointments_user_idx ON appointments(user_id, appointment_date);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
`)

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > limit) throw Object.assign(new Error('Message is too long'), { status: 413 })
  }
  try { return JSON.parse(raw || '{}') } catch { throw Object.assign(new Error('Expected a JSON request body'), { status: 400 }) }
}

const publicUser = row => ({ id: row.id, name: row.name, email: row.email, role: row.role, clinic: row.clinic_type })
const tokenDigest = token => createHash('sha256').update(token).digest('hex')
const getSessionUser = req => {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return null
  const row = db.prepare(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(tokenDigest(token))
  if (!row || row.expires_at < Date.now()) {
    if (row) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenDigest(token))
    return null
  }
  return { user: publicUser(row), token }
}
const createSession = user => {
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenDigest(token), user.id, Date.now() + 24 * 60 * 60 * 1000)
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
  return token
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

function demoAssistantReply(message) {
  const q = message.toLowerCase()
  const demoPrefix = 'I’m the Smart Clinic demo assistant. '
  if (/\b(hi|hello|hey|good morning|good afternoon)\b/.test(q)) return `${demoPrefix}Hello! I can help you find features, request an appointment, manage your account, or use the clinic location page. What would you like to do?`
  if (/\b(emergency|chest pain|can't breathe|cannot breathe|suicid|overdose)\b/.test(q)) return 'I can’t assess emergencies. Please contact local emergency services or go to the nearest emergency department now.'
  if (/\b(book|booking|appointment|doctor|nurse)\b/.test(q)) return `${demoPrefix}Open Appointments from the sidebar, choose a service, clinician, date and preferred time, then submit your request. It stays pending until the clinic confirms it. Would you like help finding that page?`
  if (/\b(clinic|hospital|pharmacy|near|location|direction|map)\b/.test(q)) return `${demoPrefix}Choose “Find a clinic” in the sidebar and share your location if you want directions. The clinic and pharmacy directory is not connected yet, so the current destination is a sample in Harare.`
  if (/\b(sign ?up|register|login|log in|password|profile|account)\b/.test(q)) return `${demoPrefix}Use Sign up to create a patient, doctor or nurse account. Staff accounts need an invite code. Use My profile to update your name or clinic type.`
  if (/\b(faq|question|help|support)\b/.test(q)) return `${demoPrefix}Open FAQs to browse, sort or ask a platform question. You can also ask me here. Please don’t share medical details or patient information.`
  if (/\b(privacy|secure|data|information)\b/.test(q)) return `${demoPrefix}This project is still a demonstration. Don’t enter real patient or health information. Read Privacy & policy for details about what the demo stores.`
  return `${demoPrefix}I can help with appointments, account setup, clinic directions and using Smart Clinic. Which of those would you like to know about?`
}

const server = createServer(async (req, res) => {
  refreshIntegrationConfig()
  const origin = req.headers.origin
  let localDevOrigin = false
  if (origin && process.env.NODE_ENV !== 'production') {
    try { localDevOrigin = ['localhost', '127.0.0.1'].includes(new URL(origin).hostname) } catch { /* invalid origin */ }
  }
  if (origin && origin !== allowedOrigin && !localDevOrigin) return json(res, 403, { error: 'Origin not allowed' })
  res.setHeader('Access-Control-Allow-Origin', origin || allowedOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, aiConfigured: Boolean(apiKey), contactConfigured: Boolean(resendApiKey && supportEmail && fromEmail), supportEmail: supportEmail || null })
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    try {
      const body = await readBody(req)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const role = body.role
      const clinic = body.clinic
      if (name.length < 2 || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) return json(res, 400, { error: 'Enter a name, valid email, and password with at least 10 characters.' })
      if (!['patient', 'doctor', 'nurse'].includes(role) || !['Public clinic', 'Private clinic', 'Hospital'].includes(clinic)) return json(res, 400, { error: 'Select a valid role and clinic type.' })
      if (role !== 'patient' && (!process.env.STAFF_SIGNUP_CODE || body.staffCode !== process.env.STAFF_SIGNUP_CODE)) return json(res, 403, { error: 'A valid clinic staff invite code is required for doctor and nurse accounts.' })
      const salt = randomBytes(16).toString('hex')
      const passwordHash = `${salt}$${scryptSync(password, salt, 64).toString('hex')}`
      const user = { id: randomBytes(16).toString('hex'), name, email, role, clinic_type: clinic }
      db.prepare('INSERT INTO users(id,name,email,password_hash,role,clinic_type) VALUES(?,?,?,?,?,?)').run(user.id, name, email, passwordHash, role, clinic)
      return json(res, 201, { user: publicUser(user), token: createSession(user), signedInAt: Date.now() })
    } catch (error) {
      if (error?.status) return json(res, error.status, { error: error.message })
      if (String(error).includes('UNIQUE constraint failed')) return json(res, 409, { error: 'An account with this email already exists.' })
      console.error('Registration failed:', error instanceof Error ? error.message : 'unknown error')
      return json(res, 500, { error: 'Could not create the account.' })
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    try {
      const body = await readBody(req)
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const row = db.prepare('SELECT * FROM users WHERE email=?').get(email)
      if (!row || !password) return json(res, 401, { error: 'Email or password is incorrect.' })
      const [salt, hash] = row.password_hash.split('$')
      const candidate = scryptSync(password, salt, 64)
      if (!timingSafeEqual(candidate, Buffer.from(hash, 'hex'))) return json(res, 401, { error: 'Email or password is incorrect.' })
      return json(res, 200, { user: publicUser(row), token: createSession(row), signedInAt: Date.now() })
    } catch (error) {
      if (error?.status) return json(res, error.status, { error: error.message })
      console.error('Login failed:', error instanceof Error ? error.message : 'unknown error')
      return json(res, 500, { error: 'Could not sign in.' })
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const session = getSessionUser(req)
    return session ? json(res, 200, { user: session.user }) : json(res, 401, { error: 'Sign in required.' })
  }
  if ((req.method === 'PATCH' || req.method === 'DELETE') && url.pathname === '/api/auth/profile') {
    const session = getSessionUser(req)
    if (!session) return json(res, 401, { error: 'Sign in required.' })
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM users WHERE id=?').run(session.user.id)
      return json(res, 200, { ok: true })
    }
    try {
      const body = await readBody(req)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const clinic = body.clinic
      if (name.length < 2 || name.length > 100 || !['Public clinic', 'Private clinic', 'Hospital'].includes(clinic)) return json(res, 400, { error: 'Enter a valid name and clinic type.' })
      db.prepare('UPDATE users SET name=?, clinic_type=? WHERE id=?').run(name, clinic, session.user.id)
      const row = db.prepare('SELECT * FROM users WHERE id=?').get(session.user.id)
      return json(res, 200, { user: publicUser(row) })
    } catch (error) {
      if (error?.status) return json(res, error.status, { error: error.message })
      return json(res, 500, { error: 'Could not update the profile.' })
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const session = getSessionUser(req)
    if (session) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenDigest(session.token))
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/api/contact') {
    const ip = req.socket.remoteAddress || 'unknown'
    const lastSubmit = lastContactSubmit.get(ip) || 0
    if (Date.now() - lastSubmit < 30_000) return json(res, 429, { status: 'failed', error: 'Please wait a short time before sending another message.' })
    try {
      const body = await readBody(req)
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : ''
      const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : ''
      const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 100) : ''
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 1_200) : ''
      const subjects = ['Platform support', 'Appointments', 'Clinic listing', 'Other']
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !subjects.includes(subject) || message.length < 5) return json(res, 400, { status: 'failed', error: 'Please complete your name, valid email, subject and message.' })
      lastContactSubmit.set(ip, Date.now())
      const id = randomBytes(16).toString('hex')
      db.prepare('INSERT INTO contact_messages(id,name,email,phone,subject,message) VALUES(?,?,?,?,?,?)').run(id, name, email, phone, subject, message)
      if (!resendApiKey || !supportEmail || !fromEmail) return json(res, 202, { status: 'pending', message: 'Your message was saved, but email delivery is not configured yet.' })

      try {
        const delivery = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `smartclinic-contact-${id}` },
          body: JSON.stringify({
            from: fromEmail,
            to: [supportEmail],
            reply_to: email,
            subject: `[Smart Clinic] ${subject} — ${name}`,
            text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone || 'Not provided'}\n\n${message}`,
          }),
          signal: AbortSignal.timeout(20_000),
        })
        const result = await delivery.json().catch(() => ({}))
        if (!delivery.ok) {
          db.prepare("UPDATE contact_messages SET delivery_status='failed' WHERE id=?").run(id)
          console.error('Contact email provider rejected a message:', delivery.status)
          return json(res, 502, { status: 'failed', error: 'The email provider could not accept your message. It is saved for support follow-up.' })
        }
        db.prepare("UPDATE contact_messages SET delivery_status='sent',provider_id=? WHERE id=?").run(result.id || null, id)
        return json(res, 200, { status: 'sent', message: 'The email provider accepted your message for delivery.' })
      } catch (error) {
        db.prepare("UPDATE contact_messages SET delivery_status='failed' WHERE id=?").run(id)
        console.error('Contact email delivery failed:', error instanceof Error ? error.message : 'unknown error')
        return json(res, 502, { status: 'failed', error: 'Email delivery could not be confirmed. Your message is saved for support follow-up.' })
      }
    } catch (error) {
      if (error?.status) return json(res, error.status, { status: 'failed', error: error.message })
      console.error('Contact request failed:', error instanceof Error ? error.message : 'unknown error')
      return json(res, 500, { status: 'failed', error: 'Could not save your contact message.' })
    }
  }
  if (url.pathname === '/api/appointments' && (req.method === 'GET' || req.method === 'POST')) {
    const session = getSessionUser(req)
    if (!session) return json(res, 401, { error: 'Sign in required.' })
    if (req.method === 'GET') {
      const records = db.prepare('SELECT id,service,provider,appointment_date AS date,preferred_time AS time,visit_notes AS notes,status,created_at AS createdAt FROM appointments WHERE user_id=? ORDER BY appointment_date').all(session.user.id)
      return json(res, 200, { appointments: records })
    }
    try {
      const body = await readBody(req)
      const service = typeof body.service === 'string' ? body.service.trim() : ''
      const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
      const date = typeof body.date === 'string' ? body.date : ''
      const time = typeof body.time === 'string' ? body.time : ''
      const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 500) : ''
      if (session.user.role !== 'patient') return json(res, 403, { error: 'Only patient accounts can request appointments.' })
      if (!service || !provider || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !['Morning','Afternoon'].includes(time)) return json(res, 400, { error: 'Complete the service, provider, date, and preferred time.' })
      const id = randomBytes(16).toString('hex')
      db.prepare('INSERT INTO appointments(id,user_id,service,provider,appointment_date,preferred_time,visit_notes) VALUES(?,?,?,?,?,?,?)').run(id, session.user.id, service, provider, date, time, notes)
      return json(res, 201, { appointment: { id, service, provider, date, time, notes, status: 'Pending' } })
    } catch (error) {
      if (error?.status) return json(res, error.status, { error: error.message })
      console.error('Appointment request failed:', error instanceof Error ? error.message : 'unknown error')
      return json(res, 500, { error: 'Could not save the appointment request.' })
    }
  }
  if (req.method !== 'POST' || url.pathname !== '/api/assistant') return json(res, 404, { error: 'Not found' })

  let body
  try { body = await readBody(req) } catch (error) { return json(res, error?.status || 400, { error: error.message }) }
  const message = body.message
  if (typeof message !== 'string' || !message.trim()) return json(res, 400, { error: 'A message is required' })
  if (message.length > 2_000) return json(res, 413, { error: 'Message is too long' })
  if (!apiKey) return json(res, 200, { answer: demoAssistantReply(message), mode: 'demo' })

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        instructions: 'You are Smart Clinic’s general platform assistant. Answer questions about using the app and general clinic operations. Do not diagnose, triage, recommend treatment or medication, or ask for personal patient data. If asked for medical advice or emergencies, direct the person to a qualified clinician or local emergency services. Be concise and clearly state uncertainty.',
        input: message.trim(),
        max_output_tokens: 350,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await response.json()
    if (!response.ok) {
      const apiError = data?.error || {}
      const code = apiError.code || apiError.type || 'unknown_error'
      console.error('OpenAI request failed:', response.status, code)
      const explanation = response.status === 429
        ? ['insufficient_quota','credit_balance_exhausted','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded'].includes(code)
          ? 'OpenAI rejected the request because this API project may have no available credit or has reached a usage limit. Check the API project’s billing and limits. '
          : 'OpenAI rate-limited this request. Wait a little and try again. '
        : `OpenAI returned ${response.status} (${code}). Check the API key, project access and model settings. `
      return json(res, 200, { answer: `${explanation}${demoAssistantReply(message)}`, mode: 'demo', providerError: code })
    }
    const answer = (data.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n').trim()
    if (!answer) return json(res, 502, { error: 'The assistant returned no text.' })
    return json(res, 200, { answer, mode: 'ai' })
  } catch (error) {
    console.error('Assistant request error:', error instanceof Error ? error.message : 'unknown error')
    return json(res, 200, { answer: demoAssistantReply(message), mode: 'demo' })
  }
})

server.listen(port, () => console.log(`Smart Clinic API listening on http://localhost:${port}`))
