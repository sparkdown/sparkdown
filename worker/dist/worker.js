// src/index.ts
var GITHUB_MANIFEST = "https://github.com/sparkdown/sparkdown/releases/latest/download/latest.json";
var CACHE_TTL_SECS = 300;
function countryOf(request) {
  const country = request.cf?.country;
  if (typeof country === "string" && country.length > 0) {
    return country;
  }
  return "XX";
}
var PATH = /^\/update\/([^/]+)\/([^/]+)\/([^/]+)$/;
var index_default = {
  async fetch(request, env) {
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
        indexes: [target]
      });
    } catch (error) {
      console.error("Failed to record update check:", error);
    }
    try {
      const upstream = await fetch(GITHUB_MANIFEST, {
        headers: { "User-Agent": "SparkDown-UpdateWorker/1.0" },
        cf: { cacheTtl: CACHE_TTL_SECS, cacheEverything: true }
      });
      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: "Update check temporarily unavailable" }), {
          status: upstream.status,
          headers: { "Content-Type": "application/json" }
        });
      }
      const body = await upstream.arrayBuffer();
      const contentType = upstream.headers.get("Content-Type") ?? "application/json";
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": `public, max-age=${CACHE_TTL_SECS}`
        }
      });
    } catch (error) {
      console.error("Failed to fetch update manifest:", error);
      return new Response(JSON.stringify({ error: "Update check failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};
export {
  countryOf,
  index_default as default
};
