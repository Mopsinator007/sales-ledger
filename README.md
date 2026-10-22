# Sales Ledger (single Cloudflare Worker, no CLI needed)

Gold dashboard for Affiliatly earnings (1d/7d/30d/90d/365d) plus Pushover alerts for every new sale.
One Worker serves the page, hides your API hash, and runs a cron every minute.

## Setup (all in the Cloudflare dashboard)
1. Cloudflare > Storage & Databases > KV > Create namespace "sales-ledger-state". Copy its ID into `wrangler.toml` (replace PASTE_KV_NAMESPACE_ID), commit to GitHub.
2. Workers & Pages > Create > Import a repository (GitHub) > pick this repo. Leave build command empty, deploy command `npx wrangler deploy`.
3. Open the Worker > Settings > Variables and Secrets > add these as *Secret*:
   - AFF_HASH (your Affiliatly hash)
   - PUSHOVER_TOKEN (app token from pushover.net/apps/build)
   - PUSHOVER_USER (your Pushover user key)
   - DASH_KEY (a password you choose; the dashboard asks for it once)
4. Open `https://sales-ledger.<your-subdomain>.workers.dev` and enter DASH_KEY.
5. Test Pushover: `.../test?key=YOUR_DASH_KEY`

Never put the hash or Pushover keys in the repo.
