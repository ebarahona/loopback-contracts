import {BindingScope, injectable} from '@loopback/core';
import type {ConfigRegistry} from '../interfaces';
import type {ModelConfigJson} from '../types';

/**
 * In-memory implementation of {@link ConfigRegistry}. Populated by the
 * pipeline at stage 5 (config validation): for every `configs/*.config.json`
 * file the engine successfully validates, one entry lands here keyed by
 * `$contractId`. Consumed by lb4-idiom-tier emitters (model, repository,
 * controller, datasource) which need the per-contract LB4 metadata
 * (dataSource binding, relations, ACLs, idProperty, etc.) the schema
 * itself does NOT carry.
 *
 * Pure schemas stay portable; LB4-isms live here.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class InMemoryConfigRegistry implements ConfigRegistry {
  private readonly configs = new Map<string, ModelConfigJson>();

  /** Add a config keyed by its `$contractId`. Last-write-wins on collision. */
  add(config: ModelConfigJson): void {
    const id = config.$contractId;
    if (typeof id !== 'string' || id.length === 0) return;
    this.configs.set(id, config);
  }

  /** Bulk-add. */
  addAll(configs: readonly ModelConfigJson[]): void {
    for (const c of configs) this.add(c);
  }

  /** Look up a config by `$contractId`. Returns `undefined` when missing. */
  get(contractId: string): ModelConfigJson | undefined {
    return this.configs.get(contractId);
  }

  /** Live snapshot of every loaded config. */
  list(): readonly ModelConfigJson[] {
    return Object.freeze([...this.configs.values()]);
  }

  /** Membership check by `$contractId`. */
  has(contractId: string): boolean {
    return this.configs.has(contractId);
  }

  /**
   * Reset between pipeline runs. Engine-private: not part of the public
   * {@link ConfigRegistry} interface — pipeline.ts calls this through the
   * concrete class binding to enforce the "fully populated or fully empty"
   * stage-5 invariant.
   *
   * @internal
   */
  _reset(): void {
    this.configs.clear();
  }
}
