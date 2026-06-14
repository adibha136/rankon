const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3077;
const DB_FILE = path.join(__dirname, 'db', 'clients.json');
const SETTINGS_FILE = path.join(__dirname, 'db', 'settings.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB helpers ──────────────────────────────────────────
function readDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ clients: [] }));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

const DEFAULT_SETTINGS = {
  agency: {
    name: 'Rankon Digital Marketing',
    email: 'hello@rankon.com.au',
    phone: '1300 000 000',
    website: 'https://rankon.com.au'
  },
  platformEmails: {
    facebook:   'facebook@rankon.com.au',
    instagram:  'facebook@rankon.com.au',
    google:     'google@rankon.com.au',
    googleAds:  'googleads@rankon.com.au',
    gsc:        'google@rankon.com.au',
    gbp:        'google@rankon.com.au',
    microsoft:  'microsoft@rankon.com.au',
    metaAds:    'facebook@rankon.com.au',
    tiktok:     'tiktok@rankon.com.au',
    linkedin:   'linkedin@rankon.com.au'
  },
  tokenExpiryDays: 30,
  pinRequired: false,
  completionWebhook: '',
  notificationEmail: 'hello@rankon.com.au'
};

function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
}
function writeSettings(data) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2)); }

// ── WHOIS via RDAP ──────────────────────────────────────
function rdapLookup(domain) {
  return new Promise((resolve) => {
    const url = `https://rdap.org/domain/${domain}`;
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const ns = (j.nameservers || []).map(n => (n.ldhName || n.unicodeName || '').toLowerCase()).filter(Boolean);
          const regEntity = (j.entities || []).find(e => (e.roles || []).includes('registrar'));
          const registrar = regEntity?.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3] || '';
          const expiry = (j.events || []).find(e => e.eventAction === 'expiration')?.eventDate?.slice(0, 10) || '';
          const hosting = ns.map(n => {
            if (n.includes('cloudflare')) return 'Cloudflare';
            if (n.includes('awsdns')) return 'AWS Route 53';
            if (n.includes('azure')) return 'Azure DNS';
            if (n.includes('godaddy') || n.includes('domaincontrol')) return 'GoDaddy';
            if (n.includes('google')) return 'Google Domains / Squarespace';
            if (n.includes('netregistry')) return 'Netregistry';
            if (n.includes('ventraip') || n.includes('vip')) return 'VentraIP';
            if (n.includes('panthur')) return 'Panthur';
            if (n.includes('crazy')) return 'Crazy Domains';
            if (n.includes('wordpress') || n.includes('wpengine')) return 'WP Engine';
            if (n.includes('shopify')) return 'Shopify';
            return null;
          }).find(Boolean) || '';
          resolve({ ns, registrar, expiry, hosting, error: false });
        } catch (e) {
          resolve({ ns: [], registrar: '', expiry: '', hosting: '', error: true });
        }
      });
    }).on('error', () => resolve({ ns: [], registrar: '', expiry: '', hosting: '', error: true }));
  });
}

// ── Helpers ─────────────────────────────────────────────
function isTokenExpired(client) {
  const settings = readSettings();
  const days = settings.tokenExpiryDays || 30;
  if (!client.createdAt) return false;
  const age = (Date.now() - new Date(client.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  return age > days;
}

function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function flagDomainExpiry(domains) {
  const now = new Date();
  return (domains || []).map(d => {
    if (!d.expiry) return d;
    const exp = new Date(d.expiry);
    const daysLeft = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
    return { ...d, daysLeft, expiryWarning: daysLeft <= 60 };
  });
}

// ── Settings API ────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(readSettings()));
app.put('/api/settings', (req, res) => {
  const current = readSettings();
  const updated = { ...current, ...req.body,
    agency: { ...current.agency, ...(req.body.agency || {}) },
    platformEmails: { ...current.platformEmails, ...(req.body.platformEmails || {}) }
  };
  writeSettings(updated);
  res.json(updated);
});

// ── Public settings (safe subset for client page) ───────
app.get('/api/public-settings', (req, res) => {
  const s = readSettings();
  res.json({
    agency: s.agency,
    platformEmails: s.platformEmails,
    pinRequired: s.pinRequired
  });
});

// ── Clients API ──────────────────────────────────────────
app.get('/api/clients', (req, res) => {
  const db = readDB();
  const now = new Date();
  const list = db.clients.map(c => {
    const domains = flagDomainExpiry(c.domains);
    const expiringDomains = domains.filter(d => d.expiryWarning);
    return {
      id: c.id, token: c.token,
      businessName: c.business?.name || '',
      industry: c.business?.industry || '',
      contact: c.contact?.name || '',
      abn: c.business?.abn || '',
      createdAt: c.createdAt, updatedAt: c.updatedAt,
      step: c.step || 1,
      completed: c.completed || false,
      lastSeen: c.lastSeen || null,
      tokenExpired: isTokenExpired(c),
      expiringDomains: expiringDomains.length,
      accessLog: c.accessLog || []
    };
  });
  res.json(list);
});

app.get('/api/clients/:id', (req, res) => {
  const db = readDB();
  const client = db.clients.find(c => c.id === req.params.id || c.token === req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  res.json({ ...client, domains: flagDomainExpiry(client.domains) });
});

app.post('/api/clients', (req, res) => {
  const db = readDB();
  // Duplicate ABN check
  if (req.body?.business?.abn) {
    const dup = db.clients.find(c => c.business?.abn === req.body.business.abn);
    if (dup) return res.status(409).json({ error: 'duplicate_abn', existing: dup.business?.name });
  }
  const settings = readSettings();
  const client = {
    id: uuidv4(),
    token: uuidv4(),
    pin: settings.pinRequired ? generatePin() : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    step: 1, completed: false,
    lastSeen: null, accessLog: [],
    business: {}, contact: {}, social: {}, google: {}, advertising: {}, domains: []
  };
  db.clients.push(client);
  writeDB(db);
  res.json(client);
});

app.put('/api/clients/:id', (req, res) => {
  const db = readDB();
  const idx = db.clients.findIndex(c => c.id === req.params.id || c.token === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  // Duplicate ABN check (exclude self)
  if (req.body?.business?.abn) {
    const dup = db.clients.find((c, i) => i !== idx && c.business?.abn === req.body.business.abn);
    if (dup) return res.status(409).json({ error: 'duplicate_abn', existing: dup.business?.name });
  }
  db.clients[idx] = { ...db.clients[idx], ...req.body, updatedAt: new Date().toISOString() };
  writeDB(db);
  res.json(db.clients[idx]);
});

app.delete('/api/clients/:id', (req, res) => {
  const db = readDB();
  const idx = db.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.clients.splice(idx, 1);
  writeDB(db);
  res.json({ ok: true });
});

// Regenerate token
app.post('/api/clients/:id/regenerate-token', (req, res) => {
  const db = readDB();
  const idx = db.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.clients[idx].token = uuidv4();
  db.clients[idx].createdAt = new Date().toISOString();
  db.clients[idx].completed = false;
  writeDB(db);
  res.json({ token: db.clients[idx].token });
});

// ── Client portal: validate PIN + log access ─────────────
app.post('/api/portal/:token/access', (req, res) => {
  const db = readDB();
  const client = db.clients.find(c => c.token === req.params.token);
  if (!client) return res.status(404).json({ error: 'not_found' });
  if (isTokenExpired(client)) return res.status(410).json({ error: 'expired' });
  const settings = readSettings();
  if (settings.pinRequired && client.pin && req.body.pin !== client.pin) {
    return res.status(401).json({ error: 'invalid_pin' });
  }
  // Log access
  const idx = db.clients.findIndex(c => c.token === req.params.token);
  db.clients[idx].lastSeen = new Date().toISOString();
  db.clients[idx].accessLog = [...(db.clients[idx].accessLog || []).slice(-19), {
    at: new Date().toISOString(), ip: req.ip || ''
  }];
  writeDB(db);
  // Return safe client data (no PIN, no internal IDs beyond what's needed)
  const { pin: _pin, accessLog: _log, ...safeClient } = db.clients[idx];
  res.json(safeClient);
});

// ── Client portal: submit (mark complete) ───────────────
app.post('/api/portal/:token/submit', (req, res) => {
  const db = readDB();
  const idx = db.clients.findIndex(c => c.token === req.params.token);
  if (idx === -1) return res.status(404).json({ error: 'not_found' });
  db.clients[idx] = {
    ...db.clients[idx], ...req.body,
    completed: true, completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), step: 3
  };
  writeDB(db);
  // Fire webhook if configured
  const settings = readSettings();
  if (settings.completionWebhook) {
    try {
      const u = new URL(settings.completionWebhook);
      const payload = JSON.stringify({ event: 'onboarding_complete', clientId: db.clients[idx].id, business: db.clients[idx].business?.name, completedAt: db.clients[idx].completedAt });
      const opts = { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
      const req2 = https.request(opts); req2.write(payload); req2.end();
    } catch (e) {}
  }
  res.json({ ok: true });
});

// ── WHOIS ───────────────────────────────────────────────
app.get('/api/whois/:domain', async (req, res) => {
  const result = await rdapLookup(req.params.domain);
  res.json(result);
});

// ── Vault export ─────────────────────────────────────────
app.get('/api/clients/:id/export', (req, res) => {
  const db = readDB();
  const client = db.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const name = client.business?.name || 'Client';
  const vaultExport = {
    encrypted: false,
    items: [
      { type: 2, name: `[Rankon] ${name} — Business Profile`, notes: buildNote('BUSINESS PROFILE', { 'Business name': client.business?.name, 'ABN': client.business?.abn, 'Billing email': client.business?.billingEmail, 'Industry': client.business?.industry, 'Addresses': (client.business?.addresses || []).join('\n  '), 'Contact name': client.contact?.name, 'Contact phone': client.contact?.phone, 'Contact email': client.contact?.email, 'Contact role': client.contact?.role }), secureNote: { type: 0 } },
      { type: 2, name: `[Rankon] ${name} — Digital Platforms`, notes: buildNote('SOCIAL MEDIA', { 'Facebook': client.social?.facebook, 'Instagram': client.social?.instagram, 'TikTok': client.social?.tiktok, 'LinkedIn': client.social?.linkedin }) + '\n\n' + buildNote('GOOGLE', { 'Business Profile': client.google?.businessProfile, 'GA4 Property': client.google?.analyticsGA4, 'Google Ads CID': client.google?.adsCID, 'Search Console': client.google?.searchConsole }) + '\n\n' + buildNote('ADVERTISING', { 'Microsoft Ads': client.advertising?.microsoftAds, 'Meta Ads Manager': client.advertising?.metaAds }), secureNote: { type: 0 } },
      { type: 2, name: `[Rankon] ${name} — Domains`, notes: (client.domains || []).map(d => `Domain: ${d.domain}\nRegistrar: ${d.registrar || '—'}\nExpiry: ${d.expiry || '—'}\nNameservers: ${(d.ns || []).join(', ') || '—'}\nHosting: ${d.hosting || '—'}`).join('\n\n---\n\n') || 'No domains recorded', secureNote: { type: 0 } }
    ]
  };
  res.json(vaultExport);
});

function buildNote(title, fields) {
  return [`=== ${title} ===`, ...Object.entries(fields).map(([k, v]) => `${k}: ${v || '—'}`)].join('\n');
}

// ── Routes for SPA ────────────────────────────────────────
app.get('/onboard/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Rankon Onboarding → http://localhost:${PORT}`));
