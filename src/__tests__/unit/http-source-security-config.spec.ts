import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ContractsSourceError} from '../../helpers';
import {HttpSchemaSource} from '../../sources/http-source';
import type {LoopbackConfigJson} from '../../types';

// Same dns mock pattern as the SSRF spec — every test here exercises the
// post-host code path, so `dns.lookup` must resolve non-literal hostnames
// to a benign public IP unless the test overrides per-call.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

/**
 * Minimal `LoopbackConfigJson` factory — every field the engine reads on
 * the cold-path is filled with a benign default so individual tests can
 * focus on the `security.http.*` slice they care about.
 */
function makeConfig(
  http?: NonNullable<NonNullable<LoopbackConfigJson['security']>['http']>,
): LoopbackConfigJson {
  const base: LoopbackConfigJson = {
    name: 'http-source-security-config-test',
    schemasDir: './schemas',
    configsDir: './configs',
    validator: 'ajv',
    schemas: [],
    emit: {},
  };
  return http ? {...base, security: {http}} : base;
}

/**
 * Build a `Response` whose body is a `ReadableStream` that emits one or more
 * chunks. Mirrors the helper in `http-source-body-cap.spec.ts` — kept local
 * to avoid coupling test files.
 */
function streamingResponse(
  chunks: ReadonlyArray<Uint8Array>,
  init?: ResponseInit,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, init);
}

function filler(n: number): Uint8Array {
  return new Uint8Array(n);
}

describe('HttpSchemaSource security.http.* config wiring', () => {
  const originalEnv = {
    max: process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'],
    allow: process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'],
    timeout: process.env['LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS'],
  };
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let projectRoot: string;

  beforeEach(() => {
    delete process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'];
    delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    delete process.env['LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS'];
    projectRoot = mkdtempSync(join(tmpdir(), 'lb4-contracts-sec-cfg-'));
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{address: '93.184.216.34', family: 4}]);
  });

  afterEach(() => {
    for (const [k, v] of [
      ['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES', originalEnv.max],
      ['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS', originalEnv.allow],
      ['LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS', originalEnv.timeout],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = originalFetch;
    rmSync(projectRoot, {recursive: true, force: true});
  });

  it('security.http.maxBodyBytes beats LOOPBACK_CONTRACTS_HTTP_MAX_BYTES (config wins precedence)', async () => {
    // Env says "10 MB allowed", config tightens to 256 bytes. A 1 KB body
    // would slip past the env-only path but the config tier must override.
    process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'] = String(10 * 1024 * 1024);
    fetchSpy.mockResolvedValueOnce(
      streamingResponse([filler(1024)], {
        status: 200,
        headers: {'content-length': '1024'},
      }),
    );
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({maxBodyBytes: 256}),
    );
    const err = await src.fetch('https://cdn.example.com/big.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(/exceeds max bytes/);
    expect((err as Error).message).toMatch(/cap 256/);
  });

  it('security.http.allowedHosts rejects a hostname not in the allowlist', async () => {
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({allowedHosts: ['schemas.example.com']}),
    );
    const err = await src.fetch('https://schemas.other.com/widget.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(
      /schemas\.other\.com not in security\.http\.allowedHosts/,
    );
    expect((err as Error).message).toMatch(/schemas\.example\.com/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('security.http.allowedHosts admits a hostname in the allowlist (case-insensitive)', async () => {
    // Allowlist entry uses mixed case; URL host is lowercase per URL spec.
    // Match must be case-insensitive — otherwise operators carry foot-guns.
    const payload = '{"$id":"ok"}';
    const enc = new TextEncoder().encode(payload);
    fetchSpy.mockResolvedValueOnce(
      new Response(enc, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(enc.byteLength),
        },
      }),
    );
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({allowedHosts: ['Schemas.Example.Com']}),
    );
    const out = await src.fetch('https://schemas.example.com/widget.json');
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe(payload);
  });

  it('security.http.allowRedirects=false refuses a 302 before the next hop fires', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === 'https://cdn.example.com/widget.json') {
        return new Response(null, {
          status: 302,
          headers: {location: 'https://mirror.example.com/widget.json'},
        });
      }
      throw new Error(`unexpected second fetch to ${url}`);
    });
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({allowRedirects: false}),
    );
    const err = await src.fetch('https://cdn.example.com/widget.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(
      /security\.http\.allowRedirects = false/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('security.http.maxRedirects=1 caps the redirect chain below the built-in default of 10', async () => {
    // Chain: hop0 → hop1 → hop2. With maxRedirects=1, the second hop is
    // permitted but the third triggers the cap. The hard-coded former
    // limit of 10 would have allowed both hops, so this test pins the
    // config tier as the load-bearing limit.
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === 'https://hop0.example.com/x.json') {
        return new Response(null, {
          status: 302,
          headers: {location: 'https://hop1.example.com/x.json'},
        });
      }
      if (url === 'https://hop1.example.com/x.json') {
        return new Response(null, {
          status: 302,
          headers: {location: 'https://hop2.example.com/x.json'},
        });
      }
      throw new Error(`unexpected third hop to ${url}`);
    });
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({maxRedirects: 1}),
    );
    const err = await src.fetch('https://hop0.example.com/x.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(/exceeded cap \(1 hops\)/);
  });

  it('security.http.allowPrivateHosts=true (config) bypasses the private-host gate without setting the env var', async () => {
    // Env var stays unset; the config tier alone must lift the gate.
    fetchSpy.mockResolvedValueOnce(
      new Response('{"$id":"x"}', {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({allowPrivateHosts: true}),
    );
    const out = await src.fetch('https://10.0.0.1/schema.json');
    expect(out).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('security.http.verifyResolvedIps=false skips the DNS-rebinding preflight (and the lookup is never consulted for blocking)', async () => {
    // The hostname here resolves to a private IP. With the default verifier
    // ON, this would throw before any fetch fires (see http-source-body-cap
    // DNS-rebinding spec). With verifyResolvedIps=false the preflight is
    // disabled and the request lands.
    lookupMock.mockResolvedValue([{address: '169.254.169.254', family: 4}]);
    fetchSpy.mockResolvedValueOnce(
      new Response('{"$id":"y"}', {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({verifyResolvedIps: false}),
    );
    const out = await src.fetch('https://example.com/y.json');
    expect(out).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('host:port allowlist entry matches host+port exactly', async () => {
    // Allowlist entry includes a port; URL must match host AND port.
    const payload = '{"$id":"p"}';
    const enc = new TextEncoder().encode(payload);
    fetchSpy.mockResolvedValueOnce(
      new Response(enc, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(enc.byteLength),
        },
      }),
    );
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({allowedHosts: ['cdn.example.com:8443']}),
    );
    const out = await src.fetch('https://cdn.example.com:8443/p.json');
    expect(out).toHaveLength(1);

    // Same host without the matching port must be rejected.
    const src2 = new HttpSchemaSource(
      projectRoot,
      makeConfig({allowedHosts: ['cdn.example.com:8443']}),
    );
    const err = await src2.fetch('https://cdn.example.com/p.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(
      /not in security\.http\.allowedHosts/,
    );
  });
});
