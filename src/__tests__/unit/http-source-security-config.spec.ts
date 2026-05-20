import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MockAgent, type Interceptable} from 'undici';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ContractsSourceError} from '../../helpers';
import {HttpSchemaSource} from '../../sources/http-source';
import type {LoopbackConfigJson} from '../../types';

// Same dns mock pattern as the SSRF spec — every test here exercises the
// post-host code path, so `dns.lookup` must resolve non-literal hostnames
// to a benign public IP unless the test overrides per-call. The connect-time
// DNS pin is bypassed by injecting a MockAgent; only the preflight tier
// consults this mock.
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

function filler(n: number): Buffer {
  return Buffer.alloc(n);
}

describe('HttpSchemaSource security.http.* config wiring', () => {
  const originalEnv = {
    max: process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'],
    allow: process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'],
    timeout: process.env['LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS'],
  };
  let mockAgent: MockAgent;
  let projectRoot: string;
  let mockCalls: string[];

  beforeEach(() => {
    delete process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'];
    delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    delete process.env['LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS'];
    projectRoot = mkdtempSync(join(tmpdir(), 'lb4-contracts-sec-cfg-'));
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockCalls = [];
    const originalDispatch = mockAgent.dispatch.bind(mockAgent);
    mockAgent.dispatch = (opts, handler) => {
      const origin =
        typeof opts.origin === 'string'
          ? opts.origin
          : (opts.origin?.toString() ?? '');
      mockCalls.push(`${origin}${opts.path ?? ''}`);
      return originalDispatch(opts, handler);
    };
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{address: '93.184.216.34', family: 4}]);
  });

  afterEach(async () => {
    for (const [k, v] of [
      ['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES', originalEnv.max],
      ['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS', originalEnv.allow],
      ['LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS', originalEnv.timeout],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await mockAgent.close();
    rmSync(projectRoot, {recursive: true, force: true});
  });

  it('security.http.maxBodyBytes beats LOOPBACK_CONTRACTS_HTTP_MAX_BYTES (config wins precedence)', async () => {
    // Env says "10 MB allowed", config tightens to 256 bytes. A 1 KB body
    // would slip past the env-only path but the config tier must override.
    process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'] = String(10 * 1024 * 1024);
    (mockAgent.get('https://cdn.example.com') as Interceptable)
      .intercept({path: '/big.json', method: 'GET'})
      .reply(200, filler(1024), {
        headers: {'content-length': '1024'},
      });
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({maxBodyBytes: 256}),
      mockAgent,
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
      mockAgent,
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
    expect(mockCalls).toHaveLength(0);
  });

  it('security.http.allowedHosts admits a hostname in the allowlist (case-insensitive)', async () => {
    // Allowlist entry uses mixed case; URL host is lowercase per URL spec.
    // Match must be case-insensitive — otherwise operators carry foot-guns.
    const payload = '{"$id":"ok"}';
    (mockAgent.get('https://schemas.example.com') as Interceptable)
      .intercept({path: '/widget.json', method: 'GET'})
      .reply(200, payload, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
      });
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({allowedHosts: ['Schemas.Example.Com']}),
      mockAgent,
    );
    const out = await src.fetch('https://schemas.example.com/widget.json');
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe(payload);
  });

  it('security.http.allowRedirects=false refuses a 302 before the next hop fires', async () => {
    (mockAgent.get('https://cdn.example.com') as Interceptable)
      .intercept({path: '/widget.json', method: 'GET'})
      .reply(302, '', {
        headers: {location: 'https://mirror.example.com/widget.json'},
      });
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({allowRedirects: false}),
      mockAgent,
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
    expect(mockCalls).toHaveLength(1);
  });

  it('security.http.maxRedirects=1 caps the redirect chain below the built-in default of 10', async () => {
    // Chain: hop0 → hop1 → hop2. With maxRedirects=1, the second hop is
    // permitted but the third triggers the cap. The hard-coded former
    // limit of 10 would have allowed both hops, so this test pins the
    // config tier as the load-bearing limit.
    (mockAgent.get('https://hop0.example.com') as Interceptable)
      .intercept({path: '/x.json', method: 'GET'})
      .reply(302, '', {
        headers: {location: 'https://hop1.example.com/x.json'},
      });
    (mockAgent.get('https://hop1.example.com') as Interceptable)
      .intercept({path: '/x.json', method: 'GET'})
      .reply(302, '', {
        headers: {location: 'https://hop2.example.com/x.json'},
      });
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({maxRedirects: 1}),
      mockAgent,
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
    (mockAgent.get('https://10.0.0.1') as Interceptable)
      .intercept({path: '/schema.json', method: 'GET'})
      .reply(200, '{"$id":"x"}', {
        headers: {'content-type': 'application/json'},
      });
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({allowPrivateHosts: true}),
      mockAgent,
    );
    const out = await src.fetch('https://10.0.0.1/schema.json');
    expect(out).toHaveLength(1);
    expect(mockCalls).toHaveLength(1);
  });

  it('security.http.verifyResolvedIps=false skips the DNS-rebinding preflight (and the lookup is never consulted for blocking)', async () => {
    // The hostname here resolves to a private IP. With the default verifier
    // ON, this would throw before any fetch fires (see http-source-body-cap
    // DNS-rebinding spec). With verifyResolvedIps=false the preflight is
    // disabled and the request lands.
    lookupMock.mockResolvedValue([{address: '169.254.169.254', family: 4}]);
    (mockAgent.get('https://example.com') as Interceptable)
      .intercept({path: '/y.json', method: 'GET'})
      .reply(200, '{"$id":"y"}', {
        headers: {'content-type': 'application/json'},
      });
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({verifyResolvedIps: false}),
      mockAgent,
    );
    const out = await src.fetch('https://example.com/y.json');
    expect(out).toHaveLength(1);
    expect(mockCalls).toHaveLength(1);
  });

  it('host:port allowlist entry matches host+port exactly', async () => {
    // Allowlist entry includes a port; URL must match host AND port.
    const payload = '{"$id":"p"}';
    (mockAgent.get('https://cdn.example.com:8443') as Interceptable)
      .intercept({path: '/p.json', method: 'GET'})
      .reply(200, payload, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
      });
    const src = new HttpSchemaSource(
      projectRoot,
      makeConfig({allowedHosts: ['cdn.example.com:8443']}),
      mockAgent,
    );
    const out = await src.fetch('https://cdn.example.com:8443/p.json');
    expect(out).toHaveLength(1);

    // Same host without the matching port must be rejected.
    const src2 = new HttpSchemaSource(
      projectRoot,
      makeConfig({allowedHosts: ['cdn.example.com:8443']}),
      mockAgent,
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
