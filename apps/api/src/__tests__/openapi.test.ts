import { describe, it, expect, vi } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Load the committed dump env BEFORE the config module is imported. `override`
// is required: dotenv leaves an already-set process.env var untouched, so a
// value leaked by an earlier-running test file (e.g. a bare `localhost`
// API_DOMAIN) would otherwise survive and make getCurrentApiBaseUrl throw
// `Invalid URL` when the config module is re-imported under the full suite.
loadEnv({
  path: fileURLToPath(new URL('../../scripts/dump_openapi.env', import.meta.url)),
  override: true,
});

describe('buildApp wiring', () => {
  // The raw-body parser is what peer_instance_guard hashes. Every other test of
  // it registers the plugin on its own Fastify instance, so nothing caught a
  // deletion of the single `registerRawBodyCapture(app)` line in app.ts — and
  // the guard silently falls back to re-serializing `request.body`, which is
  // the bug this whole mechanism exists to avoid.
  it('registers the raw-body capture, so peer requests hash the bytes as sent', async () => {
    process.env.API_REFERENCE_ENABLED = 'true';
    vi.resetModules();
    const { buildApp } = await import('../app.js');
    const app = await buildApp();

    // A body with whitespace JSON.stringify would never emit: if `rawBody` is
    // the wire string this survives verbatim; if it were re-serialized it would
    // come back normalised.
    const payload = '{"a":1,   "b":2}';
    app.post('/__rawbody_probe', async (request) => ({
      raw: (request as { rawBody?: string }).rawBody ?? null,
    }));
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/__rawbody_probe',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(res.json().raw).toBe(payload);
    await app.close();
  });
});

describe('OpenAPI spec generation', () => {
  it('builds a spec with real metadata and a non-empty path surface', async () => {
    // Explicit + resetModules so this test's outcome doesn't depend on
    // whichever env value a previous test (or test file) left behind — it
    // always gets a fresh module graph built with API_REFERENCE_ENABLED=true.
    process.env.API_REFERENCE_ENABLED = 'true';
    vi.resetModules();
    const { buildApp } = await import('@/app');
    const app = await buildApp();
    await app.ready();
    const spec = app.swagger() as {
      info: { title: string; version: string };
      servers?: Array<{ url: string }>;
      paths: Record<string, unknown>;
    };
    expect(spec.info.title).toBe('Signals DPG API');
    expect(spec.info.version).not.toBe(''); // sourced from package.json
    expect(spec.servers?.[0]?.url).toBeTruthy();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(40);
    expect(spec.paths['/api/v1/item/fetch']).toBeTruthy();
    await app.close();
  }, 30_000);

  it('registers no docs surface when the reference is disabled', async () => {
    // Config is evaluated once at module import time, so exercising a
    // different env value requires resetModules() BEFORE a fresh dynamic
    // import of the app module.
    process.env.API_REFERENCE_ENABLED = 'false';
    vi.resetModules();
    const { buildApp } = await import('@/app');
    const app = await buildApp();
    await app.ready();
    expect((app as { swagger?: unknown }).swagger).toBeUndefined();
    const res = await app.inject({ method: 'GET', url: '/api/reference' });
    expect(res.statusCode).toBe(404);
    await app.close();
    // Restore so later tests (this file or others sharing the process) see
    // the dump env's intended default again.
    process.env.API_REFERENCE_ENABLED = 'true';
    vi.resetModules();
  }, 30_000);
});
