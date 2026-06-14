# Rankon Client Onboarding

Internal client onboarding CRM for Rankon Digital Marketing Agency.

## Setup

```bash
npm install
npm start
```

Server runs on **http://localhost:3077**

## Features

- Two-step onboarding wizard (Business Profile → Digital Assets)
- Multiple business addresses
- Social media: Facebook, Instagram, TikTok, LinkedIn
- Google stack: Business Profile, GA4, Google Ads, Search Console
- Advertising: Microsoft Ads, Meta Ads Manager
- Domain management with automatic WHOIS/RDAP lookup (nameservers, registrar, expiry, hosting detection)
- Auto-save as you type
- Admin dashboard with search and status tracking
- Shareable token-based onboarding links (send to client to self-fill)
- Vaultwarden/Bitwarden-compatible JSON export
- Plain text vault note export (paste directly into secure note)
- Per-client JSON file download

## Data storage

Client data is stored in `db/clients.json` (plain JSON). For production, replace with SQLite or PostgreSQL.

## Vaultwarden integration

On Step 3, use:
- **Copy JSON** → paste into Vaultwarden import (Bitwarden format)
- **Copy vault note text** → paste into a new secure note manually
- **Download JSON** → store the file as a backup

### Recommended Vaultwarden structure per client:
Create a **Collection** named after the client, then add 3 secure notes:
1. `[Rankon] Client Name — Business Profile`
2. `[Rankon] Client Name — Digital Platforms`
3. `[Rankon] Client Name — Domains`

## Shareable links

Each client gets a unique token URL:
```
http://localhost:3077/onboard/{token}
```
Send this to the client — they can fill in their own digital asset details. Data auto-saves to the same record.

## Port

Change port via environment variable:
```bash
PORT=8080 npm start
```

## Production recommendations

1. Add basic auth middleware (or nginx basic auth) for internal-only access
2. Replace `db/clients.json` with SQLite (`better-sqlite3` once native bindings are available) or PostgreSQL
3. Add HTTPS via Let's Encrypt / nginx reverse proxy
4. Set up PM2 for process management: `pm2 start server.js --name rankon-onboarding`
