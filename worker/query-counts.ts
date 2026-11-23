#!/usr/bin/env node
/**
 * Print daily SparkDown update-check counts from Workers Analytics Engine.
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node --experimental-strip-types query-counts.ts [days]
 *
 * Or from this folder: npm run query -- [days]
 *
 * The token must be read-only: Account / Account Analytics / Read.
 * Account id and token come from the environment only; this file has none.
 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DAYS = parseInt(process.argv[2] || "30", 10);

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN.");
  console.error("Create a token with Account > Account Analytics > Read only.");
  process.exit(1);
}

if (!Number.isFinite(DAYS) || DAYS <= 0) {
  console.error("Days must be a positive number.");
  process.exit(1);
}

interface QueryRow {
  day: string;
  target: string;
  arch: string;
  current_version: string;
  country: string;
  checks: number;
}

interface QueryResponse {
  data: QueryRow[];
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Midnight UTC of `d` as 'YYYY-MM-DD HH:MM:SS', the form toDateTime() takes. */
function utcMidnight(d: Date): string {
  return `${utcDate(d)} 00:00:00`;
}

async function queryAnalytics(): Promise<void> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - DAYS);

  // Group by the select aliases: the Analytics Engine SQL API rejects a
  // GROUP BY on the raw columns once they are aliased. toDateTime() needs
  // 'YYYY-MM-DD HH:MM:SS'. Multiply by _sample_interval so a sampled dataset
  // still sums to the number of checks.
  const query = `
    SELECT
      toDate(timestamp) AS day,
      blob1 AS target,
      blob2 AS arch,
      blob3 AS current_version,
      blob4 AS country,
      SUM(_sample_interval * double1) AS checks
    FROM UPDATE_CHECKS
    WHERE timestamp >= toDateTime('${utcMidnight(start)}')
      AND timestamp < toDateTime('${utcMidnight(now)}') + INTERVAL '1' DAY
    GROUP BY day, target, arch, current_version, country
    ORDER BY day DESC, checks DESC
  `.trim();

  console.log("Update checks for the last", DAYS, "days...\n");

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: query,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const result = (await response.json()) as QueryResponse;
  const rows = result.data ?? [];
  if (rows.length === 0) {
    console.log("No update checks recorded in the last", DAYS, "days.");
    return;
  }

  const byDate = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();

  for (const row of rows) {
    const date = String(row.day);
    const key = `${row.target} (${row.current_version}, ${row.country})`;
    const count = Number(row.checks);
    if (!byDate.has(date)) {
      byDate.set(date, new Map());
    }
    const dayMap = byDate.get(date)!;
    dayMap.set(key, (dayMap.get(key) || 0) + count);
    totals.set(key, (totals.get(key) || 0) + count);
  }

  console.log("Date       | Platform/Version/Country                | Checks");
  console.log("-----------|-----------------------------------------|-------");

  const dates = Array.from(byDate.keys()).sort().reverse();
  for (const date of dates) {
    const entries = Array.from(byDate.get(date)!.entries()).sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < entries.length; i++) {
      const [key, count] = entries[i];
      const dateCol = i === 0 ? date : "          ";
      console.log(`${dateCol} | ${key.padEnd(39)} | ${count.toString().padStart(6)}`);
    }
  }

  console.log("\nTotals over", DAYS, "days:\n");
  const totalEntries = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
  for (const [key, count] of totalEntries) {
    console.log(`  ${key.padEnd(39)} ${count.toString().padStart(6)} checks`);
  }
  const grandTotal = totalEntries.reduce((sum, [, count]) => sum + count, 0);
  console.log(`\nGrand total: ${grandTotal} update checks`);
}

queryAnalytics().catch((error) => {
  console.error("Error querying analytics:", error);
  process.exit(1);
});
