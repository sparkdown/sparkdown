/**
 * Update-check worker for sparkdown.dev.
 *
 * Serves /update/{target}/{arch}/{current_version}, records one anonymous
 * count, and returns the GitHub latest.json body unchanged so signatures
 * stay valid. Counts are bucketed by UTC day in Workers Analytics Engine.
 * The written data is only target, arch, version, and country (from
 * request.cf.country, or "XX" if missing). IP addresses, user agents,
 * and any kind of install or user id are never read for counting and
 * never stored.
 */

const GITHUB_MANIFEST =
  "https://github.com/sparkdown/sparkdown/releases/latest/download/latest.json";

/** Short browser/CDN cache for a successful manifest, in seconds. */
const CACHE_TTL_SECS = 300;

export interface Env {
  UPDATE_CHECKS: AnalyticsEngineDataset;
}

type RequestCf = Request & { cf?: { country?: string } };

/** Country code from the Cloudflare request metadata, or XX if missing. */
export function countryOf(request: Request): string {
  const country = (request as RequestCf).cf?.country;
  if (typeof country === "string" && country.length > 0) {
    return country;
  }
  return "XX";
}

const PATH = /^\/update\/([^/]+)\/([^/]+)\/([^/]+)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/update/health") {
      return new Response("OK", { status: 200 });
    }

    const match = url.pathname.match(PATH);
    if (!match) {
      return new Response("Not Found", { status: 404 });
    }

    const [, target, arch, currentVersion] = match;
    const country = countryOf(request);

    try {
      env.UPDATE_CHECKS.writeDataPoint({
        blobs: [target, arch, currentVersion, country],
        doubles: [1],
        indexes: [target],
      });
    } catch (error) {
      // Counting must never block the manifest.
      console.error("Failed to record update check:", error);
    }

    try {
      const upstream = await fetch(GITHUB_MANIFEST, {
        headers: { "User-Agent": "SparkDown-UpdateWorker/1.0" },
        cf: { cacheTtl: CACHE_TTL_SECS, cacheEverything: true },
      } as RequestInit);

      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: "Update check temporarily unavailable" }), {
          status: upstream.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Return the body as received. Do not parse and re-serialize: the
      // app verifies signatures against this exact manifest text.
      const body = await upstream.arrayBuffer();
      const contentType = upstream.headers.get("Content-Type") ?? "application/json";
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": `public, max-age=${CACHE_TTL_SECS}`,
        },
      });
    } catch (error) {
      console.error("Failed to fetch update manifest:", error);
      return new Response(JSON.stringify({ error: "Update check failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
