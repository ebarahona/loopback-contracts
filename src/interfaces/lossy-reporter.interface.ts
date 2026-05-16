import type {LossyReport} from './emitter-context.interface';

/**
 * Sink the engine hands to internal stages so they can record lossy-
 * translation reports. Emitters surface lossy reports through this same
 * sink (wrapped by the engine); the engine's built-in
 * `InMemoryLossyReporter` is the canonical implementation.
 *
 * Bound under {@link ContractsBindings.LOSSY_REPORTER} — exposed as
 * `@public` because the binding key is `@public` and the generic on the
 * `BindingKey` is part of the public contract.
 *
 * @public
 */
export interface LossyReporter {
  /** Record a single lossy-translation entry for the current run. */
  report(r: LossyReport): void;

  /**
   * Return every entry recorded so far, in arrival order. Implementations
   * must return a snapshot the caller cannot mutate (a frozen copy or
   * `readonly` view); the canonical {@link InMemoryLossyReporter} returns
   * `Object.freeze(buffer.slice())`.
   */
  entries(): readonly LossyReport[];
}
