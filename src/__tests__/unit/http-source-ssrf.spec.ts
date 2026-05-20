import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MockAgent, type Interceptable} from 'undici';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ContractsSourceError} from '../../helpers';
import {HttpSchemaSource} from '../../sources/http-source';

// Stub `dns/promises.lookup` so the preflight `assertResolvedIpAllowed`
// gate gets predictable answers without touching the resolver. The
// connect-time DNS pin in the production `buildPinnedDispatcher` is
// bypassed in tests by injecting a `MockAgent` (which short-circuits the
// socket layer entirely), so this mock is only used by the preflight tier.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

/**
 * The HTTP source must refuse non-https schemes and outbound requests aimed
 * at loopback/link-local/RFC1918 addresses (SSRF). When the operator opts in
 * via `LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS`, the private-host gate must
 * relax while the protocol gate stays armed.
 */
describe('HttpSchemaSource SSRF hardening', () => {
  const originalAllow = process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
  let projectRoot: string;
  let mockAgent: MockAgent;
  // Tracks every request that landed at the mock dispatcher — analogue of
  // `fetchSpy` from the pre-undici-dispatcher version of this suite. Each
  // expectation that previously asserted `fetchSpy` call count now reads
  // this list instead, keeping the test semantics intact post-migration.
  let mockCalls: string[];

  beforeEach(() => {
    delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    projectRoot = mkdtempSync(join(tmpdir(), 'lb4-contracts-ssrf-'));
    mockAgent = new MockAgent();
    // No `enableNetConnect()` — any unintercepted request must blow up
    // loudly so a regressed SSRF guard surfaces as a test failure rather
    // than a silent live network hit.
    mockAgent.disableNetConnect();
    mockCalls = [];
    // Default: echo IP literals (the IPv4/IPv6 SSRF tests rely on this) and
    // resolve any non-literal hostname (e.g. `attacker.example.com`) to a
    // benign public IP so it gets past `assertResolvedIpAllowed` and hits the
    // mock dispatcher. Per-test `mockResolvedValueOnce` calls override this.
    lookupMock.mockReset();
    lookupMock.mockImplementation(
      async (hostname: string, _opts?: {all?: boolean}) => {
        if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
          return [{address: hostname, family: 4}];
        }
        if (hostname.includes(':')) {
          return [{address: hostname, family: 6}];
        }
        return [{address: '93.184.216.34', family: 4}];
      },
    );
  });

  afterEach(async () => {
    if (originalAllow === undefined) {
      delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    } else {
      process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'] = originalAllow;
    }
    await mockAgent.close();
    rmSync(projectRoot, {recursive: true, force: true});
  });

  /**
   * Register a one-shot mock interceptor for `${origin}${path}` that records
   * the URL into `mockCalls` (so call-count assertions work) and replies
   * with the supplied status/body/headers. Centralises the bookkeeping so
   * individual tests stay focused on the SSRF condition under test.
   */
  function intercept(
    origin: string,
    path: string,
    reply: {status: number; body?: string; headers?: Record<string, string>},
  ): void {
    const pool = mockAgent.get(origin) as Interceptable;
    pool
      .intercept({path, method: 'GET'})
      .reply(reply.status, reply.body ?? '', {
        headers: reply.headers ?? {'content-type': 'application/json'},
      })
      .times(1);
    // Wrap the underlying dispatch so we can observe call count + URL —
    // MockAgent doesn't expose that surface natively.
  }

  // Patch MockAgent.dispatch so every intercepted request lands in mockCalls
  // — the natural seam since MockAgent extends Dispatcher and our source
  // calls `dispatcher.dispatch(...)` through undici-fetch. Re-applied each
  // test via beforeEach since the agent is freshly constructed.
  beforeEach(() => {
    const originalDispatch = mockAgent.dispatch.bind(mockAgent);
    mockAgent.dispatch = (opts, handler) => {
      const origin =
        typeof opts.origin === 'string'
          ? opts.origin
          : (opts.origin?.toString() ?? '');
      mockCalls.push(`${origin}${opts.path ?? ''}`);
      return originalDispatch(opts, handler);
    };
  });

  it('rejects http:// URIs (wrong scheme)', async () => {
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await expect(src.fetch('http://example.com/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    await expect(src.fetch('http://example.com/schema.json')).rejects.toThrow(
      /Only https:\/\/ is supported/,
    );
    expect(mockCalls).toHaveLength(0);
  });

  it('blocks AWS metadata IP 169.254.169.254', async () => {
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await expect(
      src.fetch('https://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow(ContractsSourceError);
    await expect(
      src.fetch('https://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow(/169\.254\.169\.254/);
    expect(mockCalls).toHaveLength(0);
  });

  it('blocks IPv4 loopback 127.0.0.1', async () => {
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await expect(src.fetch('https://127.0.0.1/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    expect(mockCalls).toHaveLength(0);
  });

  it('blocks RFC1918 10.0.0.1', async () => {
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await expect(src.fetch('https://10.0.0.1/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    expect(mockCalls).toHaveLength(0);
  });

  it('blocks localhost by name', async () => {
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await expect(src.fetch('https://localhost/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    expect(mockCalls).toHaveLength(0);
  });

  it('blocks IPv6 loopback ::1', async () => {
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await expect(src.fetch('https://[::1]/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    expect(mockCalls).toHaveLength(0);
  });

  it('blocks IPv6 loopback with an explicit port ([::1]:443)', async () => {
    // Regression: the bracket-strip step in `assertHostAllowed` must leave a
    // bare `::1` for `isIP` to recognise — `URL.hostname` keeps the brackets
    // but does not include the port, so the simple `[…]` strip is sufficient.
    // This test pins that behaviour.
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await expect(src.fetch('https://[::1]:443/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    expect(mockCalls).toHaveLength(0);
  });

  it('blocks IPv4-mapped IPv6 in hex form ([::ffff:7f00:1] == 127.0.0.1)', async () => {
    // `::ffff:7f00:1` encodes the 32-bit IPv4 address `7f000001` (127.0.0.1)
    // in two 16-bit hex groups. The dotted-decimal variant `::ffff:127.0.0.1`
    // is already covered by the IPv4 path; this case exercises the parallel
    // hex-form branch.
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await expect(
      src.fetch('https://[::ffff:7f00:1]/schema.json'),
    ).rejects.toThrow(ContractsSourceError);
    expect(mockCalls).toHaveLength(0);
  });

  it('LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS=1 lets private IPs through to fetch', async () => {
    process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'] = '1';
    intercept('https://10.0.0.1', '/schema.json', {
      status: 200,
      body: '{"$id":"x"}',
    });
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    const out = await src.fetch('https://10.0.0.1/schema.json');
    expect(out).toHaveLength(1);
    expect(mockCalls).toHaveLength(1);
  });

  it('LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS=1 still rejects http:// (override is scoped)', async () => {
    process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'] = '1';
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await expect(src.fetch('http://example.com/schema.json')).rejects.toThrow(
      /Only https:\/\/ is supported/,
    );
    expect(mockCalls).toHaveLength(0);
  });

  /**
   * Regression guard for the cross-origin-redirect SSRF window. Prior to the
   * manual redirect loop, undici's `redirect: 'follow'` would land on the
   * private host (e.g., the EC2/IMDS endpoint) reached via a public-host
   * 302 *before* the post-fetch `res.url` check could refuse it — at which
   * point the metadata service had already responded. The loader now
   * re-runs `assertHostAllowed` on every redirect hop before issuing the
   * next request.
   */
  describe('manual redirect handling (SSRF cross-origin redirect)', () => {
    it('throws ContractsSourceError when a public host 302s to 169.254.169.254 — second fetch must not fire', async () => {
      const publicOrigin = 'https://attacker.example.com';
      const publicPath = '/contract.json';
      // Use an HTTPS metadata URL so the redirect target is rejected by the
      // private-IP guard, not the HTTPS-to-HTTP downgrade guard. (Many cloud
      // metadata endpoints listen on plain HTTP; this test pins the
      // private-IP guard specifically, so we keep the scheme `https://`.)
      const privateUrl = 'https://169.254.169.254/latest/meta-data/iam/';
      intercept(publicOrigin, publicPath, {
        status: 302,
        body: '',
        headers: {location: privateUrl},
      });
      // No interceptor for the private URL — if the redirect-hop SSRF guard
      // regresses, MockAgent will throw a "no match" error rather than
      // hanging, which is the actionable signal we want.

      const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
      const err = await src.fetch(`${publicOrigin}${publicPath}`).then(
        () => {
          throw new Error('expected fetch to throw');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ContractsSourceError);
      expect((err as Error).message).toMatch(/169\.254\.169\.254/);
      // Exactly one hop fired — the public 302. The redirect target was
      // refused by `assertHostAllowed` before any second fetch was issued.
      expect(mockCalls).toHaveLength(1);
      expect(mockCalls[0]).toBe(`${publicOrigin}${publicPath}`);
    });
  });

  /**
   * Regression guards for the HTTPS-to-HTTP redirect downgrade. The source
   * only accepts `https://` descriptors initially, so an attacker controlling
   * a redirect can otherwise downgrade the chain to plaintext HTTP — losing
   * TLS, cert validation, and integrity. Default-safe behaviour refuses;
   * `security.http.allowInsecureRedirects=true` opts in.
   */
  describe('HTTPS-to-HTTP redirect downgrade (transport integrity)', () => {
    it('refuses by default when a public https host 302s to http:// (no opt-in)', async () => {
      const origin = 'https://cdn.example.com';
      const path = '/widget.json';
      intercept(origin, path, {
        status: 302,
        body: '',
        headers: {location: 'http://attacker.example.com/widget.json'},
      });
      // No interceptor for the http target — if the downgrade guard
      // regresses, MockAgent will throw a "no match" error, surfacing
      // the regression as a test failure rather than a silent bypass.
      const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
      const err = await src.fetch(`${origin}${path}`).then(
        () => {
          throw new Error('expected fetch to throw');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ContractsSourceError);
      expect((err as Error).message).toMatch(/downgrades.*HTTP/i);
      expect((err as Error).message).toMatch(/allowInsecureRedirects/);
      // Exactly one hop fired — the original https GET. The http target
      // was refused before the second fetch went out.
      expect(mockCalls).toHaveLength(1);
      expect(mockCalls[0]).toBe(`${origin}${path}`);
    });

    it('proceeds when security.http.allowInsecureRedirects=true is configured', async () => {
      const origin = 'https://cdn.example.com';
      const path = '/widget.json';
      const downstream = 'http://legacy.example.com/widget.json';
      const payload = '{"$id":"legacy"}';
      intercept(origin, path, {
        status: 302,
        body: '',
        headers: {location: downstream},
      });
      (mockAgent.get('http://legacy.example.com') as Interceptable)
        .intercept({path: '/widget.json', method: 'GET'})
        .reply(200, payload, {
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          },
        })
        .times(1);
      const src = new HttpSchemaSource(
        projectRoot,
        {
          name: 't',
          schemasDir: './schemas',
          configsDir: './configs',
          validator: 'ajv',
          schemas: [],
          emit: {},
          security: {http: {allowInsecureRedirects: true}},
        },
        mockAgent,
      );
      const out = await src.fetch(`${origin}${path}`);
      expect(out).toHaveLength(1);
      expect(out[0]?.content).toBe(payload);
      // Two hops fired — the original https GET and the followed http GET.
      expect(mockCalls).toHaveLength(2);
      expect(mockCalls[0]).toBe(`${origin}${path}`);
      expect(mockCalls[1]).toBe(downstream);
    });

    it('still refuses exotic schemes (javascript:, data:, file:) even with allowInsecureRedirects=true', async () => {
      // The opt-in is scoped to the http downgrade only — non-http(s)
      // schemes remain disallowed regardless of the flag. Pins that the
      // operator escape hatch does not silently widen to arbitrary schemes.
      const origin = 'https://cdn.example.com';
      const path = '/widget.json';
      intercept(origin, path, {
        status: 302,
        body: '',
        headers: {location: 'file:///etc/passwd'},
      });
      const src = new HttpSchemaSource(
        projectRoot,
        {
          name: 't',
          schemasDir: './schemas',
          configsDir: './configs',
          validator: 'ajv',
          schemas: [],
          emit: {},
          security: {http: {allowInsecureRedirects: true}},
        },
        mockAgent,
      );
      const err = await src.fetch(`${origin}${path}`).then(
        () => {
          throw new Error('expected fetch to throw');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ContractsSourceError);
      expect((err as Error).message).toMatch(/disallowed scheme/);
      expect((err as Error).message).toMatch(/file:/);
      expect(mockCalls).toHaveLength(1);
    });
  });
});
