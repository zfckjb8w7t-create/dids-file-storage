# Dids File Storage &lt;3

A secure file host on **Cloudflare Workers + R2 + D1**. Keyed access with per‑device
locking, chunked uploads up to **250 GB** per file, folders with Everyone/Staff‑only
permissions, public & private downloads, a removal‑request (tickets) flow, and a full
admin console with an audit log.

Built as a single Worker that serves the static pages **and** the API, stores file
bytes in **R2** and metadata in **D1**.

---

## Can I host a 10 TB storage site on Cloudflare?

**Yes — with files stored in R2 (not on the CDN).** That's exactly what this project does.

- **R2 is object storage with free egress.** 10 TB of storage is a supported, intended
  use. Downloads are served from R2, so you are **not** relying on the CDN cache (the old
  "don't serve big files on the proxy" rule, former ToS §2.8, was retired — see Cloudflare's
  ["Goodbye section 2.8"](https://blog.cloudflare.com/updated-tos/) post. Serving your own
  files from R2 is fine.)
- **Per‑file limit:** R2 objects can be up to ~4.995 TiB via multipart (max 10,000 parts).
  This app chunks uploads at 95 MB → ~2,700 parts for a 250 GB file, well under the limit.
- **Worker request‑body limit is 100 MB**, which is why uploads are **chunked** — each part
  is a separate ≤95 MB request, so large files upload reliably on any plan.

### What 10 TB costs (R2 pricing, as of 2026‑10)

| Item | Price | 10 TB / month |
|---|---|---|
| Standard storage | $0.015 / GB‑month | **~$150 / mo** (10,000 GB) |
| Egress (downloads) | **Free** | $0 |
| Class A ops (uploads, lists) | $4.50 / million | cents |
| Class B ops (downloads, reads) | $0.36 / million | cents |
| Free tier | 10 GB storage, 1M Class A, 10M Class B | — |

So storage dominates: **roughly $150/month for 10 TB**, plus a few dollars of operations.
([R2 pricing](https://developers.cloudflare.com/r2/pricing/) · [R2 limits](https://developers.cloudflare.com/r2/platform/limits/))

### Which plans you need
- **R2**: pay‑as‑you‑go (add a payment method). 10 TB is billed usage (~$150/mo); the first
  10 GB is free.
- **Workers**: the **Free** plan technically runs this (100k requests/day, 100 MB body), but
  for real traffic and big uploads use **Workers Paid ($5/mo)** — it lifts the daily request
  cap and raises CPU limits. ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/))
- A custom domain is optional; `*.workers.dev` works out of the box.

> **Heads‑up on very large single downloads:** browsers downloading a 250 GB file in one go
> is fragile on the user's side (network drops). The app supports HTTP range requests, so
> download managers can resume. For routine huge files, a download manager is recommended.

---

## Features

- **Home** — matrix rain (green/blue/purple) + a self‑typing, glowing `Dids File Storage <3` title, and the key‑entry box.
- **Keyed roles** — one key → one role: **admin**, **staff** (private), or **public**.
- **Per‑device lock** — each key binds to one device + IP on first use. Re‑use elsewhere shows *"Contact admin to resolve issue."* Time, date and location are logged.
- **Admin console** — tickets queue, every upload with uploader info (device/IP/location/when), force‑remove any file, and full key management: **generate / revoke / restore / reset‑device**. Plus a complete **activity log**.
- **Private page** — Upload section (up to 250 GB, Everyone or Staff‑only), Private Downloads (all files), Request Removal (link + reason + Discord → lands in admin tickets).
- **Public page** — Public Downloads of everything shared with **Everyone**. No key required.
- **Folders** — created from admin or the upload page, each with Everyone/Staff‑only permission.

### How access maps out
| You enter… | You land on… | You can… |
|---|---|---|
| **Admin key** | `/admin` | everything: tickets, all uploads, keys, folders, activity, force‑delete |
| **Staff key** | `/private` | upload, see all downloads, request removals, make folders |
| **Public key** *(or just the link)* | `/public` | download Everyone files |

---

## Deploy (step by step)

### Prerequisites
- A Cloudflare account.
- Node.js 18+ and the Wrangler CLI: `npm install -g wrangler` (or `npx wrangler …`).
- `wrangler login`.

### 1. Install
```bash
cd dids-file-storage
npm install          # dev tooling (wrangler), if you use it locally
```

### 2. Create the R2 bucket
```bash
wrangler r2 bucket create dids-file-storage
```

### 3. Create the D1 database and load the schema
```bash
wrangler d1 create dids-file-storage
# Copy the printed database_id into wrangler.toml (replace PASTE_YOUR_D1_DATABASE_ID_HERE)
wrangler d1 execute dids-file-storage --remote --file=./schema.sql
```

### 4. Set your secrets
```bash
wrangler secret put ADMIN_KEY        # your master admin key — used on the home page to reach /admin
wrangler secret put SESSION_SECRET   # any long random string (e.g. `openssl rand -hex 32`)
```

### 5. Deploy
```bash
wrangler deploy
```
Wrangler prints your URL (e.g. `https://dids-file-storage.<you>.workers.dev`).

### 6. First run
1. Open the site, enter your **ADMIN_KEY** → you're in the admin console.
2. Go to **Auth Keys → + Generate key** to create staff and public keys. Copy each key at
   creation — it's hashed in storage and shown only once.
3. Hand staff their keys. First use binds the key to their device/IP. If someone changes
   device (or is locked out), use **Reset device** on that key.

---

## Configuration

Set in `wrangler.toml` under `[vars]` (or as secrets):

| Var | Default | Meaning |
|---|---|---|
| `LOCK_MODE` | `hwid` | `hwid` locks per device token (practical). `hwid+ip` also requires the same IP (stricter, but can lock out users on changing IPs). |
| `PART_SIZE` | `99614720` (95 MB) | Upload chunk size in bytes. Min 5 MiB (R2 rule). |
| `ADMIN_KEY` | *(secret)* | Master admin key. |
| `SESSION_SECRET` | *(secret)* | Signs login cookies. |

`MAX_FILE` (250 GB) is set in `src/worker.js`.

---

## Local testing (no Cloudflare needed)

Wrangler can run it locally with real local R2/D1 emulation:
```bash
npm run db:local        # load schema into local D1
wrangler dev            # http://localhost:8787
```

This repo also ships a **dependency‑free harness** that runs the *real* Worker against a
filesystem‑backed R2 and a `node:sqlite`‑backed D1 — used to verify the build:
```bash
ADMIN_KEY=dids_admin_master_test PART_SIZE=5242880 npm run harness   # http://localhost:8788
```
`test/upload-check.py` verifies multipart upload + ranged download integrity; `test/e2e.mjs`
drives the whole UI in Chromium and screenshots every page (see `screenshots/`).

---

## Security notes

- **Keys are stored hashed** (SHA‑256); only a short prefix is kept for display. A key's
  plaintext is shown once at creation.
- **"1 per HWID" caveat:** web pages **cannot** read a true hardware ID — the OS forbids it.
  This app approximates it with a persistent per‑browser device token (localStorage) + a
  browser fingerprint + IP. That reliably stops casual key sharing, but a determined user on
  a fresh browser profile gets a new token; the admin activity log + IP/location are there so
  you can spot and revoke abuse. For hard device binding you'd need a native app.
- Sessions are HMAC‑signed cookies (12 h), `HttpOnly` + `Secure` + `SameSite=Strict`.
- Staff‑only files require a valid staff/admin session to download; Everyone files are public.

## Project layout
```
src/worker.js        the Worker: routing, API, chunked uploads, downloads
src/lib/             util, D1 helper, auth (keys/sessions/device-lock)
public/              home, public, private, admin pages + assets (matrix, upload, admin JS)
schema.sql           D1 tables
wrangler.toml        Cloudflare config (Worker + R2 + D1 + static assets)
harness/, test/      local test harness, integrity test, browser e2e
screenshots/         e2e screenshots of every page
```
