import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { countryOf, type Env } from "./index";

class MockAnalyticsEngine {
  dataPoints: Array<{
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }> = [];

  writeDataPoint(data: { blobs?: string[]; doubles?: number[]; indexes?: string[] }) {
    this.dataPoints.push(data);
  }
}

const MANIFEST_TEXT = '{"version":"1.0.0","notes":"Test","platforms":{"linux-x86_64":{"signature":"sig123","url":"https://github.com/sparkdown/sparkdown/releases/download/v1.0.0/app.AppImage","size":12345}}}\n';

function manifestResponse(body = MANIFEST_TEXT, status = 200, contentType = "application/json") {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

function request(
  path: string,
  opts: { country?: string; headers?: Record<string, string> } = {},
): Request {
  const req = new Request(`https://sparkdown.dev${path}`, {
    headers: opts.headers,
  });
  if (opts.country !== undefined) {
    (req as Request & { cf?: { country?: string } }).cf = { country: opts.country };
  }
  return req;
}

describe("SparkDown update worker", () => {
  let analytics: MockAnalyticsEngine;
  let env: Env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    analytics = new MockAnalyticsEngine();
    env = { UPDATE_CHECKS: analytics as unknown as AnalyticsEngineDataset };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns 200 for the health check", async () => {
    const response = await worker.fetch(new Request("https://sparkdown.dev/health"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(analytics.dataPoints).toHaveLength(0);
  });

  it("returns 404 for a path that is not an update check", async () => {
    const response = await worker.fetch(new Request("https://sparkdown.dev/invalid"), env);
    expect(response.status).toBe(404);
    expect(analytics.dataPoints).toHaveLength(0);
  });

  it("counts target, arch, version, and country, defaulting country to XX", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(manifestResponse()));

    const withCountry = await worker.fetch(
      request("/update/darwin-aarch64/aarch64/0.4.4", { country: "US" }),
      env,
    );
    expect(withCountry.status).toBe(200);
    expect(analytics.dataPoints).toHaveLength(1);
    expect(analytics.dataPoints[0].blobs).toEqual(["darwin-aarch64", "aarch64", "0.4.4", "US"]);
    expect(analytics.dataPoints[0].doubles).toEqual([1]);

    const withoutCountry = await worker.fetch(
      request("/update/linux-x86_64/x86_64/0.4.4"),
      env,
    );
    expect(withoutCountry.status).toBe(200);
    expect(analytics.dataPoints[1].blobs).toEqual(["linux-x86_64", "x86_64", "0.4.4", "XX"]);
  });

  it("countryOf reads request.cf.country only, and uses XX when it is missing", () => {
    const us = request("/update/linux-x86_64/x86_64/0.4.4", { country: "BR" });
    expect(countryOf(us)).toBe("BR");
    expect(countryOf(new Request("https://sparkdown.dev/update/linux-x86_64/x86_64/0.4.4"))).toBe(
      "XX",
    );
    const empty = request("/update/linux-x86_64/x86_64/0.4.4", { country: "" });
    expect(countryOf(empty)).toBe("XX");
  });

  it("returns the manifest body unchanged, including whitespace", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(manifestResponse()));
    const response = await worker.fetch(
      request("/update/linux-x86_64/x86_64/0.4.0", { country: "DE" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(MANIFEST_TEXT);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("does not write an IP, user agent, or request header into the count", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(manifestResponse()));
    const ip = "203.0.113.50";
    const ua = "SparkDown/0.4.4 secret-agent";
    const response = await worker.fetch(
      request("/update/windows-x86_64/x86_64/0.4.4", {
        country: "GB",
        headers: {
          "User-Agent": ua,
          "CF-Connecting-IP": ip,
          "X-Forwarded-For": ip,
          "CF-IPCountry": "GB",
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(analytics.dataPoints).toHaveLength(1);
    const written = JSON.stringify(analytics.dataPoints[0]);
    expect(written).not.toContain(ip);
    expect(written).not.toContain(ua);
    expect(written).not.toContain("CF-Connecting-IP");
    expect(written).not.toContain("X-Forwarded-For");
    expect(written).not.toContain("User-Agent");
    expect(written).not.toContain("secret-agent");
    expect(analytics.dataPoints[0].blobs).toEqual(["windows-x86_64", "x86_64", "0.4.4", "GB"]);
    expect(Object.keys(analytics.dataPoints[0]).sort()).toEqual(["blobs", "doubles", "indexes"].sort());
  });

  it("still counts when the GitHub manifest cannot be fetched, and returns that failure to the app", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const response = await worker.fetch(
      request("/update/darwin-aarch64/aarch64/0.4.4", { country: "US" }),
      env,
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: "Update check temporarily unavailable" });
    expect(analytics.dataPoints).toHaveLength(1);
    expect(analytics.dataPoints[0].blobs).toEqual(["darwin-aarch64", "aarch64", "0.4.4", "US"]);
  });

  it("returns the manifest when counting throws", async () => {
    env.UPDATE_CHECKS.writeDataPoint = () => {
      throw new Error("Analytics failure");
    };
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(manifestResponse()));
    const response = await worker.fetch(
      request("/update/darwin-aarch64/aarch64/0.4.3", { country: "JP" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(MANIFEST_TEXT);
  });
});
