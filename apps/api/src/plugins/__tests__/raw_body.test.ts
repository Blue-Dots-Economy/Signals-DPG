/**
 * The raw-body parser replaces Fastify's built-in JSON parser, so it owns every
 * JSON request in the API — not just the peer routes that read `rawBody`. These
 * cases pin the parse behaviour it is therefore responsible for, alongside the
 * capture itself.
 */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerRawBodyCapture } from '../raw_body';

/** Echoes what the parser produced, so each case can assert on both halves. */
async function buildApp() {
  const app = Fastify();
  registerRawBodyCapture(app);
  app.post('/echo', async (request) => ({
    body: request.body ?? null,
    rawBody: (request as { rawBody?: string }).rawBody ?? null,
  }));
  await app.ready();
  return app;
}

describe('registerRawBodyCapture', () => {
  it('captures the exact bytes alongside the parsed body', async () => {
    const app = await buildApp();
    // Deliberately odd spacing: the captured string must be the wire bytes, not
    // a re-serialization, or an HMAC over it cannot match the sender's.
    const payload = '{"a":1,  "b":"two"}';

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(res.json()).toEqual({ body: { a: 1, b: 'two' }, rawBody: payload });
    await app.close();
  });

  it('preserves key order in the captured bytes', async () => {
    const app = await buildApp();
    // JSON.stringify(parsed) would reorder nothing here, but the point is that
    // rawBody is never derived from the parsed object at all.
    const payload = '{"z":1,"a":2}';

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(res.json().rawBody).toBe(payload);
    await app.close();
  });

  it('matches a content-type carrying a charset parameter', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: '{"ok":true}',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({ ok: true });
    await app.close();
  });

  it('400s on malformed JSON rather than surfacing a 500', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{bad json',
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('parses an empty body to undefined and still records the empty string', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    // Left for the route schema to reject; every POST/PUT/PATCH here declares one.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: null, rawBody: '' });
    await app.close();
  });
});
