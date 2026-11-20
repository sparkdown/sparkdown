import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from './index';

// Mock AnalyticsEngineDataset
class MockAnalyticsEngine {
  public dataPoints: any[] = [];
  
  writeDataPoint(data: any) {
    this.dataPoints.push(data);
  }
}

describe('SparkDown Update Worker', () => {
  let mockEnv: any;
  let mockAnalytics: MockAnalyticsEngine;

  beforeEach(() => {
    mockAnalytics = new MockAnalyticsEngine();
    mockEnv = {
      UPDATE_CHECKS: mockAnalytics,
    };
  });

  it('should return 200 for health check', async () => {
    const request = new Request('https://sparkdown.dev/health');
    const response = await worker.fetch(request, mockEnv, {} as any);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
  });

  it('should return 404 for invalid paths', async () => {
    const request = new Request('https://sparkdown.dev/invalid');
    const response = await worker.fetch(request, mockEnv, {} as any);
    expect(response.status).toBe(404);
  });

  it('should parse update check URL correctly', async () => {
    // Mock fetch to avoid hitting GitHub
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        version: '1.0.0',
        platforms: {
          'darwin-aarch64': {
            signature: 'test-sig',
            url: 'https://github.com/sparkdown/sparkdown/releases/download/v1.0.0/app.tar.gz',
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const request = new Request('https://sparkdown.dev/update/darwin-aarch64/aarch64/0.4.3');
    const response = await worker.fetch(request, mockEnv, {} as any);

    expect(response.status).toBe(200);
    expect(mockAnalytics.dataPoints).toHaveLength(1);
    expect(mockAnalytics.dataPoints[0].blobs).toEqual(['darwin-aarch64', 'aarch64', '0.4.3']);
    expect(mockAnalytics.dataPoints[0].doubles).toEqual([1]);

    global.fetch = originalFetch;
  });

  it('should proxy manifest unchanged', async () => {
    const testManifest = {
      version: '1.0.0',
      notes: 'Test release',
      platforms: {
        'linux-x86_64': {
          signature: 'sig123',
          url: 'https://example.com/app.AppImage',
          size: 12345,
        },
      },
    };

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(testManifest), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const request = new Request('https://sparkdown.dev/update/linux-x86_64/x86_64/0.4.0');
    const response = await worker.fetch(request, mockEnv, {} as any);

    expect(response.status).toBe(200);
    const returnedManifest = await response.json();
    expect(returnedManifest).toEqual(testManifest);

    global.fetch = originalFetch;
  });

  it('should handle GitHub fetch failures gracefully', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404 })
    );

    const request = new Request('https://sparkdown.dev/update/darwin-aarch64/aarch64/0.4.3');
    const response = await worker.fetch(request, mockEnv, {} as any);

    // Should return error but not crash
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty('error');

    // Should still have recorded the check attempt
    expect(mockAnalytics.dataPoints).toHaveLength(1);

    global.fetch = originalFetch;
  });

  it('should continue even if analytics recording fails', async () => {
    // Make analytics throw
    mockEnv.UPDATE_CHECKS.writeDataPoint = vi.fn().mockImplementation(() => {
      throw new Error('Analytics failure');
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: '1.0.0', platforms: {} }), {
        status: 200,
      })
    );

    const request = new Request('https://sparkdown.dev/update/darwin-aarch64/aarch64/0.4.3');
    const response = await worker.fetch(request, mockEnv, {} as any);

    // Should still succeed despite analytics failure
    expect(response.status).toBe(200);

    global.fetch = originalFetch;
  });
});
