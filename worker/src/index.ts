/**
 * SparkDown Update Check Worker
 * 
 * Proxies update checks to GitHub releases while counting active installs.
 * Records one count per request bucketed by UTC day, platform, arch, and version.
 * Stores no IP address, user agent string, install ID, or any other identifier.
 */

interface Env {
  UPDATE_CHECKS: AnalyticsEngineDataset;
}

interface UpdateManifest {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, {
    signature: string;
    url: string;
    size?: number;
  }>;
}

/**
 * Main handler: count the check and proxy to GitHub releases
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Health check endpoint
    if (url.pathname === '/health' || url.pathname === '/update/health') {
      return new Response('OK', { status: 200 });
    }

    // Parse the update check URL: /update/{target}/{arch}/{current_version}
    const match = url.pathname.match(/^\/update\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!match) {
      return new Response('Not Found', { status: 404 });
    }

    const [, target, arch, currentVersion] = match;

    // Record the check (no IP, no user agent, no install ID)
    try {
      env.UPDATE_CHECKS.writeDataPoint({
        blobs: [target, arch, currentVersion],
        doubles: [1],
        indexes: [target], // For efficient querying by platform
      });
    } catch (error) {
      // Never fail the update check if counting fails
      console.error('Failed to record update check:', error);
    }

    // Fetch the manifest from GitHub
    const githubUrl = 'https://github.com/sparkdown/sparkdown/releases/latest/download/latest.json';
    
    try {
      const response = await fetch(githubUrl, {
        headers: {
          'User-Agent': 'SparkDown-UpdateWorker/1.0',
        },
        // Cache for 5 minutes to reduce GitHub API load
        cf: {
          cacheTtl: 300,
          cacheEverything: true,
        },
      });

      if (!response.ok) {
        // If GitHub is down, return a fallback error that won't break the app
        return new Response(
          JSON.stringify({ error: 'Update check temporarily unavailable' }),
          { 
            status: response.status,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // Parse and validate the manifest
      const manifest: UpdateManifest = await response.json();
      
      // Pass through the manifest unchanged (signatures must remain valid)
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300', // 5 minutes
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      console.error('Failed to fetch update manifest:', error);
      return new Response(
        JSON.stringify({ error: 'Update check failed' }),
        { 
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
