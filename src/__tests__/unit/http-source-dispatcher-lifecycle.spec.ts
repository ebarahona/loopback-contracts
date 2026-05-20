import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Agent, MockAgent, type Interceptable} from 'undici';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {HttpSchemaSource} from '../../sources/http-source';

// `Agent.prototype` itself does not define `close` — the method lives on
// `DispatcherBase` further up the chain. Walk the chain to find the
// prototype that actually owns `close`, so `vi.spyOn` targets the right
// slot. Without this, the spy is installed on a prototype the runtime
// never consults and the assertion can never fire.
function findCloseOwner(proto: object): object {
  let current: object | null = proto;
  while (current !== null) {
    if (Object.prototype.hasOwnProperty.call(current, 'close')) return current;
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new Error('no prototype on Agent chain owns `close`');
}

// Preflight DNS gate mock — keep every test focused on the dispatcher
// lifecycle without it tripping the SSRF guard. The connect-time DNS pin
// is bypassed for tests that inject a MockAgent (short-circuits the socket
// layer); only the preflight tier consults this mock.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

/**
 * The pinned undici {@link Agent} the HTTP source builds per-call holds an
 * open connection pool. A long-running process (`lb-contracts gen --watch`)
 * issues many fetches across its lifetime — if the source never closes the
 * dispatcher it created, each call leaks one pool, and pool sockets keep
 * the event loop alive past the operator's intent. The fix is ownership-aware
 * cleanup: a test-injected `dispatcherOverride` (e.g. `MockAgent`) is left
 * for the test to close, while a fresh per-call `Agent` is closed in a
 * `finally` after the fetch settles.
 *
 * These tests pin both halves of the contract.
 */
describe('HttpSchemaSource dispatcher lifecycle', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'lb4-contracts-disp-'));
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{address: '93.184.216.34', family: 4}]);
  });

  afterEach(() => {
    rmSync(projectRoot, {recursive: true, force: true});
  });

  it('does NOT close an injected dispatcher (test owns the lifecycle)', async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const closeSpy = vi.spyOn(mockAgent, 'close');
    (mockAgent.get('https://cdn.example.com') as Interceptable)
      .intercept({path: '/widget.json', method: 'GET'})
      .reply(200, '{"$id":"x"}', {
        headers: {'content-type': 'application/json'},
      })
      .times(2);
    const src = new HttpSchemaSource(projectRoot, undefined, mockAgent);
    await src.fetch('https://cdn.example.com/widget.json');
    // First fetch settled. If the source had closed the injected dispatcher,
    // the second fetch on the SAME source instance would fail with
    // "dispatcher closed" / similar — which would surface as a thrown
    // ContractsSourceError. Run the second fetch and assert it succeeds.
    await src.fetch('https://cdn.example.com/widget.json');
    expect(closeSpy).not.toHaveBeenCalled();
    await mockAgent.close();
  });

  it('closes the owned dispatcher created when no override is injected', async () => {
    // No MockAgent — the source builds its own pinned {@link Agent} per call.
    // Patch `close` on the prototype that actually owns it (DispatcherBase,
    // two hops up the chain from Agent.prototype) BEFORE constructing the
    // source so any Agent instance created inside `fetch()` lands on the
    // wrapper. The fetch is expected to fail (the hostname resolves to a
    // public IP via the mock but nothing actually serves the request), but
    // the `finally` in `HttpSchemaSource.fetch` must still run `close` on
    // the owned dispatcher — which is the load-bearing assertion.
    //
    // `vi.spyOn` does not reliably observe undici's `close` invocations in
    // this codebase (the method may be bound through a getter or accessed
    // off a derived class shape vitest can't proxy cleanly), so we install
    // a hand-rolled wrapper on the prototype and restore it after.
    const closeOwner = findCloseOwner(Agent.prototype) as {
      close: (...args: unknown[]) => Promise<void>;
    };
    const original = closeOwner.close;
    let calls = 0;
    closeOwner.close = function patched(
      this: object,
      ...args: unknown[]
    ): Promise<void> {
      calls++;
      return original.apply(this, args);
    };
    try {
      const src = new HttpSchemaSource(projectRoot);
      await src
        .fetch('https://nonexistent-host-for-dispatcher-test.example/x.json')
        .catch(() => undefined);
    } finally {
      closeOwner.close = original;
    }
    // At least one `close` invocation came from our owned dispatcher. The
    // patch was installed immediately before the fetch and restored after,
    // so every recorded call is downstream of this test.
    expect(calls).toBeGreaterThan(0);
  });
});
