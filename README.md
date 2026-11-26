# Smart Clinic

Responsive clinic-management demonstration built with React, TypeScript and Vite, with a small Node API for the optional OpenAI assistant.

## Project layout

```text
backend/       Node API and server-only environment settings
frontend/      React application, routes, styles and public assets
package.json   Root development scripts and shared dependencies
```

## Run locally

1. Use Node.js 22.6 or later and install root dependencies with `npm install`.
2. Copy `backend/.env.example` to `backend/.env` and set a private staff invite code.
3. Run `npm run dev` to start both the frontend and backend together.
4. Copy `frontend/.env.example` to `frontend/.env.local` if the API URL differs from `http://localhost:8787`.

Registration and login use the Node backend. Passwords are scrypt-hashed in a local SQLite database, bearer sessions expire after 24 hours, and doctor/nurse registration requires a clinic invite code. Set a private `STAFF_SIGNUP_CODE` in `backend/.env` before creating staff accounts.

The assistant stays inactive until an OpenAI API key is configured as `OPENAI_API_KEY` in `backend/.env`. Never put this key in a `VITE_` variable or frontend code. Create/manage the key through your own OpenAI API account. The backend uses the Responses API and restricts the assistant to general platform/clinic-operations help, not diagnosis or treatment advice.

For contact form email delivery, set `CONTACT_RECIPIENT_EMAIL`, `CONTACT_FROM_EMAIL` (a sender verified with your email provider), and `RESEND_API_KEY` in `backend/.env`. The server saves submissions to SQLite and sends them through the Resend Email API. If delivery isn't configured or accepted, the form reports that clearly instead of claiming the email was sent. Provider acceptance confirms the send request was accepted, but does not prove the recipient's inbox received it.

## Deploy chat on Vercel

The Vercel deployment serves the frontend and the `api/assistant.js` serverless endpoint. In the Vercel project, add `OPENAI_API_KEY` as a server-side Environment Variable for Production (and Preview if needed), then redeploy. Optionally set `OPENAI_MODEL`; the default is `gpt-4.1-mini`. Never use a `VITE_` prefix for the key. The local Node API uses `backend/.env`, while the Vercel function reads Vercel project environment variables.

The Vercel assistant endpoint returns a visible setup or provider error when a key is missing, invalid, out of credit, or cannot access the selected model.

## Demo limitations

- FAQ questions and demo settings are stored in this browser. Authentication works against the local API, but the local SQLite database and session setup are a demonstration and still need production hardening and backups.
- Clinic activity and patient rows are synthetic. Do not enter real patient or health information.
- Geolocation is requested only after the user chooses “Share my location”. The destination is currently a generic sample in Harare; there is no verified clinic or pharmacy directory yet.
- Marketplace examples do not claim live medicine availability or real prices. Confirm any medicine with a licensed pharmacy.
- Supabase authentication, database, role-based RLS, live clinic feeds, verified maps, appointment persistence, clinician chat, AI reminder lifecycle, and real marketplace integrations still need implementation before real-world clinic use.

## Useful commands

- `npm run dev` — frontend and backend development servers
- `npm run dev:frontend` — frontend only
- `npm run backend` — local Node API
- `npm run build` — TypeScript and production frontend build
- `npm run lint` — frontend lint

