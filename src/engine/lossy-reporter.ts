import {BindingScope, injectable} from '@loopback/core';
import type {LossyReport} from '../interfaces';
import type {LossyReporter} from '../types';

/** In-memory `LossyReporter` — accumulates reports for the current run. */
@injectable({scope: BindingScope.SINGLETON})
export class InMemoryLossyReporter implements LossyReporter {
  private readonly buffer: LossyReport[] = [];

  report(r: LossyReport): void {
    this.buffer.push(r);
  }

  /**
   * Return every entry recorded so far, in arrival order.
   *
   * NOTE: the runtime value is `Object.freeze`d so the returned array is
   * effectively immutable, but the static return type cannot be narrowed
   * to `readonly LossyReport[]` here without first widening the
   * `LossyReporter.entries()` declaration in `src/interfaces/` to match
   * — a `readonly T[]` value is not assignable to a `T[]` slot. The
   * interface contract is `@public`, so a v2.0 breaking change is
   * required before the impl signature can tighten.
   *
   * TODO(v2.0): change `LossyReporter.entries()` in
   * `src/interfaces/lossy-reporter.interface.ts` to return
   * `readonly LossyReport[]`, then tighten this method to match. The
   * runtime behaviour (frozen array) already enforces the contract;
   * only the static type lags.
   */
  entries(): LossyReport[] {
    return Object.freeze(this.buffer.slice()) as LossyReport[];
  }

  /**
   * Reset the buffer between engine runs. Called by the engine pipeline
   * before stage 1 so a long-lived singleton reporter never leaks reports
   * from a previous `lb-contracts gen` invocation.
   */
  clear(): void {
    this.buffer.length = 0;
  }
}
