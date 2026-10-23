// Showrunner API (project showrunner-tools). One endpoint for now:
//   POST /api/feedback   (Firebase Hosting rewrites showrunner.tools/api/feedback here)
//
// Every bug report, feature request, feedback and contact message comes through
// here; Firestore rules refuse direct writes, so this is the only way in.
//  - From the website: a Cloudflare Turnstile token is required and verified
//    server-side with Cloudflare (owner, 2026-10-23).
//  - From the extension (Turnstile can't run there): a per-install id and a
//    rate limit, until signed-in licenses replace it.
// Scale-to-zero (no minInstances): nobody waits on this during a show.
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const TURNSTILE_SECRET = defineSecret('TURNSTILE_SECRET');

const SITE_ORIGINS = new Set(['https://showrunner.tools', 'https://www.showrunner.tools', 'https://showrunner-tools.web.app']);
const TYPES = new Set(['bug', 'feature', 'feedback']);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LIMITS = { ip: { n: 10, windowMs: 60 * 60 * 1000 }, install: { n: 20, windowMs: 24 * 60 * 60 * 1000 } };

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function verifyTurnstile(token, ip) {
  if (!token) return false;
  const body = new URLSearchParams({ secret: TURNSTILE_SECRET.value(), response: token });
  if (ip) body.set('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  return j.success === true && (!j.hostname || /(^|\.)showrunner\.tools$|showrunner-tools\.web\.app$/.test(j.hostname));
}

// Fixed-window counter in Firestore: rate/{kind}:{key}. Returns false when over.
async function underLimit(kind, key) {
  const { n, windowMs } = LIMITS[kind];
  const ref = db.collection('rate').doc(`${kind}:${key}`.slice(0, 400).replace(/\//g, '_'));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const d = snap.exists ? snap.data() : null;
    if (!d || now - d.start > windowMs) { tx.set(ref, { start: now, count: 1 }); return true; }
    if (d.count >= n) return false;
    tx.update(ref, { count: d.count + 1 });
    return true;
  });
}

exports.feedback = onRequest(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30, maxInstances: 5, secrets: [TURNSTILE_SECRET] },
  async (req, res) => {
    const origin = req.get('origin') || '';
    const fromSite = SITE_ORIGINS.has(origin);
    const fromExtension = origin.startsWith('chrome-extension://');
    if (fromSite) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!fromSite && !fromExtension) return res.status(403).json({ error: 'origin not allowed' });

    const b = req.body || {};
    const ip = (req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
    const doc = {
      type: TYPES.has(b.type) ? b.type : 'feedback',
      message: str(b.message, 5000),
      email: str(b.email, 200),
      version: str(b.version, 20) || (fromSite ? 'site' : '?'),
      page: str(b.page, 40),
      status: 'new',
      source: fromSite ? 'site' : 'extension',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (typeof b.diagnostics === 'string') doc.diagnostics = b.diagnostics.slice(0, 20000);
    if (!doc.message) return res.status(400).json({ error: 'message required' });
    if (!EMAIL_RE.test(doc.email)) return res.status(400).json({ error: 'valid email required' });

    try {
      if (!(await underLimit('ip', ip || 'unknown'))) return res.status(429).json({ error: 'too many messages, try again later' });
      if (fromSite) {
        if (!(await verifyTurnstile(str(b.turnstileToken, 4096), ip))) return res.status(403).json({ error: 'verification failed' });
      } else {
        const install = str(b.installId, 64);
        if (!/^[A-Za-z0-9-]{16,64}$/.test(install)) return res.status(400).json({ error: 'install id required' });
        if (!(await underLimit('install', install))) return res.status(429).json({ error: 'too many reports today' });
        doc.installId = install;
      }
      await db.collection('feedback').add(doc);
      return res.json({ ok: true });
    } catch (err) {
      console.error('feedback failed', err);
      return res.status(500).json({ error: 'could not save' });
    }
  },
);
