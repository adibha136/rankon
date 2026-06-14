require('dotenv').config(); // loads .env file (rename .env.production → .env on server)

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const https = require('https');
const fs = require('fs');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3077;

// ── MySQL Config (from .env) ──────────────────────────────
// Use socket (DB_SOCKET) if set — avoids IPv6/TCP permission issues on shared hosting
const DB_CONFIG = process.env.DB_SOCKET
  ? { socketPath: process.env.DB_SOCKET, user: process.env.DB_USER || 'root', password: process.env.DB_PASS || '', timezone: '+00:00' }
  : { host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root', password: process.env.DB_PASS || '', timezone: '+00:00' };
const DB_NAME = process.env.DB_NAME || 'RankOncrm';
let pool;

// ── Auth ─────────────────────────────────────────────────
// Default seed admins (only inserted once if users table is empty)
const SEED_ADMINS = [
  { email: 'satheesh@smart-tech.melbourne', name: 'Satheesh', role: 'admin' },
  { email: 'selva@smart-tech.melbourne',    name: 'Selva',    role: 'admin' }
];

const sessions = new Map(); // sessionToken → { email, name, role, loginAt }

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'unauthorized' });
  req.user = sessions.get(token);
  next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin_required', message: 'Admin role required.' });
  next();
}

// Creates the database if it doesn't exist, then initialises the connection pool
async function ensureDatabase() {
  const conn = await mysql.createConnection(DB_CONFIG);
  await conn.execute(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.end();
  pool = mysql.createPool({ ...DB_CONFIG, database: DB_NAME, waitForConnections: true, connectionLimit: 10 });
}

// ── Default Settings ─────────────────────────────────────
const DEFAULT_SETTINGS = {
  agency: {
    name: 'Rankon Digital Marketing',
    email: 'hello@rankon.com.au',
    phone: '1300 000 000',
    website: 'https://rankon.com.au'
  },
  platformEmails: {
    facebook:  'facebook@rankon.com.au',
    instagram: 'facebook@rankon.com.au',
    google:    'google@rankon.com.au',
    googleAds: 'googleads@rankon.com.au',
    gsc:       'google@rankon.com.au',
    gbp:       'google@rankon.com.au',
    microsoft: 'microsoft@rankon.com.au',
    metaAds:   'facebook@rankon.com.au',
    tiktok:    'tiktok@rankon.com.au',
    linkedin:  'linkedin@rankon.com.au'
  },
  tokenExpiryDays: 30,
  pinRequired: false,
  completionWebhook: '',
  notificationEmail: 'hello@rankon.com.au',
  smtp: {
    enabled:   false,
    host:      '',
    port:      587,
    secure:    false,
    user:      '',
    pass:      '',
    fromName:  'Rankon Digital Marketing',
    fromEmail: ''
  }
};

// ── Init DB Schema ───────────────────────────────────────
async function initDB() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS clients (
        id            VARCHAR(36)  PRIMARY KEY,
        token         VARCHAR(36)  UNIQUE NOT NULL,
        pin           VARCHAR(10)  DEFAULT NULL,
        created_at    DATETIME     DEFAULT NULL,
        updated_at    DATETIME     DEFAULT NULL,
        completed_at  DATETIME     DEFAULT NULL,
        step          INT          DEFAULT 1,
        completed     TINYINT(1)   DEFAULT 0,
        last_seen     DATETIME     DEFAULT NULL,
        access_log    JSON,
        business      JSON,
        contact       JSON,
        social        JSON,
        google_data   JSON,
        advertising   JSON,
        domains       JSON
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        id                  INT          PRIMARY KEY DEFAULT 1,
        agency              JSON,
        platform_emails     JSON,
        token_expiry_days   INT          DEFAULT 30,
        pin_required        TINYINT(1)   DEFAULT 0,
        completion_webhook  VARCHAR(500) DEFAULT '',
        notification_email  VARCHAR(255) DEFAULT 'hello@rankon.com.au'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Users table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        email      VARCHAR(255) PRIMARY KEY,
        name       VARCHAR(255) DEFAULT '',
        role       ENUM('admin','staff','viewer') NOT NULL DEFAULT 'staff',
        added_by   VARCHAR(255) DEFAULT '',
        added_at   DATETIME DEFAULT NULL,
        active     TINYINT(1) DEFAULT 1
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Seed default admins if table is empty
    const [uc] = await conn.execute('SELECT COUNT(*) AS n FROM users');
    if (uc[0].n === 0) {
      for (const u of SEED_ADMINS) {
        await conn.execute(
          'INSERT IGNORE INTO users (email,name,role,added_by,added_at,active) VALUES (?,?,?,?,?,1)',
          [u.email, u.name, u.role, 'system', new Date()]
        );
      }
    }

    // Add email_sent_at column to clients if it doesn't exist
    try { await conn.execute(`ALTER TABLE clients ADD COLUMN email_sent_at DATETIME DEFAULT NULL`); }
    catch(e) { if (!e.message.includes('Duplicate column name')) throw e; }

    // Add smtp column if it doesn't exist yet (safe to run on every boot)
    try {
      await conn.execute(`ALTER TABLE settings ADD COLUMN smtp JSON`);
    } catch (e) {
      if (!e.message.includes('Duplicate column name')) throw e;
    }

    // Seed default settings row if table is empty
    await conn.execute(
      `INSERT IGNORE INTO settings
         (id, agency, platform_emails, token_expiry_days, pin_required, completion_webhook, notification_email, smtp)
       VALUES (1, ?, ?, 30, 0, '', 'hello@rankon.com.au', ?)`,
      [JSON.stringify(DEFAULT_SETTINGS.agency), JSON.stringify(DEFAULT_SETTINGS.platformEmails), JSON.stringify(DEFAULT_SETTINGS.smtp)]
    );
    console.log('MySQL connected — tables ready.');
  } finally {
    conn.release();
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Request logger ───────────────────────────────────────
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Helpers ──────────────────────────────────────────────
function parseJSON(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// Convert a DB row back to the JS client shape the frontend expects
function rowToClient(r) {
  return {
    id:          r.id,
    token:       r.token,
    pin:         r.pin || null,
    createdAt:   r.created_at  ? new Date(r.created_at).toISOString()  : null,
    updatedAt:   r.updated_at  ? new Date(r.updated_at).toISOString()  : null,
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    step:        r.step || 1,
    completed:   !!r.completed,
    lastSeen:    r.last_seen   ? new Date(r.last_seen).toISOString()   : null,
    emailSentAt: r.email_sent_at ? new Date(r.email_sent_at).toISOString() : null,
    accessLog:   parseJSON(r.access_log,  []),
    business:    parseJSON(r.business,    {}),
    contact:     parseJSON(r.contact,     {}),
    social:      parseJSON(r.social,      {}),
    google:      parseJSON(r.google_data, {}),
    advertising: parseJSON(r.advertising, {}),
    domains:     parseJSON(r.domains,     [])
  };
}

async function readSettings() {
  const [rows] = await pool.execute('SELECT * FROM settings WHERE id = 1');
  if (!rows.length) return DEFAULT_SETTINGS;
  const r = rows[0];
  return {
    agency:           parseJSON(r.agency,          DEFAULT_SETTINGS.agency),
    platformEmails:   parseJSON(r.platform_emails, DEFAULT_SETTINGS.platformEmails),
    tokenExpiryDays:  r.token_expiry_days || 30,
    pinRequired:      !!r.pin_required,
    completionWebhook: r.completion_webhook || '',
    notificationEmail: r.notification_email || '',
    smtp:             parseJSON(r.smtp, DEFAULT_SETTINGS.smtp)
  };
}

async function writeSettings(data) {
  await pool.execute(
    `INSERT INTO settings (id, agency, platform_emails, token_expiry_days, pin_required, completion_webhook, notification_email, smtp)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       agency             = VALUES(agency),
       platform_emails    = VALUES(platform_emails),
       token_expiry_days  = VALUES(token_expiry_days),
       pin_required       = VALUES(pin_required),
       completion_webhook = VALUES(completion_webhook),
       notification_email = VALUES(notification_email),
       smtp               = VALUES(smtp)`,
    [
      JSON.stringify(data.agency),
      JSON.stringify(data.platformEmails),
      data.tokenExpiryDays || 30,
      data.pinRequired ? 1 : 0,
      data.completionWebhook || '',
      data.notificationEmail || '',
      JSON.stringify(data.smtp || DEFAULT_SETTINGS.smtp)
    ]
  );
}

async function isTokenExpired(client) {
  const settings = await readSettings();
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

// ── WHOIS via RDAP ───────────────────────────────────────
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
            if (n.includes('cloudflare'))                     return 'Cloudflare';
            if (n.includes('awsdns'))                         return 'AWS Route 53';
            if (n.includes('azure'))                          return 'Azure DNS';
            if (n.includes('godaddy') || n.includes('domaincontrol')) return 'GoDaddy';
            if (n.includes('google'))                         return 'Google Domains / Squarespace';
            if (n.includes('netregistry'))                    return 'Netregistry';
            if (n.includes('ventraip') || n.includes('vip')) return 'VentraIP';
            if (n.includes('panthur'))                        return 'Panthur';
            if (n.includes('crazy'))                          return 'Crazy Domains';
            if (n.includes('wordpress') || n.includes('wpengine')) return 'WP Engine';
            if (n.includes('shopify'))                        return 'Shopify';
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

// ── Diagnostic ping (no auth required) ───────────────────
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, version: 'rankon-root-v2', routes: ['auth','clients','settings'] });
});

// ── Auth routes ──────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'missing_token' });
    // Decode MS JWT payload (base64url → JSON)
    const b64 = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const email = (payload.preferred_username || payload.email || payload.upn || '').toLowerCase();
    const msName = payload.name || email;
    // Look up user in DB
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ? AND active = 1', [email]);
    if (!rows.length) return res.status(403).json({ error: 'access_denied', email });
    const dbUser = rows[0];
    // Use DB name if set, else MS display name
    const name = dbUser.name || msName;
    const sessionToken = uuidv4();
    sessions.set(sessionToken, { email, name, role: dbUser.role, loginAt: new Date().toISOString() });
    if (sessions.size > 200) sessions.delete(sessions.keys().next().value);
    res.json({ token: sessionToken, email, name, role: dbUser.role });
  } catch (e) {
    res.status(400).json({ error: 'invalid_token', message: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'unauthorized' });
  res.json(sessions.get(token));
});

// ── User management API (admin only) ─────────────────────
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT email,name,role,added_by,added_at,active FROM users ORDER BY added_at ASC'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, name, role } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'email and role are required' });
    const validRoles = ['admin', 'staff', 'viewer'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    await pool.execute(
      'INSERT INTO users (email,name,role,added_by,added_at,active) VALUES (?,?,?,?,?,1)',
      [email.toLowerCase().trim(), name || '', role, req.user.email, new Date()]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'User already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:email', requireAuth, requireAdmin, async (req, res) => {
  try {
    const target = req.params.email.toLowerCase();
    // Prevent admin from demoting themselves
    if (target === req.user.email && req.body.role && req.body.role !== 'admin') {
      return res.status(400).json({ error: 'You cannot change your own role.' });
    }
    const { role, active, name } = req.body;
    const updates = []; const params = [];
    if (role   !== undefined) { updates.push('role = ?');   params.push(role); }
    if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
    if (name   !== undefined) { updates.push('name = ?');   params.push(name); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(target);
    await pool.execute(`UPDATE users SET ${updates.join(', ')} WHERE email = ?`, params);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:email', requireAuth, requireAdmin, async (req, res) => {
  try {
    const target = req.params.email.toLowerCase();
    if (target === req.user.email) return res.status(400).json({ error: 'You cannot delete your own account.' });
    await pool.execute('DELETE FROM users WHERE email = ?', [target]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Email helper ─────────────────────────────────────────
function makeTransporter(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port || 587,
    secure: !!smtp.secure,  // true = SSL/465, false = STARTTLS/587
    auth: { user: smtp.user, pass: smtp.pass },
    tls: { rejectUnauthorized: false }
  });
}
async function sendMail(smtp, { to, subject, html, attachments }) {
  const transporter = makeTransporter(smtp);
  return transporter.sendMail({
    from: `"${smtp.fromName || 'Rankon'}" <${smtp.fromEmail || smtp.user}>`,
    to, subject, html,
    ...(attachments?.length ? { attachments } : {})
  });
}

// ── Settings API ─────────────────────────────────────────
app.get('/api/settings', requireAuth, async (req, res) => {
  try { res.json(await readSettings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', requireAuth, async (req, res) => {
  try {
    const current = await readSettings();
    const updated = {
      ...current, ...req.body,
      agency:         { ...current.agency,         ...(req.body.agency         || {}) },
      platformEmails: { ...current.platformEmails, ...(req.body.platformEmails || {}) }
    };
    await writeSettings(updated);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Test SMTP ─────────────────────────────────────────────
app.post('/api/settings/test-smtp', requireAuth, async (req, res) => {
  try {
    const settings = await readSettings();
    const smtp = settings.smtp;
    if (!smtp?.host || !smtp?.user) {
      return res.status(400).json({ error: 'SMTP not configured — fill in host, username and password first.' });
    }
    const to = req.body.to || settings.notificationEmail;
    if (!to) return res.status(400).json({ error: 'No recipient email — set Notification email in settings.' });
    await sendMail(smtp, {
      to,
      subject: '✅ Rankon CRM — SMTP Test',
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:#7C3AED">SMTP connection working!</h2>
        <p>Your Rankon CRM can successfully send emails via <strong>${smtp.host}:${smtp.port}</strong>.</p>
        <p style="color:#6b7280;font-size:13px">Sent at ${new Date().toLocaleString('en-AU')}</p>
      </div>`
    });
    res.json({ ok: true, to });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Public settings (safe subset for client portal) ──────
app.get('/api/public-settings', async (req, res) => {
  try {
    const s = await readSettings();
    res.json({ agency: s.agency, platformEmails: s.platformEmails, pinRequired: s.pinRequired });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Clients API ───────────────────────────────────────────
app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM clients ORDER BY created_at DESC');
    const list = await Promise.all(rows.map(async r => {
      const c = rowToClient(r);
      const domains = flagDomainExpiry(c.domains);
      return {
        id: c.id, token: c.token,
        businessName: c.business?.name || '',
        industry:     c.business?.industry || '',
        contact:      c.contact?.name || '',
        abn:          c.business?.abn || '',
        createdAt:    c.createdAt,
        updatedAt:    c.updatedAt,
        step:         c.step || 1,
        completed:    c.completed || false,
        lastSeen:     c.lastSeen || null,
        tokenExpired: await isTokenExpired(c),
        expiringDomains: domains.filter(d => d.expiryWarning).length,
        accessLog:    c.accessLog || [],
        emailSentAt:  c.emailSentAt || null
      };
    }));
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM clients WHERE id = ? OR token = ?',
      [req.params.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const client = rowToClient(rows[0]);
    res.json({ ...client, domains: flagDomainExpiry(client.domains) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', requireAuth, async (req, res) => {
  try {
    // Duplicate ABN check
    if (req.body?.business?.abn) {
      const [dup] = await pool.execute(
        `SELECT id, business FROM clients WHERE JSON_UNQUOTE(JSON_EXTRACT(business, '$.abn')) = ?`,
        [req.body.business.abn]
      );
      if (dup.length) {
        return res.status(409).json({ error: 'duplicate_abn', existing: parseJSON(dup[0].business, {}).name });
      }
    }
    const settings = await readSettings();
    const now = new Date();
    const id    = uuidv4();
    const token = uuidv4();
    const pin   = settings.pinRequired ? generatePin() : null;
    await pool.execute(
      `INSERT INTO clients
         (id, token, pin, created_at, updated_at, step, completed, last_seen,
          access_log, business, contact, social, google_data, advertising, domains)
       VALUES (?, ?, ?, ?, ?, 1, 0, NULL,
               '[]', '{}', '{}', '{}', '{}', '{}', '[]')`,
      [id, token, pin, now, now]
    );
    const [rows] = await pool.execute('SELECT * FROM clients WHERE id = ?', [id]);
    res.json(rowToClient(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM clients WHERE id = ? OR token = ?',
      [req.params.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const existing = rowToClient(rows[0]);

    // Duplicate ABN check (exclude self)
    if (req.body?.business?.abn) {
      const [dup] = await pool.execute(
        `SELECT id, business FROM clients WHERE JSON_UNQUOTE(JSON_EXTRACT(business, '$.abn')) = ? AND id != ?`,
        [req.body.business.abn, existing.id]
      );
      if (dup.length) {
        return res.status(409).json({ error: 'duplicate_abn', existing: parseJSON(dup[0].business, {}).name });
      }
    }

    const merged = { ...existing, ...req.body };
    const now = new Date();
    await pool.execute(
      `UPDATE clients SET
         token = ?, pin = ?, updated_at = ?, completed_at = ?,
         step = ?, completed = ?, last_seen = ?,
         access_log = ?, business = ?, contact = ?,
         social = ?, google_data = ?, advertising = ?, domains = ?
       WHERE id = ?`,
      [
        merged.token,
        merged.pin,
        now,
        merged.completedAt ? new Date(merged.completedAt) : null,
        merged.step || 1,
        merged.completed ? 1 : 0,
        merged.lastSeen  ? new Date(merged.lastSeen) : null,
        JSON.stringify(merged.accessLog   || []),
        JSON.stringify(merged.business    || {}),
        JSON.stringify(merged.contact     || {}),
        JSON.stringify(merged.social      || {}),
        JSON.stringify(merged.google      || {}),
        JSON.stringify(merged.advertising || {}),
        JSON.stringify(merged.domains     || []),
        existing.id
      ]
    );
    const [updated] = await pool.execute('SELECT * FROM clients WHERE id = ?', [existing.id]);
    res.json(rowToClient(updated[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM clients WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Regenerate token
app.post('/api/clients/:id/regenerate-token', requireAuth, async (req, res) => {
  try {
    const newToken = uuidv4();
    const [result] = await pool.execute(
      'UPDATE clients SET token = ?, created_at = ?, completed = 0 WHERE id = ?',
      [newToken, new Date(), req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ token: newToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Client portal: validate PIN + log access ──────────────
app.post('/api/portal/:token/access', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM clients WHERE token = ?', [req.params.token]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const client = rowToClient(rows[0]);
    if (await isTokenExpired(client)) return res.status(410).json({ error: 'expired' });
    const settings = await readSettings();
    if (settings.pinRequired && client.pin && req.body.pin !== client.pin) {
      return res.status(401).json({ error: 'invalid_pin' });
    }
    const accessLog = [...(client.accessLog || []).slice(-19), { at: new Date().toISOString(), ip: req.ip || '' }];
    await pool.execute(
      'UPDATE clients SET last_seen = ?, access_log = ? WHERE id = ?',
      [new Date(), JSON.stringify(accessLog), client.id]
    );
    const { pin: _pin, accessLog: _log, ...safeClient } = { ...client, accessLog };
    res.json(safeClient);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Client portal: submit (mark complete) ────────────────
app.post('/api/portal/:token/submit', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM clients WHERE token = ?', [req.params.token]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const existing = rowToClient(rows[0]);
    const merged = { ...existing, ...req.body };
    const now = new Date();
    await pool.execute(
      `UPDATE clients SET
         updated_at = ?, completed_at = ?, step = 3, completed = 1,
         business = ?, contact = ?, social = ?, google_data = ?, advertising = ?, domains = ?
       WHERE id = ?`,
      [
        now, now,
        JSON.stringify(merged.business    || {}),
        JSON.stringify(merged.contact     || {}),
        JSON.stringify(merged.social      || {}),
        JSON.stringify(merged.google      || {}),
        JSON.stringify(merged.advertising || {}),
        JSON.stringify(merged.domains     || []),
        existing.id
      ]
    );
    // Fire webhook if configured
    const settings = await readSettings();
    if (settings.completionWebhook) {
      try {
        const u = new URL(settings.completionWebhook);
        const payload = JSON.stringify({ event: 'onboarding_complete', clientId: existing.id, business: merged.business?.name, completedAt: now.toISOString() });
        const opts = { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
        const req2 = https.request(opts); req2.write(payload); req2.end();
      } catch (_) {}
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WHOIS ────────────────────────────────────────────────
app.get('/api/whois/:domain', requireAuth, async (req, res) => {
  const result = await rdapLookup(req.params.domain);
  res.json(result);
});

// ── Vault export ─────────────────────────────────────────
app.get('/api/clients/:id/export', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const client = rowToClient(rows[0]);
    const name = client.business?.name || 'Client';
    const vaultExport = {
      encrypted: false,
      items: [
        { type: 2, name: `[Rankon] ${name} — Business Profile`,
          notes: buildNote('BUSINESS PROFILE', { 'Business name': client.business?.name, 'ABN': client.business?.abn, 'Billing email': client.business?.billingEmail, 'Industry': client.business?.industry, 'Addresses': (client.business?.addresses || []).join('\n  '), 'Contact name': client.contact?.name, 'Contact phone': client.contact?.phone, 'Contact email': client.contact?.email, 'Contact role': client.contact?.role }),
          secureNote: { type: 0 } },
        { type: 2, name: `[Rankon] ${name} — Digital Platforms`,
          notes: buildNote('SOCIAL MEDIA', { 'Facebook': client.social?.facebook, 'Instagram': client.social?.instagram, 'TikTok': client.social?.tiktok, 'LinkedIn': client.social?.linkedin })
               + '\n\n' + buildNote('GOOGLE', { 'Business Profile': client.google?.businessProfile, 'GA4 Property': client.google?.analyticsGA4, 'Google Ads CID': client.google?.adsCID, 'Search Console': client.google?.searchConsole })
               + '\n\n' + buildNote('ADVERTISING', { 'Microsoft Ads': client.advertising?.microsoftAds, 'Meta Ads Manager': client.advertising?.metaAds }),
          secureNote: { type: 0 } },
        { type: 2, name: `[Rankon] ${name} — Domains`,
          notes: (client.domains || []).map(d => `Domain: ${d.domain}\nRegistrar: ${d.registrar || '—'}\nExpiry: ${d.expiry || '—'}\nNameservers: ${(d.ns || []).join(', ') || '—'}\nHosting: ${d.hosting || '—'}`).join('\n\n---\n\n') || 'No domains recorded',
          secureNote: { type: 0 } }
      ]
    };
    res.json(vaultExport);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function buildNote(title, fields) {
  return [`=== ${title} ===`, ...Object.entries(fields).map(([k, v]) => `${k}: ${v || '—'}`)].join('\n');
}

// ── Onboarding email template ─────────────────────────────
function buildOnboardingEmail(client, link, settings, baseUrl) {
  const name       = client.contact?.name   || client.business?.name || 'there';
  const bizName    = client.business?.name  || '';
  const agency     = settings.agency?.name  || 'Rankon Digital Marketing';
  const agencyEmail= settings.agency?.email || '';
  const agencyPhone= settings.agency?.phone || '';
  const agencyWeb  = settings.agency?.website || '';
  const expDays    = settings.tokenExpiryDays || 30;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8f7ff;font-family:'Segoe UI',Arial,sans-serif">
<div style="max-width:600px;margin:40px auto 0;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(124,58,237,0.1)">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#0d0d1a 0%,#1e0a4a 100%);padding:36px 40px 28px">
    <div style="background:rgba(255,255,255,0.97);border-radius:10px;padding:8px 16px;display:inline-block;margin-bottom:10px">
      <img src="cid:rankon-logo" alt="${agency}" width="140" style="display:block;height:auto;max-height:50px;object-fit:contain">
    </div>
    <p style="color:rgba(255,255,255,0.5);font-size:13px;margin:0">${agency}</p>
  </div>

  <!-- Body -->
  <div style="padding:40px">
    <h1 style="font-size:22px;font-weight:800;color:#0d0d1a;margin:0 0 10px;letter-spacing:-0.3px">
      Hi ${name}! 👋
    </h1>
    <p style="color:#6b6b9a;font-size:15px;line-height:1.65;margin:0 0 8px">
      ${bizName ? `We're excited to start working with <strong style="color:#0d0d1a">${bizName}</strong>.` : ''}
      To get started, please complete your digital marketing onboarding — it only takes a few minutes.
    </p>
    <p style="color:#6b6b9a;font-size:15px;line-height:1.65;margin:0 0 32px">
      Click the button below to open your personalised onboarding form:
    </p>

    <!-- CTA -->
    <div style="text-align:center;margin:0 0 32px">
      <a href="${link}"
         style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;
                padding:16px 44px;border-radius:30px;font-size:16px;font-weight:700;
                letter-spacing:-0.2px;box-shadow:0 4px 20px rgba(124,58,237,0.35)">
        Complete My Onboarding →
      </a>
    </div>

    <p style="color:#9898c0;font-size:12px;text-align:center;margin:0 0 32px">
      Or copy this link:<br>
      <a href="${link}" style="color:#7C3AED;font-size:12px;word-break:break-all">${link}</a>
    </p>
  </div>

  <!-- What to expect -->
  <div style="margin:0 40px 32px;padding:24px;background:#f5f3ff;border-radius:12px;border:1px solid #ede9fe">
    <p style="font-weight:700;color:#0d0d1a;margin:0 0 12px;font-size:14px">📋 What you'll need to provide:</p>
    <ul style="color:#6b6b9a;font-size:13px;line-height:2.2;margin:0;padding-left:18px">
      <li>Business details &amp; billing email</li>
      <li>Social media accounts (Facebook, Instagram, TikTok, LinkedIn)</li>
      <li>Google platforms (Analytics, Ads, Business Profile, Search Console)</li>
      <li>Domain name(s)</li>
    </ul>
  </div>

  <!-- Footer -->
  <div style="padding:24px 40px 32px;border-top:1.5px solid #ede9fe">
    <p style="color:#9898c0;font-size:12px;margin:0 0 6px;line-height:1.8">
      Questions? Reach us at
      ${agencyEmail ? `<a href="mailto:${agencyEmail}" style="color:#7C3AED">${agencyEmail}</a>` : ''}
      ${agencyPhone ? ` &nbsp;·&nbsp; ${agencyPhone}` : ''}
      ${agencyWeb   ? ` &nbsp;·&nbsp; <a href="${agencyWeb}" style="color:#7C3AED">${agencyWeb}</a>` : ''}
    </p>
    <p style="color:#c4b5fd;font-size:11px;margin:0">
      ⏰ This link expires in <strong>${expDays} days</strong>.
      If you did not expect this email, you can safely ignore it.
    </p>
  </div>
</div>
</body>
</html>`;
}

// ── Send onboarding email ─────────────────────────────────
app.post('/api/clients/:id/send-onboarding', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    const client = rowToClient(rows[0]);

    const contactEmail = client.contact?.email;
    if (!contactEmail) return res.status(400).json({ error: 'no_email', message: 'Client has no contact email — fill in Step 1 first.' });

    const settings = await readSettings();
    const smtp = settings.smtp;
    if (!smtp?.host || !smtp?.user || !smtp?.pass) {
      return res.status(400).json({ error: 'smtp_not_configured', message: 'SMTP is not configured — go to Settings → SMTP Email.' });
    }

    // Build onboarding link from request host
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
    const host  = (req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3077');
    const link  = `${proto}://${host}/onboard/${client.token}`;

    const agencyName = settings.agency?.name || 'Rankon Digital Marketing';
    const subject    = `${agencyName} — Your onboarding link is ready`;
    const baseUrl    = `${proto}://${host}`;
    const html       = buildOnboardingEmail(client, link, settings, baseUrl);

    // Embed logo as CID attachment so it shows in all email clients (incl. Outlook cloud)
    const logoPath = path.join(__dirname, 'public', 'rankon-logo.png');
    const attachments = fs.existsSync(logoPath) ? [{
      filename:    'rankon-logo.png',
      path:        logoPath,
      cid:         'rankon-logo',
      contentType: 'image/png'
    }] : [];

    await sendMail(smtp, { to: contactEmail, subject, html, attachments });

    // Record send timestamp
    await pool.execute('UPDATE clients SET email_sent_at = ? WHERE id = ?', [new Date(), client.id]);

    console.log(`[email] Onboarding link sent to ${contactEmail} for client ${client.id}`);
    res.json({ ok: true, to: contactEmail });
  } catch (e) {
    console.error('[email error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Catch-all: unknown /api/* → always JSON, never HTML ──
app.use('/api', (req, res) => {
  console.warn(`[404] Unmatched route: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'API endpoint not found', path: req.originalUrl, method: req.method });
});

// ── Global error handler: return JSON for API routes ─────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server error]', req.method, req.originalUrl, err.message);
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
  res.status(500).send('Internal server error');
});

// ── Routes for SPA ────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/onboard/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Bootstrap: create DB → tables → listen ───────────────
ensureDatabase()
  .then(initDB)
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Rankon Onboarding → http://localhost:${PORT}`)))
  .catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
