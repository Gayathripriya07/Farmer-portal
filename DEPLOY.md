# Deploy (Option 1: Real SMS)

This portal is a static website, but **sending a real SMS requires a backend**. Use `authority-sms-server.js` as that backend and deploy it with HTTPS.

## 1) Deploy the SMS server (Render/Railway/VPS)

### Required environment variables (for LIVE SMS via Twilio)
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM` (Twilio phone number / sender)

Optional:
- `PORT` (platform sets this automatically)
- `AUTHORITY_PHONE` (default: `9042477501`)
- `AUTO_VERIFY_MOCK` (`true`/`false`) – only for MOCK mode
- `STORE_FILE` (path to JSON store, default: `authority-sms-store.json`)

### Notes
- If Twilio env vars are not set, the server runs in **MOCK** mode (no real SMS, but it still returns `ok:true` and status updates).
- If your static site is hosted on `https://...`, your SMS server **must also be https://...** (otherwise the browser blocks calls as mixed content).

## 2) Point the website to your deployed server

In the browser, open schemes page once with:

`schemes.html?smsApi=https://YOUR-SMS-SERVER`

This saves the API base URL to `localStorage` and will be used automatically next time.

## 3) Test endpoints

- Health: `/api/health`
- Send: `POST /api/sms/send`
- Status: `GET /api/sms/status?ref=TN...`
- Inbound simulate: `POST /api/sms/inbound` with JSON `{ "text": "VERIFY TN..." }`

