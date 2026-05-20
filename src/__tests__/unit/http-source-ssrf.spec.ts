import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ContractsSourceError} from '../../helpers';
import {HttpSchemaSource} from '../../sources/http-source';

/**
 * The HTTP source must refuse non-https schemes and outbound requests aimed
 * at loopback/link-local/RFC1918 addresses (SSRF). When the operator opts in
 * via `LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS`, the private-host gate must
 * relax while the protocol gate stays armed.
 */
describe('HttpSchemaSource SSRF hardening', () => {
  const originalAllow = process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let projectRoot: string;

  beforeEach(() => {
    delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    projectRoot = mkdtempSync(join(tmpdir(), 'lb4-contracts-ssrf-'));
    fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not have been called');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
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

  it('rejects http:// URIs (wrong scheme)', async () => {
    const src = new HttpSchemaSource(projectRoot);
    await expect(src.fetch('http://example.com/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    await expect(src.fetch('http://example.com/schema.json')).rejects.toThrow(
      /Only https:\/\/ is supported/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks AWS metadata IP 169.254.169.254', async () => {
    const src = new HttpSchemaSource(projectRoot);
    await expect(
      src.fetch('https://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow(ContractsSourceError);
    await expect(
      src.fetch('https://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow(/169\.254\.169\.254/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks IPv4 loopback 127.0.0.1', async () => {
    const src = new HttpSchemaSource(projectRoot);
    await expect(src.fetch('https://127.0.0.1/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks RFC1918 10.0.0.1', async () => {
    const src = new HttpSchemaSource(projectRoot);
    await expect(src.fetch('https://10.0.0.1/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks localhost by name', async () => {
    const src = new HttpSchemaSource(projectRoot);
    await expect(src.fetch('https://localhost/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks IPv6 loopback ::1', async () => {
    const src = new HttpSchemaSource(projectRoot);
    await expect(src.fetch('https://[::1]/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks IPv6 loopback with an explicit port ([::1]:443)', async () => {
    // Regression: the bracket-strip step in `assertHostAllowed` must leave a
    // bare `::1` for `isIP` to recognise — `URL.hostname` keeps the brackets
    // but does not include the port, so the simple `[…]` strip is sufficient.
    // This test pins that behaviour.
    const src = new HttpSchemaSource(projectRoot);
    await expect(src.fetch('https://[::1]:443/schema.json')).rejects.toThrow(
      ContractsSourceError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks IPv4-mapped IPv6 in hex form ([::ffff:7f00:1] == 127.0.0.1)', async () => {
    // `::ffff:7f00:1` encodes the 32-bit IPv4 address `7f000001` (127.0.0.1)
    // in two 16-bit hex groups. The dotted-decimal variant `::ffff:127.0.0.1`
    // is already covered by the IPv4 path; this case exercises the parallel
    // hex-form branch.
    const src = new HttpSchemaSource(projectRoot);
    await expect(
      src.fetch('https://[::ffff:7f00:1]/schema.json'),
    ).rejects.toThrow(ContractsSourceError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS=1 lets private IPs through to fetch', async () => {
    process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'] = '1';
    // We stub fetch to a 200 OK so we observe that the host gate is lifted
    // and the call actually reaches the network layer (no SSRF guard).
    fetchSpy.mockResolvedValueOnce(
      new Response('{"$id":"x"}', {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );
    const src = new HttpSchemaSource(projectRoot);
    const out = await src.fetch('https://10.0.0.1/schema.json');
    expect(out).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS=1 still rejects http:// (override is scoped)', async () => {
    process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'] = '1';
    const src = new HttpSchemaSource(projectRoot);
    await expect(src.fetch('http://example.com/schema.json')).rejects.toThrow(
      /Only https:\/\/ is supported/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
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
      const publicUrl = 'https://attacker.example.com/contract.json';
      const privateUrl = 'http://169.254.169.254/latest/meta-data/iam/';

      // Always answer the public host with a 302 → private host. If the
      // SSRF guard is broken and the loader tries to follow the redirect,
      // the second call will request `privateUrl`; we throw loudly in that
      // case so the test fails with an actionable signal rather than a hang.
      fetchSpy.mockImplementation(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url === publicUrl) {
          return new Response(null, {
            status: 302,
            headers: {location: privateUrl},
          });
        }
        throw new Error(
          `second fetch must not be issued — SSRF guard regressed (saw ${url})`,
        );
      });

      const src = new HttpSchemaSource(projectRoot);
      const err = await src.fetch(publicUrl).then(
        () => {
          throw new Error('expected fetch to throw');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ContractsSourceError);
      expect((err as Error).message).toMatch(/169\.254\.169\.254/);
      // Exactly one hop fired — the public 302. The redirect target was
      // refused by `assertHostAllowed` before any second fetch was issued.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(publicUrl);
    });
  });
});
