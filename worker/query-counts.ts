#!/usr/bin/env node
/**
 * Query SparkDown update check counts from Workers Analytics Engine
 * 
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=your-account-id CLOUDFLARE_API_TOKEN=your-token node query-counts.ts [days]
 * 
 * Requires:
 *   - CLOUDFLARE_ACCOUNT_ID environment variable
 *   - CLOUDFLARE_API_TOKEN with Analytics:Read permission
 * 
 * Optional argument:
 *   - days: number of days to query (default: 30)
 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DAYS = parseInt(process.argv[2] || '30', 10);

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error('Error: Missing required environment variables');
  console.error('Required: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

interface DataPoint {
  blob1: string;  // target (e.g., darwin-aarch64)
  blob2: string;  // arch (e.g., aarch64)
  blob3: string;  // current_version (e.g., 0.4.3)
  double1: number; // count (always 1 per check)
  timestamp: string;
}

interface QueryResponse {
  data: DataPoint[];
  meta: {
    confidence_info?: {
      level?: number;
    };
  };
  rows: number;
  rows_before_limit_at_least?: number;
}

async function queryAnalytics(): Promise<void> {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - DAYS);

  const query = `
    SELECT
      blob1 AS target,
      blob2 AS arch,
      blob3 AS current_version,
      timestamp,
      SUM(double1) AS checks
    FROM UPDATE_CHECKS
    WHERE timestamp >= toDateTime('${startDate.toISOString().split('T')[0]}')
      AND timestamp < toDateTime('${now.toISOString().split('T')[0]}')
    GROUP BY target, arch, current_version, toDate(timestamp) AS day
    ORDER BY day DESC, checks DESC
  `.trim();

  console.log('Querying update checks for the last', DAYS, 'days...\n');

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`,
          'Content-Type': 'text/plain',
        },
        body: query,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText}\n${errorText}`);
    }

    const result: QueryResponse = await response.json();

    if (!result.data || result.data.length === 0) {
      console.log('No update checks recorded in the last', DAYS, 'days.');
      return;
    }

    // Group by date
    const byDate = new Map<string, Map<string, number>>();
    const totals = new Map<string, number>();

    for (const row of result.data) {
      const date = row.timestamp.split('T')[0];
      const key = `${row.blob1} (${row.blob3})`;  // "darwin-aarch64 (0.4.3)"
      const count = row.double1;

      if (!byDate.has(date)) {
        byDate.set(date, new Map());
      }
      const dayMap = byDate.get(date)!;
      dayMap.set(key, (dayMap.get(key) || 0) + count);

      totals.set(key, (totals.get(key) || 0) + count);
    }

    // Print results
    console.log('Update checks by day:\n');
    console.log('Date       | Platform/Version                    | Checks');
    console.log('-----------|-------------------------------------|-------');

    const dates = Array.from(byDate.keys()).sort().reverse();
    for (const date of dates) {
      const dayMap = byDate.get(date)!;
      const entries = Array.from(dayMap.entries()).sort((a, b) => b[1] - a[1]);
      
      for (let i = 0; i < entries.length; i++) {
        const [key, count] = entries[i];
        const dateCol = i === 0 ? date : '          ';
        console.log(`${dateCol} | ${key.padEnd(35)} | ${count.toString().padStart(6)}`);
      }
    }

    console.log('\nTotals over', DAYS, 'days:\n');
    const totalEntries = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
    for (const [key, count] of totalEntries) {
      console.log(`  ${key.padEnd(35)} ${count.toString().padStart(6)} checks`);
    }

    const grandTotal = totalEntries.reduce((sum, [, count]) => sum + count, 0);
    console.log(`\nGrand total: ${grandTotal} update checks`);

  } catch (error) {
    console.error('Error querying analytics:', error);
    process.exit(1);
  }
}

queryAnalytics();
