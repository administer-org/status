# ADM Software – Status Worker

Standalone Cloudflare Worker that serves the ADM Software system-status page at its own domain, runs scheduled health checks against every configured node, and sends Discord webhook alerts when a node goes down, recovers, or on a daily uptime report.

---

## Repository layout

```
src/index.js   – Worker source (status page + scheduled checks + Discord alerts)
wrangler.toml  – Wrangler deployment config (D1 binding, cron trigger)
package.json   – Dev-dependency (wrangler) + npm scripts
```

---

## How to deploy & connect everything

### 1 – Prerequisites

- [Node.js](https://nodejs.org) ≥ 18 installed locally
- A [Cloudflare](https://dash.cloudflare.com) account with Workers and D1 enabled
- `wrangler` authenticated: `npx wrangler login`

Install dev dependencies:

```bash
npm install
```

---

### 2 – Create (or reuse) the D1 database

If you have an **existing** D1 database shared with the gateway worker, copy its ID from the Cloudflare dashboard (*Workers & Pages → D1*) or run:

```bash
npx wrangler d1 list
```

To create a **new** database:

```bash
npx wrangler d1 create adm-status-db
```

Copy the `database_id` printed in the output and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding       = "DB"
database_name = "adm-status-db"
database_id   = "PASTE_YOUR_DATABASE_ID_HERE"
```

> **Sharing the DB with the gateway worker**  
> Add the identical `[[d1_databases]]` block to the gateway worker's `wrangler.toml` so both workers read from and write to the same database.  
> The status worker calls `CREATE TABLE IF NOT EXISTS` on every request and every cron run, so the schema is created automatically – no manual migrations needed.

---

### 3 – Set secrets

These values are never stored in source code; set them with Wrangler:

```bash
# JSON array of nodes to monitor.
# Each entry: { "url": "https://…", "name": "display-name" }
npx wrangler secret put INSTANCES
# Paste when prompted, e.g.:
# [{"url":"https://gateway.admsoftware.org","name":"gateway"}]

# Discord webhook URL for down / recovery / daily-report alerts
npx wrangler secret put ALERT_WEBHOOK
# Paste your Discord webhook URL when prompted
```

---

### 4 – Deploy the status worker

```bash
npm run deploy
```

Wrangler will output a `*.workers.dev` URL. Open it to confirm the status page loads.

---

### 5 – Attach a custom domain

1. In the Cloudflare dashboard go to **Workers & Pages → adm-status → Settings → Triggers**.
2. Under **Custom Domains** click **Add Custom Domain** and enter your domain (e.g. `status.admsoftware.org`).
3. Cloudflare will automatically provision a TLS certificate and route traffic to the worker.

No changes to `wrangler.toml` are needed for custom domains managed in the dashboard.

---

### 6 – Clean up the gateway worker

Now that health checks, DB writes, and Discord alerts live in this worker, remove the equivalent code from the gateway worker to avoid duplicate alerts and double-writes:

- Delete the `ensureTables` call and all `scheduled()` handler logic.
- Delete the `sendEmbed`, `sendDailyReport` helper functions.
- Delete the hardcoded `ALERT_WEBHOOK` constant and the `notificationCooldowns` map.
- Delete the `/status` route from the `fetch()` handler (the `renderStatusPage` call).
- Keep the proxy / failover logic and the `notifyDiscord` call in `fetch()` if you still want per-request Discord alerts from the gateway (optional).

---

### 7 – Verify the cron trigger

The worker is scheduled to run every minute (`* * * * *` in `wrangler.toml`).  
To confirm it fires correctly after deployment:

```bash
npm run tail
```

You should see log lines for each monitored node once per minute.  
You can also trigger it manually from the Cloudflare dashboard: **Workers & Pages → adm-status → Triggers → Cron Triggers → Run**.

---

## Environment variables reference

| Name             | How to set              | Description |
|------------------|-------------------------|-------------|
| `INSTANCES`      | `wrangler secret put`   | JSON array of `{ url, name }` objects – one entry per node to monitor |
| `ALERT_WEBHOOK`  | `wrangler secret put`   | Discord incoming-webhook URL for alerts |
| `DB`             | `wrangler.toml` binding | D1 database binding – set `database_id` in `wrangler.toml` |
