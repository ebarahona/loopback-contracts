import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MockAgent, type Interceptable} from 'undici';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ContractsSourceError} from '../../helpers';
import {HttpSchemaSource} from '../../sources/http-source';

// Same dns mock pattern as `http-source-ssrf.spec.ts` — the body-cap path
// runs after the IP gate, so every test here needs `dns.lookup` to resolve
// non-literal hostnames to a benign public IP. The connect-time DNS pin
// is bypassed by injecting a MockAgent; only the preflight tier uses this.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

/**
 * Build a string of `n` bytes (ASCII NULs). MockAgent stringifies the
 * `data` argument, which yields a body of exactly `n` bytes when given a
 * Buffer/Uint8Array of `n` bytes — matching the `Content-Length` semantics
 * the cap path expects.
 */
function filler(n: number): Buffer {
  return Buffer.alloc(n);
}

describe('HttpSchemaSource body-size cap (DoS hardening)', () => {
  const originalMax = process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'];
  const originalAllow = process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
  let mockAgent: MockAgent;
  let projectRoot: string;

  beforeEach(() => {
    delete process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'];
    delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    projectRoot = mkdtempSync(join(tmpdir(), 'lb4-contracts-bodycap-'));
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{address: '93.184.216.34', family: 4}]);
  });

  afterEach(async () => {
    if (originalMax === undefined) {
      delete process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'];
    } else {
      process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'] = originalMax;
    }
    if (originalAllow === undefined) {
      delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    } else {
      process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'] = originalAllow;
    }
    await mockAgent.close();
    rmSync(projectRoot, {recursive: true, force: true});
  });

  it('rejects on Content-Length pre-check when header exceeds cap', async () => {
    process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'] = '1024';
    // A 2 KB body declared by header — cheap rejection, no body read.
    (mockAgent.get('https://cdn.example.com') as Interceptable)
      .intercept({path: '/big.json', method: 'GET'})
      .reply(200, filler(2048), {
        headers: {'content-length': '2048'},
      });
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    const err = await src.fetch('https://cdn.example.com/big.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(/exceeds max bytes/);
    expect((err as Error).message).toMatch(/header reports 2048/);
    expect((err as Error).message).toMatch(/cap 1024/);
  });

  it('rejects mid-stream when actual bytes exceed cap (no Content-Length)', async () => {
    process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'] = '512';
    // No content-length header — drive the streamed-tally branch. MockAgent
    // will compute `content-length` automatically unless explicitly cleared,
    // so reply via a callback that lets us set headers without one.
    (mockAgent.get('https://cdn.example.com') as Interceptable)
      .intercept({path: '/chunked.json', method: 'GET'})
      .reply(200, filler(800), {
        headers: {'content-type': 'application/json'},
      });
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    const err = await src.fetch('https://cdn.example.com/chunked.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(/exceeds max bytes/);
    // Either path (header pre-check or streamed-tally) can fire depending on
    // whether undici computes a content-length header; the cap message must
    // surface the actual over-cap byte count.
    expect((err as Error).message).toMatch(
      /(streamed 800 bytes|header reports 800)/,
    );
    expect((err as Error).message).toMatch(/cap 512/);
  });

  it('rejects mid-stream when Content-Length lies (under-reports actual)', async () => {
    process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'] = '100';
    // Header claims 50 bytes (passes pre-check) but body actually streams 200.
    // The streamed tally must catch the overrun.
    (mockAgent.get('https://cdn.example.com') as Interceptable)
      .intercept({path: '/lying.json', method: 'GET'})
      .reply(200, filler(200), {
        headers: {'content-length': '50'},
      });
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    const err = await src.fetch('https://cdn.example.com/lying.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(/exceeds max bytes/);
    expect((err as Error).message).toMatch(/streamed 200 bytes/);
  });

  it('accepts a body within the cap and decodes as UTF-8', async () => {
    process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'] = '1024';
    const payload = '{"$id":"u","type":"object"}';
    (mockAgent.get('https://cdn.example.com') as Interceptable)
      .intercept({path: '/u.json', method: 'GET'})
      .reply(200, payload, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
      });
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    const out = await src.fetch('https://cdn.example.com/u.json');
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe(payload);
  });

  it('ignores a non-numeric LOOPBACK_CONTRACTS_HTTP_MAX_BYTES and uses default 5 MiB', async () => {
    process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'] = 'not-a-number';
    // 1 KB body under the 5 MiB default cap — must succeed.
    const payload = '{"$id":"x"}';
    (mockAgent.get('https://cdn.example.com') as Interceptable)
      .intercept({path: '/x.json', method: 'GET'})
      .reply(200, payload, {
        headers: {'content-length': String(Buffer.byteLength(payload))},
      });
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    const out = await src.fetch('https://cdn.example.com/x.json');
    expect(out).toHaveLength(1);
  });
});

describe('HttpSchemaSource DNS-rebinding hardening (resolved-IP gate)', () => {
  const originalAllow = process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
  let mockAgent: MockAgent;
  let projectRoot: string;
  let mockCalls: string[];

  beforeEach(() => {
    delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    projectRoot = mkdtempSync(join(tmpdir(), 'lb4-contracts-dnsrebind-'));
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

  it('rejects when a public hostname resolves to 169.254.169.254 (cloud metadata)', async () => {
    lookupMock.mockResolvedValueOnce([{address: '169.254.169.254', family: 4}]);
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    const err = await src
      .fetch('https://rebind.attacker.example/schema.json')
      .then(
        () => {
          throw new Error('expected fetch to throw');
        },
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(
      /resolved to private\/link-local IP 169\.254\.169\.254/,
    );
    expect(mockCalls).toHaveLength(0);
  });

  it('rejects when ANY address in a dual-stack answer is private', async () => {
    // Public A record + private AAAA — must still be refused. `lookup({all:true})`
    // surfaces every record; one bad one is enough.
    lookupMock.mockResolvedValueOnce([
      {address: '93.184.216.34', family: 4},
      {address: 'fc00::1', family: 6},
    ]);
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    const err = await src.fetch('https://dual.example.com/schema.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(/fc00::1/);
    expect(mockCalls).toHaveLength(0);
  });

  it('LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS=1 bypasses the DNS-IP check', async () => {
    process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'] = '1';
    lookupMock.mockResolvedValue([{address: '169.254.169.254', family: 4}]);
    const payload = '{"$id":"y"}';
    (mockAgent.get('https://example.com') as Interceptable)
      .intercept({path: '/y.json', method: 'GET'})
      .reply(200, payload, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
      });
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    // The hostname is a string-public IP (so `assertHostAllowed` lets it
    // through too) but resolves to a private one — only the DNS gate could
    // catch it. With the opt-in flag set, the request lands.
    const out = await src.fetch('https://example.com/y.json');
    expect(out).toHaveLength(1);
    expect(mockCalls).toHaveLength(1);
  });

  it('rejects CGNAT 100.64.0.1', async () => {
    lookupMock.mockResolvedValueOnce([{address: '100.64.0.1', family: 4}]);
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await expect(
      src.fetch('https://cgnat.example.com/schema.json'),
    ).rejects.toThrow(/100\.64\.0\.1/);
    expect(mockCalls).toHaveLength(0);
  });

  it('rejects IPv6 multicast ff02::1', async () => {
    lookupMock.mockResolvedValueOnce([{address: 'ff02::1', family: 6}]);
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await expect(
      src.fetch('https://mcast.example.com/schema.json'),
    ).rejects.toThrow(/ff02::1/);
    expect(mockCalls).toHaveLength(0);
  });

  it('refuses every redirect hop: public → public-looking-rebind 302 → 169.254.169.254 (second fetch must not fire)', async () => {
    const hop1Origin = 'https://hop1.example.com';
    const hop1Path = '/contract.json';
    const hop2 = 'https://rebind.example.com/contract.json';
    // Hop 1 resolves clean; hop 2 string-passes the host check but resolves
    // to the metadata IP. The redirect-hop DNS gate must catch it.
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === 'hop1.example.com') {
        return [{address: '93.184.216.34', family: 4}];
      }
      if (hostname === 'rebind.example.com') {
        return [{address: '169.254.169.254', family: 4}];
      }
      throw new Error(`unexpected hostname: ${hostname}`);
    });
    (mockAgent.get(hop1Origin) as Interceptable)
      .intercept({path: hop1Path, method: 'GET'})
      .reply(302, '', {headers: {location: hop2}});
    // No interceptor for rebind.example.com — if the redirect-hop DNS gate
    // regresses, MockAgent will throw a "no match" error, which still
    // surfaces as a test failure with an actionable signal.
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    const err = await src.fetch(`${hop1Origin}${hop1Path}`).then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(/169\.254\.169\.254/);
    expect(mockCalls).toHaveLength(1);
    expect(mockCalls[0]).toBe(`${hop1Origin}${hop1Path}`);
  });
});
