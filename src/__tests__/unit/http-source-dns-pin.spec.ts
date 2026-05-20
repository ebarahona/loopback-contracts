import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ContractsSourceError} from '../../helpers';
import {HttpSchemaSource} from '../../sources/http-source';

/**
 * Mocks for both DNS surfaces:
 *
 *   - `node:dns/promises.lookup` — consumed by the *preflight*
 *     `assertResolvedIpAllowed` gate. Tests here keep this returning a
 *     PUBLIC address so the preflight tier always passes — the whole
 *     point of this file is to prove the connect-time pin catches what
 *     the preflight cannot.
 *   - `node:dns.lookup` (callback form) — consumed by undici's
 *     `connect.lookup` hook inside `buildPinnedDispatcher`. Tests here
 *     return a PRIVATE address to simulate the TOCTOU/rebinding race
 *     (preflight saw public, connect time sees private). The hook MUST
 *     refuse the connection before any socket opens.
 */
const promisesLookupMock = vi.hoisted(() => vi.fn());
const callbackLookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({lookup: promisesLookupMock}));
vi.mock('node:dns', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {...actual, lookup: callbackLookupMock};
});

/**
 * Pin the connect-time DNS check. The preflight (`node:dns/promises.lookup`)
 * is the historical safety net — load-bearing UX but vulnerable to a
 * TOCTOU/DNS-rebinding race where the address resolves to something
 * different at connect time. The connect-time hook in
 * `buildPinnedDispatcher` runs INSIDE undici's socket establishment and
 * re-classifies the resolved IP using the SAME private-range deny list,
 * so the address validated is the address dialed.
 *
 * These tests fail when run against a preflight-only implementation —
 * confirming the connect-time pin is the load-bearing defence.
 */
describe('HttpSchemaSource connect-time DNS pin (TOCTOU closure)', () => {
  const originalAllow = process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
  let projectRoot: string;

  beforeEach(() => {
    delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    projectRoot = mkdtempSync(join(tmpdir(), 'lb4-contracts-dnspin-'));
    promisesLookupMock.mockReset();
    callbackLookupMock.mockReset();
    // Default: preflight always sees a benign public IP so the preflight
    // tier never short-circuits the test — every assertion here exercises
    // the connect-time path.
    promisesLookupMock.mockResolvedValue([
      {address: '93.184.216.34', family: 4},
    ]);
  });

  afterEach(() => {
    if (originalAllow === undefined) {
      delete process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
    } else {
      process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'] = originalAllow;
    }
    rmSync(projectRoot, {recursive: true, force: true});
  });

  it('connect-time hook refuses when DNS resolves to 169.254.169.254 even though preflight saw a public IP (TOCTOU)', async () => {
    // Preflight already mocked to public (see beforeEach). Connect-time
    // lookup returns the cloud-metadata IP — simulating a DNS-rebinding
    // attacker who flipped the answer between the two checks.
    callbackLookupMock.mockImplementation(
      (
        _hostname: string,
        _opts: unknown,
        cb: (err: Error | null, address: string, family: number) => void,
      ) => {
        cb(null, '169.254.169.254', 4);
      },
    );
    // No dispatcherOverride — exercises the production pinned Agent.
    const src = new HttpSchemaSource(projectRoot);
    const err = await src.fetch('https://rebind.example.com/schema.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    // The connect-time hook's error is wrapped by `safeFetch`'s generic
    // `fetch failed before a response was received` branch (it never got
    // a response), but the underlying cause carries the load-bearing
    // diagnostic — surface it via the cause chain or the message.
    const message = (err as Error).message;
    const cause = (err as Error & {cause?: unknown}).cause;
    const causeChain: string[] = [];
    let current: unknown = cause;
    while (current instanceof Error) {
      causeChain.push(current.message);
      current = (current as Error & {cause?: unknown}).cause;
    }
    const combined = [message, ...causeChain].join(' | ');
    expect(combined).toMatch(/169\.254\.169\.254/);
  });

  it('connect-time hook refuses when DNS resolves to RFC1918 10.0.0.5', async () => {
    callbackLookupMock.mockImplementation(
      (
        _hostname: string,
        _opts: unknown,
        cb: (err: Error | null, address: string, family: number) => void,
      ) => {
        cb(null, '10.0.0.5', 4);
      },
    );
    const src = new HttpSchemaSource(projectRoot);
    const err = await src.fetch('https://rfc1918.example.com/schema.json').then(
      () => {
        throw new Error('expected fetch to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContractsSourceError);
    const message = (err as Error).message;
    let current: unknown = (err as Error & {cause?: unknown}).cause;
    const chain: string[] = [];
    while (current instanceof Error) {
      chain.push(current.message);
      current = (current as Error & {cause?: unknown}).cause;
    }
    expect([message, ...chain].join(' | ')).toMatch(/10\.0\.0\.5/);
  });

  it('connect-time hook honours allowPrivateHosts opt-out (preflight off, connect-time off)', async () => {
    // Opt out of both tiers. The connect-time hook must then accept the
    // private address (we still fail later at socket-connect because there's
    // no real server, but the LB4-level refusal must NOT fire). We assert
    // that the failure is NOT our DNS-rebind refusal — anything else
    // (ENOTFOUND, ECONNREFUSED, timeout) is acceptable evidence the gate
    // was lifted.
    process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'] = '1';
    callbackLookupMock.mockImplementation(
      (
        _hostname: string,
        _opts: unknown,
        cb: (err: Error | null, address: string, family: number) => void,
      ) => {
        cb(null, '127.0.0.1', 4);
      },
    );
    const src = new HttpSchemaSource(projectRoot);
    const err = await src
      .fetch('https://opted-in.example.com/schema.json')
      .then(
        () => {
          // A real socket *could* land if a localhost server happens to be
          // listening on 443 — extremely unlikely in CI but tolerated.
          return null;
        },
        (e: unknown) => e,
      );
    if (err !== null) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      let current: unknown = (err as Error & {cause?: unknown}).cause;
      const chain: string[] = [];
      while (current instanceof Error) {
        chain.push(current.message);
        current = (current as Error & {cause?: unknown}).cause;
      }
      const combined = [message, ...chain].join(' | ');
      // The connect-time refusal carries this distinctive substring; any
      // OTHER error (socket close, TLS, ENOTFOUND, etc.) means the gate
      // was correctly lifted by the opt-in.
      expect(combined).not.toMatch(
        /resolved to private\/link-local IP .* at connect time/,
      );
    }
  });
});
