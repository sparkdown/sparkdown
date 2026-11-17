#!/usr/bin/env node
/**
 * Run npm audit with retry logic and selective advisory filtering.
 * Used in CI to handle transient registry errors and temporary allowances.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 15000;
const EXPIRY_DATE = new Date('2026-12-17T00:00:00Z');

// Temporary allow for a dev-only tooling advisory with no fixed release yet. Remove once picomatch ships a fix (expires 2026-12-17).
const ALLOWED_ADVISORIES = ['GHSA-fc5q-39xc-vjpf'];

/**
 * Run npm audit with retries on transient registry errors.
 */
async function runAuditWithRetry(omitDev = false) {
  const args = ['npm', 'audit', '--json'];
  if (omitDev) {
    args.push('--omit=dev');
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { stdout } = await execAsync(args.join(' '), {
        maxBuffer: 10 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    } catch (error) {
      // npm audit exits non-zero when vulnerabilities are found, but stdout contains valid JSON
      if (error.stdout) {
        try {
          return JSON.parse(error.stdout);
        } catch {
          // Not a JSON parse issue, continue to retry logic
        }
      }

      // Check if this is a transient registry error
      const isRegistryError =
        error.code === 'ENOTFOUND' ||
        error.message?.includes('503') ||
        error.message?.includes('registry') ||
        error.message?.includes('ETIMEDOUT') ||
        error.message?.includes('ECONNRESET');

      if (isRegistryError && attempt < MAX_RETRIES) {
        console.error(
          `npm audit failed (attempt ${attempt}/${MAX_RETRIES}): ${error.message}`
        );
        console.error(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }

      throw error;
    }
  }

  throw new Error('npm audit failed after maximum retries');
}

/**
 * Check if an advisory is currently allowed based on our filtering rules.
 */
async function isAdvisoryAllowed(advisoryId, auditData, auditDataOmitDev) {
  if (!ALLOWED_ADVISORIES.includes(advisoryId)) {
    return { allowed: false };
  }

  const now = new Date();
  if (now >= EXPIRY_DATE) {
    return {
      allowed: false,
      reason: `Temporary allowance for ${advisoryId} has expired (${EXPIRY_DATE.toISOString().split('T')[0]}). Please recheck and update the allowance or fix the issue.`,
    };
  }

  // Check if the advisory appears in runtime dependencies
  const runtimeVulns = auditDataOmitDev?.vulnerabilities || {};
  if (Object.keys(runtimeVulns).length > 0) {
    // Check if any runtime vulnerability is related to this advisory
    for (const [pkg, vulnData] of Object.entries(runtimeVulns)) {
      if (vulnData.via) {
        const viaAdvisories = Array.isArray(vulnData.via)
          ? vulnData.via
          : [vulnData.via];
        for (const via of viaAdvisories) {
          if (typeof via === 'object' && via.url?.includes(advisoryId)) {
            return {
              allowed: false,
              reason: `${advisoryId} is now present in runtime dependencies (found in ${pkg}). This advisory was only allowed for dev-only tooling. Please upgrade immediately.`,
            };
          }
        }
      }
    }
  }

  // Check if a fixed version is now available for the vulnerable package itself
  // (not just through upgrading parent packages)
  const vulns = auditData?.vulnerabilities || {};
  for (const [pkg, vulnData] of Object.entries(vulns)) {
    if (vulnData.via) {
      const viaAdvisories = Array.isArray(vulnData.via)
        ? vulnData.via
        : [vulnData.via];
      for (const via of viaAdvisories) {
        if (typeof via === 'object' && via.url?.includes(advisoryId)) {
          // Check if there's a direct fix available for this package
          // (not through parent package upgrades)
          if (
            vulnData.fixAvailable &&
            vulnData.fixAvailable !== true &&
            vulnData.fixAvailable.name === pkg
          ) {
            return {
              allowed: false,
              reason: `A fixed version is now available for ${advisoryId}. Please upgrade ${pkg} to version ${vulnData.fixAvailable.version} or later.`,
            };
          }
        }
      }
    }
  }

  return { allowed: true };
}

/**
 * Extract high and critical advisories from audit data.
 */
function extractHighCriticalAdvisories(auditData) {
  const advisories = new Map();
  const vulns = auditData?.vulnerabilities || {};

  for (const [pkg, vulnData] of Object.entries(vulns)) {
    if (vulnData.severity !== 'high' && vulnData.severity !== 'critical') {
      continue;
    }

    if (vulnData.via) {
      const viaAdvisories = Array.isArray(vulnData.via)
        ? vulnData.via
        : [vulnData.via];
      for (const via of viaAdvisories) {
        if (typeof via === 'object' && via.url) {
          const advisoryId = via.url.split('/').pop();
          if (!advisories.has(advisoryId)) {
            advisories.set(advisoryId, {
              id: advisoryId,
              title: via.title,
              severity: via.severity,
              url: via.url,
              packages: new Set(),
            });
          }
          advisories.get(advisoryId).packages.add(pkg);
        }
      }
    }
  }

  return Array.from(advisories.values());
}

async function main() {
  try {
    console.log('Running npm audit...');
    const auditData = await runAuditWithRetry(false);

    console.log('Running npm audit --omit=dev...');
    const auditDataOmitDev = await runAuditWithRetry(true);

    const advisories = extractHighCriticalAdvisories(auditData);

    if (advisories.length === 0) {
      console.log('✓ No high or critical advisories found');
      process.exit(0);
    }

    const disallowedAdvisories = [];

    for (const advisory of advisories) {
      const { allowed, reason } = await isAdvisoryAllowed(
        advisory.id,
        auditData,
        auditDataOmitDev
      );

      if (!allowed) {
        disallowedAdvisories.push({ ...advisory, reason });
      } else {
        console.log(
          `⚠ Allowing ${advisory.id} (${advisory.severity}): ${advisory.title}`
        );
        console.log(
          `  Affected packages: ${Array.from(advisory.packages).join(', ')}`
        );
      }
    }

    if (disallowedAdvisories.length > 0) {
      console.error('\n✗ Found high or critical advisories:\n');
      for (const advisory of disallowedAdvisories) {
        console.error(`${advisory.id} (${advisory.severity}): ${advisory.title}`);
        console.error(`  URL: ${advisory.url}`);
        console.error(
          `  Affected packages: ${Array.from(advisory.packages).join(', ')}`
        );
        if (advisory.reason) {
          console.error(`  ${advisory.reason}`);
        }
        console.error('');
      }
      process.exit(1);
    }

    console.log('✓ Audit passed (all findings are allowed)');
    process.exit(0);
  } catch (error) {
    console.error('Error running audit:', error.message);
    process.exit(1);
  }
}

main();
