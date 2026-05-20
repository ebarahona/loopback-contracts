import {
  BindingScope,
  ContextView,
  filterByTag,
  inject,
  injectable,
} from '@loopback/core';
import {ContractsEmitterConflictError} from '../helpers';
import type {ProjectionEmitter} from '../interfaces';
import {EMITTER_TAG} from '../keys';

/**
 * Snapshot of a single emitter's metadata — the projection consumed by the
 * CLI's `lb-contracts init` prompts and the `lb-contracts emitters list` diagnostic. Carries
 * only the fields surfaced in user-facing output, not the runtime `emit()`
 * method.
 *
 * @internal
 */
export interface EmitterMetadata {
  readonly kind: string;
  readonly outputSuffix: string;
  readonly tier: ProjectionEmitter['tier'];
  readonly description: string;
  readonly peerDeps?: readonly string[];
}

/**
 * Live registry of every {@link ProjectionEmitter} contributed to the current
 * application context.
 *
 * Discovery is driven by LB4's extension-view machinery — every emitter binds
 * itself with the `EMITTER_TAG` tag and the registry enumerates the matching
 * bindings via an injected `ContextView`. The view is reactive: emitters that
 * appear or disappear at runtime are picked up on the next call without
 * restarting the engine.
 *
 * Engine-internal: emitter authors never instantiate or import this class.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class EmitterRegistry {
  constructor(
    @inject.view(filterByTag(EMITTER_TAG))
    private readonly view: ContextView<ProjectionEmitter>,
  ) {}

  /**
   * Enumerate every emitter bound under {@link EMITTER_TAG} in the current
   * context. The result is a fresh snapshot resolved through the underlying
   * `ContextView` on each call so reactivity is preserved.
   *
   * @internal
   */
  async all(): Promise<readonly ProjectionEmitter[]> {
    const values = await this.view.values();
    return Object.freeze(values.slice());
  }

  /**
   * Find the emitter with the given `kind`, or `undefined` if none is
   * registered. {@link validateUniqueness} guarantees at most one match per
   * kind; this method picks the first if the caller skipped that check.
   *
   * @internal
   */
  async byKind(kind: string): Promise<ProjectionEmitter | undefined> {
    const emitters = await this.all();
    return emitters.find(e => e.kind === kind);
  }

  /**
   * Subset of registered emitters whose `kind` is enabled in the supplied
   * `emitFlags` map (typically `loopback.config.json#/emit`). Unknown flags
   * are ignored here — meta-schema validation rejects them earlier in the
   * pipeline.
   *
   * @internal
   */
  async findEnabled(
    emitFlags: Record<string, boolean>,
  ): Promise<readonly ProjectionEmitter[]> {
    const emitters = await this.all();
    return Object.freeze(
      emitters.filter(e => emitFlags[e.kind] === true),
    ) as readonly ProjectionEmitter[];
  }

  /**
   * Throw {@link ContractsEmitterConflictError} if two registered emitters
   * claim the same `kind`. Called once per `lb-contracts gen` run before the runner
   * walks the schema set so collisions surface with one clear message rather
   * than a non-deterministic "last writer wins" silent override.
   *
   * @internal
   * @throws ContractsEmitterConflictError When two emitters share a `kind`.
   */
  async validateUniqueness(): Promise<void> {
    const emitters = await this.all();
    const seen = new Map<string, ProjectionEmitter>();
    for (const emitter of emitters) {
      const prior = seen.get(emitter.kind);
      if (prior !== undefined) {
        throw new ContractsEmitterConflictError({
          kind: emitter.kind,
          origins: [originLabel(prior), originLabel(emitter)],
        });
      }
      seen.set(emitter.kind, emitter);
    }
  }

  /**
   * Project the registry to a plain metadata list — the form consumed by the
   * `lb-contracts init` interactive prompt, the `lb-contracts emitters list` command, and the
   * meta-schema generator that emits the `emit` enum.
   *
   * @internal
   */
  async listMetadata(): Promise<readonly EmitterMetadata[]> {
    const emitters = await this.all();
    return Object.freeze(
      emitters.map(e => {
        const meta: EmitterMetadata = {
          kind: e.kind,
          outputSuffix: e.outputSuffix,
          tier: e.tier,
          description: e.description,
        };
        return e.peerDeps !== undefined
          ? {...meta, peerDeps: Object.freeze(e.peerDeps.slice())}
          : meta;
      }),
    );
  }
}

// Best-effort label for the emitter's origin used in conflict diagnostics.
// We don't have direct access to the binding key here — the constructor
// name is the most stable identifier emitters expose without forcing the
// runtime to carry extra metadata. Falls back to '<anonymous>' for the
// rare emitter constructed via an anonymous class expression.
function originLabel(emitter: ProjectionEmitter): string {
  const ctor = (emitter as {constructor?: {name?: string}}).constructor;
  const name = ctor?.name;
  return name && name.length > 0 ? name : '<anonymous>';
}
