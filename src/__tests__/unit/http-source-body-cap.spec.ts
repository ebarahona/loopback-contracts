import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ContractsSourceError} from '../../helpers';
import {HttpSchemaSource} from '../../sources/http-source';

// Same dns mock pattern as `http-source-ssrf.spec.ts` — the body-cap path
// runs after the IP gate, so every test here needs `dns.lookup` to resolve
// non-literal hostnames to a benign public IP.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

/**
 * Build a `Response` whose body is a `ReadableStream` that emits one or more
 * chunks. Vitest/Undici `Response` honours `.body.getReader()`, which is what
 * `readBodyText` consumes via the streamed-cap path.
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

/**
 * Encode `n` bytes of filler — content shape is irrelevant, only the byte
 * count is asserted.
 */
function filler(n: number): Uint8Array {
  return new Uint8Array(n);
}

describe('HttpSchemaSource body-size cap (DoS hardening)', () => {
  const originalMax = process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'];
  const originalAllow = process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let projectRoot: string;

  beforeEach(() => {
    delete process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'];
    delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    projectRoot = mkdtempSync(join(tmpdir(), 'lb4-contracts-bodycap-'));
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{address: '93.184.216.34', family: 4}]);
  });

  afterEach(() => {
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
    globalThis.fetch = originalFetch;
    rmSync(projectRoot, {recursive: true, force: true});
  });

  it('rejects on Content-Length pre-check when header exceeds cap', async () => {
    process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'] = '1024';
    fetchSpy.mockResolvedValueOnce(
      // A 2 KB body declared by header — cheap rejection, no body read.
      streamingResponse([filler(2048)], {
        status: 200,
        headers: {'content-length': '2048'},
      }),
    );
    const src = new HttpSchemaSource(projectRoot);
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
    // No content-length header — drive the streamed-tally branch. Two 400-byte
    // chunks; the second pushes the running total past 512.
    fetchSpy.mockResolvedValueOnce(
      streamingResponse([filler(400), filler(400)], {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );
    const src = new HttpSchemaSource(projectRoot);
    const err = await src.fetch('https://cdn.example.com/chunked.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(/exceeds max bytes/);
    expect((err as Error).message).toMatch(/streamed 800 bytes/);
    expect((err as Error).message).toMatch(/cap 512/);
  });

  it('rejects mid-stream when Content-Length lies (under-reports actual)', async () => {
    process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'] = '100';
    // Header claims 50 bytes (passes pre-check) but body actually streams 200.
    // The streamed tally must catch the overrun.
    fetchSpy.mockResolvedValueOnce(
      streamingResponse([filler(200)], {
        status: 200,
        headers: {'content-length': '50'},
      }),
    );
    const src = new HttpSchemaSource(projectRoot);
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
    const enc = new TextEncoder().encode(payload);
    fetchSpy.mockResolvedValueOnce(
      streamingResponse([enc.slice(0, 5), enc.slice(5)], {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(enc.byteLength),
        },
      }),
    );
    const src = new HttpSchemaSource(projectRoot);
    const out = await src.fetch('https://cdn.example.com/u.json');
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe(payload);
  });

  it('ignores a non-numeric LOOPBACK_CONTRACTS_HTTP_MAX_BYTES and uses default 5 MiB', async () => {
    process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'] = 'not-a-number';
    // 1 KB body under the 5 MiB default cap — must succeed.
    const enc = new TextEncoder().encode('{"$id":"x"}');
    fetchSpy.mockResolvedValueOnce(
      streamingResponse([enc], {
        status: 200,
        headers: {'content-length': String(enc.byteLength)},
      }),
    );
    const src = new HttpSchemaSource(projectRoot);
    const out = await src.fetch('https://cdn.example.com/x.json');
    expect(out).toHaveLength(1);
  });
});

describe('HttpSchemaSource DNS-rebinding hardening (resolved-IP gate)', () => {
  const originalAllow = process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let projectRoot: string;

  beforeEach(() => {
    delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    projectRoot = mkdtempSync(join(tmpdir(), 'lb4-contracts-dnsrebind-'));
    fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not have been called');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    lookupMock.mockReset();
  });

  afterEach(() => {
    if (originalAllow === undefined) {
      delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    } else {
      process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'] = originalAllow;
    }
    globalThis.fetch = originalFetch;
    rmSync(projectRoot, {recursive: true, force: true});
  });

  it('rejects when a public hostname resolves to 169.254.169.254 (cloud metadata)', async () => {
    lookupMock.mockResolvedValueOnce([{address: '169.254.169.254', family: 4}]);
    const src = new HttpSchemaSource(projectRoot);
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
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects when ANY address in a dual-stack answer is private', async () => {
    // Public A record + private AAAA — must still be refused. `lookup({all:true})`
    // surfaces every record; one bad one is enough.
    lookupMock.mockResolvedValueOnce([
      {address: '93.184.216.34', family: 4},
      {address: 'fc00::1', family: 6},
    ]);
    const src = new HttpSchemaSource(projectRoot);
    const err = await src.fetch('https://dual.example.com/schema.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(/fc00::1/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS=1 bypasses the DNS-IP check', async () => {
    process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'] = '1';
    lookupMock.mockResolvedValue([{address: '169.254.169.254', family: 4}]);
    const payload = '{"$id":"y"}';
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
    const src = new HttpSchemaSource(projectRoot);
    // The hostname is a string-public IP (so `assertHostAllowed` lets it
    // through too) but resolves to a private one — only the DNS gate could
    // catch it. With the opt-in flag set, the request lands.
    const out = await src.fetch('https://example.com/y.json');
    expect(out).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('rejects CGNAT 100.64.0.1', async () => {
    lookupMock.mockResolvedValueOnce([{address: '100.64.0.1', family: 4}]);
    const src = new HttpSchemaSource(projectRoot);
    await expect(
      src.fetch('https://cgnat.example.com/schema.json'),
    ).rejects.toThrow(/100\.64\.0\.1/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects IPv6 multicast ff02::1', async () => {
    lookupMock.mockResolvedValueOnce([{address: 'ff02::1', family: 6}]);
    const src = new HttpSchemaSource(projectRoot);
    await expect(
      src.fetch('https://mcast.example.com/schema.json'),
    ).rejects.toThrow(/ff02::1/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses every redirect hop: public → public-looking-rebind 302 → 169.254.169.254 (second fetch must not fire)', async () => {
    const hop1 = 'https://hop1.example.com/contract.json';
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
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === hop1) {
        return new Response(null, {
          status: 302,
          headers: {location: hop2},
        });
      }
      throw new Error(
        `second fetch must not be issued — DNS-rebind guard regressed (saw ${url})`,
      );
    });
    const src = new HttpSchemaSource(projectRoot);
    const err = await src.fetch(hop1).then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    expect((err as Error).message).toMatch(/169\.254\.169\.254/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(hop1);
  });
});
