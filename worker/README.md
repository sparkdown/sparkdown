# SparkDown Update Worker

A Cloudflare Worker that proxies SparkDown update checks to GitHub Releases while counting active installs for analytics, without collecting any personally identifiable information.

## What it does

- Serves update manifests at `https://sparkdown.dev/update/{target}/{arch}/{current_version}`
- Proxies requests to `https://github.com/sparkdown/sparkdown/releases/latest/download/latest.json`
- Records one count per request bucketed by UTC day, platform/target, arch, and current app version
- Stores **no** IP address, user agent string, install ID, or any other identifier
- Returns the same update manifest the app would get from GitHub (signatures remain valid)

## Storage

Uses Workers Analytics Engine for counting. This is a purpose-built time-series analytics database with:
- Built-in aggregation by time buckets
- Automatic retention management
- Simple write API (no database to manage)
- Efficient querying via SQL over Cloudflare's API

## Development

Install dependencies:

```bash
npm install
```

Run locally:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

## Deployment

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

### Manual steps after deployment

The following must be configured in the Cloudflare dashboard:

1. **Route**: Add a route for `sparkdown.dev/update/*` pointing to this worker
2. **Analytics Engine**: The `UPDATE_CHECKS` dataset is created automatically on first write
3. **DNS**: Ensure `sparkdown.dev` is proxied through Cloudflare (orange cloud)

## Reading the counts

The team can read update check counts using the included query script:

```bash
# Set your Cloudflare credentials
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_TOKEN="your-api-token"

# Query the last 30 days (default)
node query-counts.ts

# Query a different time range
node query-counts.ts 7   # Last 7 days
node query-counts.ts 90  # Last 90 days
```

### Getting credentials

1. **Account ID**: Found in your Cloudflare dashboard under Account Home
2. **API Token**: Create at https://dash.cloudflare.com/profile/api-tokens
   - Use the "Read Analytics" template, or
   - Create a custom token with `Analytics:Read` permission

The query script is **not** publicly accessible and requires authentication.

## Fallback behavior

The SparkDown app is configured with two update endpoints:
1. Primary: `https://sparkdown.dev/update/{target}/{arch}/{current_version}` (this worker)
2. Fallback: `https://github.com/sparkdown/sparkdown/releases/latest/download/latest.json`

If the worker is down or unreachable, the app falls back to the direct GitHub endpoint, ensuring updates never break.

## Testing

The worker includes tests for:
- Manifest passthrough (signatures stay valid)
- Counting (one per request, bucketed correctly)
- Fallback behavior (worker failure doesn't break updates)
- No PII collection (no IP, user agent, or install ID stored)

Run tests with `npm test`.

## Privacy

This worker records:
- ✅ Platform/target (e.g., `darwin-aarch64`)
- ✅ Architecture (e.g., `aarch64`)
- ✅ Current app version (e.g., `0.4.3`)
- ✅ UTC timestamp (day bucket)

It does **not** record:
- ❌ IP address
- ❌ User agent string
- ❌ Install ID or any identifier
- ❌ Geographic location beyond what Cloudflare edge location implies

The README's "no telemetry" statement remains accurate.
