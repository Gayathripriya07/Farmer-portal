const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const PORT = Number(process.env.PORT || 8787);
const AUTHORITY_PHONE = (process.env.AUTHORITY_PHONE || '9042477501').replace(/\D/g, '');
const STORE_FILE = process.env.STORE_FILE
  ? path.resolve(process.env.STORE_FILE)
  : path.join(__dirname, 'authority-sms-store.json');

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_FROM || '';
const LIVE_SMS = Boolean(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);
const AUTO_VERIFY_MOCK = String(process.env.AUTO_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

let memoryStore = { refs: {} };

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function ensureStore() {
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ refs: {} }, null, 2), 'utf8');
  }
}

function readStore() {
  try {
    ensureStore();
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (_) {
    return memoryStore;
  }
}

function writeStore(store) {
  memoryStore = store;
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (_) {
    // Some deploy platforms have read-only or ephemeral FS; keep in-memory store as fallback.
  }
}

function normalizeRef(text) {
  return String(text || '').trim().toUpperCase();
}

function upsertStatus(ref, payload) {
  const store = readStore();
  const now = new Date().toISOString();
  if (!store.refs[ref]) {
    store.refs[ref] = {
      ref,
      status: 'pending',
      authorityPhone: AUTHORITY_PHONE,
      createdAt: now,
      updatedAt: now,
      history: []
    };
  }
  const current = store.refs[ref];
  if (payload.status) current.status = payload.status;
  if (payload.message) current.authorityMessage = payload.message;
  if (payload.schemeName) current.schemeName = payload.schemeName;
  if (payload.applicantMobile) current.applicantMobile = payload.applicantMobile;
  current.updatedAt = now;
  current.history.push({
    at: now,
    status: current.status,
    message: payload.message || ''
  });
  writeStore(store);
  return current;
}

function getStatus(ref) {
  const store = readStore();
  return store.refs[ref] || null;
}

function autoProgressMockStatus(ref) {
  if (!AUTO_VERIFY_MOCK) return;
  setTimeout(() => {
    const st = getStatus(ref);
    if (!st || st.status !== 'pending') return;
    upsertStatus(ref, { status: 'verified_authority', message: 'Authority verified application (auto mock)' });
  }, 7000);

  setTimeout(() => {
    const st = getStatus(ref);
    if (!st || (st.status !== 'verified_authority' && st.status !== 'pending')) return;
    upsertStatus(ref, { status: 'sent_to_government', message: 'Application sent to government (auto mock)' });
  }, 13000);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      const ctype = String(req.headers['content-type'] || '');
      if (!raw) return resolve({});
      try {
        if (ctype.includes('application/json')) return resolve(JSON.parse(raw));
        if (ctype.includes('application/x-www-form-urlencoded')) return resolve(querystring.parse(raw));
        return resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('invalid payload'));
      }
    });
    req.on('error', reject);
  });
}

async function sendViaTwilio(to, message) {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const form = new URLSearchParams();
  form.set('To', to.startsWith('+') ? to : `+91${to.replace(/\D/g, '')}`);
  form.set('From', TWILIO_FROM);
  form.set('Body', message);

  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.message || `twilio status ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function extractRefFromText(text) {
  const msg = String(text || '').trim();
  const m = msg.match(/(VERIFY|FORWARD|REJECT)\s+([A-Z0-9]+)/i);
  if (!m) return null;
  return {
    command: m[1].toUpperCase(),
    ref: normalizeRef(m[2])
  };
}

function handleInboundCommand(command, ref, rawText) {
  if (!ref) return null;
  if (command === 'VERIFY') {
    upsertStatus(ref, { status: 'verified_authority', message: 'Authority verified application' });
    return upsertStatus(ref, { status: 'sent_to_government', message: 'Application sent to government' });
  }
  if (command === 'FORWARD') {
    return upsertStatus(ref, { status: 'sent_to_government', message: 'Application sent to government' });
  }
  if (command === 'REJECT') {
    return upsertStatus(ref, { status: 'rejected', message: rawText || 'Rejected by authority' });
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, liveSms: LIVE_SMS, authorityPhone: AUTHORITY_PHONE });
  }

  if (req.method === 'POST' && pathname === '/api/sms/send') {
    try {
      const body = await parseBody(req);
      const to = String(body.to || '').replace(/\D/g, '');
      const message = String(body.message || '').trim();
      const ref = normalizeRef(body.applicationRef || '');
      const schemeName = String(body.schemeName || '');
      const applicantMobile = String(body.applicantMobile || '');

      if (!to || !message || !ref) {
        return sendJson(res, 400, { ok: false, error: 'to, message, applicationRef required' });
      }

      upsertStatus(ref, {
        status: 'pending',
        message: 'Authority SMS triggered',
        schemeName,
        applicantMobile
      });

      if (LIVE_SMS) {
        const sent = await sendViaTwilio(to, message);
        upsertStatus(ref, { status: 'pending', message: `Sent via Twilio SID: ${sent.sid}` });
        return sendJson(res, 200, { ok: true, mode: 'live', providerMessageId: sent.sid, ref });
      }

      autoProgressMockStatus(ref);
      return sendJson(res, 200, { ok: true, mode: 'mock', providerMessageId: `MOCK-${Date.now()}`, ref });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message || 'send failed' });
    }
  }

  if (req.method === 'GET' && pathname === '/api/sms/status') {
    const ref = normalizeRef(reqUrl.searchParams.get('ref') || '');
    if (!ref) return sendJson(res, 400, { ok: false, error: 'ref required' });
    const status = getStatus(ref);
    if (!status) return sendJson(res, 200, { ok: true, status: 'pending', ref });
    return sendJson(res, 200, { ok: true, ...status });
  }

  if (req.method === 'POST' && pathname === '/api/sms/inbound') {
    try {
      const body = await parseBody(req);
      const text = body.Body || body.message || body.text || '';
      const parsed = extractRefFromText(text);
      if (!parsed) {
        return sendJson(res, 400, { ok: false, error: 'Expected VERIFY <REF> / FORWARD <REF> / REJECT <REF>' });
      }
      const status = handleInboundCommand(parsed.command, parsed.ref, text);
      if (!status) return sendJson(res, 400, { ok: false, error: 'Invalid command' });
      return sendJson(res, 200, { ok: true, ...status });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message || 'inbound failed' });
    }
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  const mode = LIVE_SMS ? 'LIVE' : 'MOCK';
  console.log(`Authority SMS server running on http://localhost:${PORT} (${mode})`);
  console.log(`Authority phone: ${AUTHORITY_PHONE}`);
});
