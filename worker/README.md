# SparkDown update-check worker

A Cloudflare Worker on `sparkdown.dev` that answers SparkDown's update checks
and counts them anonymously.

## What it does

- Serves `https://sparkdown.dev/update/{target}/{arch}/{current_version}`
- Fetches `https://github.com/sparkdown/sparkdown/releases/latest/download/latest.json` and returns that body unchanged, so signatures stay valid
- Records one count per check in Workers Analytics Engine, bucketed by UTC day: platform (`target`), architecture, app version, and country (`request.cf.country`, or `XX` if missing)
- Never reads or stores an IP address, user agent, or any install or user id
- Caches a successful manifest for five minutes

The SparkDown app uses this URL first and falls back to the GitHub
`latest.json` if the worker is unreachable. Users can turn update checks off
in Settings.

## Development

```bash
npm install
npm test
npm run dev
```

## Deploy

The Worker is a single ES module at `dist/worker.js`, built from `src/index.ts`
(`npm run build`). It has no runtime npm dependencies. Account and zone IDs
stay in the environment, never in this repo.

### 1. Upload the script

Rebuild the bundle if you changed the source:

```bash
npm install
npm test
npm run build
```

Then a multipart PUT to
`/accounts/{account_id}/workers/scripts/sparkdown-updater`. The `metadata`
part must be this JSON (also in `metadata.json`):

```json
{
  "main_module": "worker.js",
  "compatibility_date": "2026-11-20",
  "bindings": [
    {
      "type": "analytics_engine",
      "name": "UPDATE_CHECKS",
      "dataset": "UPDATE_CHECKS"
    }
  ]
}
```

The file part's name must be `worker.js` (the `main_module` value), with
type `application/javascript+module`:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/sparkdown-updater" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -F "metadata=@metadata.json;type=application/json" \
  -F "worker.js=@dist/worker.js;type=application/javascript+module"
```

The token needs **Account / Workers Scripts / Write** (also accepted:
Workers Admin or Workers Editor) on the account that will own the script.

### 2. Add the route

After the script is uploaded, create a zone route for `sparkdown.dev/update/*`
pointing at this worker. `sparkdown.dev` must be proxied on Cloudflare
(orange cloud). POST `/zones/{zone_id}/workers/routes` with:

```json
{ "pattern": "sparkdown.dev/update/*", "script": "sparkdown-updater" }
```

The token needs **Zone / Workers Routes / Write** on the `sparkdown.dev`
zone (and usually Zone / Zone / Read to look up the zone id). Do not put
the zone id in this repo.

The Analytics Engine binding and dataset name is `UPDATE_CHECKS`. The
dataset is created on the first write; you do not create it by hand.

`npx wrangler deploy` also works if you have wrangler credentials, but the
API upload above is the supported path when there is no wrangler token.

## Reading the counts

Use a **read-only** token. Do not use the deploy token for this.

1. Account ID: Cloudflare dashboard → Overview, or any account URL.
2. API token: https://dash.cloudflare.com/profile/api-tokens → Create
   Custom Token, permission **Account / Account Analytics / Read** only.
3. From this folder, with the values in the environment (never committed):

   ```bash
   export CLOUDFLARE_ACCOUNT_ID="your-account-id"
   export CLOUDFLARE_API_TOKEN="your-read-token"
   npm run query        # last 30 days
   npm run query -- 7   # last 7 days
   ```

   Equivalent: `node --experimental-strip-types query-counts.ts 30`

The script prints daily totals by platform, version, and country.
