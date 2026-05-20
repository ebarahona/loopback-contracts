import {BindingScope, injectable} from '@loopback/core';
import {createHash} from 'node:crypto';
import {ContractsCodegenError} from '../helpers';
import type {JSONSchema, SchemaRegistry} from '../interfaces';

/**
 * Canonicalise an arbitrary JSON value by recursively sorting object keys so
 * that two structurally equal schemas serialise to the same string regardless
 * of the order in which their authors typed the properties.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, canonicalise(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

/** SHA-256 fingerprint over the canonicalised JSON serialisation. */
function fingerprint(schema: JSONSchema): string {
  const canonical = JSON.stringify(canonicalise(schema));
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Default {@link SchemaRegistry} implementation — a `Map<string, JSONSchema>`
 * keyed by the schema's `$id`. The engine populates the registry once during
 * stage 1 of `lb-contracts gen`; emitters receive it via {@link EmitterContext.registry}
 * as a read-only view (the mutators below are absent from the interface).
 *
 * Collision policy: re-adding a schema with the same `$id` is allowed only when
 * the new payload is byte-identical to the existing entry under the canonical
 * (sorted-keys) JSON form. A genuine conflict throws {@link ContractsCodegenError}
 * so the source-resolution stage fails loudly rather than silently picking a
 * winner.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class InMemorySchemaRegistry implements SchemaRegistry {
  private readonly schemas = new Map<string, JSONSchema>();
  private readonly fingerprints = new Map<string, string>();

  get(id: string): JSONSchema | undefined {
    return this.schemas.get(id);
  }

  list(): readonly JSONSchema[] {
    return Object.freeze([...this.schemas.values()]);
  }

  has(id: string): boolean {
    return this.schemas.has(id);
  }

  /**
   * Register a single schema. Throws on `$id` collision unless the incoming
   * schema is content-equal (canonical-JSON fingerprint match) to the existing
   * entry, in which case the call is a no-op.
   *
   * @throws ContractsCodegenError When the schema has no `$id`, or when the
   *   `$id` is already registered with a different fingerprint.
   */
  add(schema: JSONSchema): void {
    const id = schema.$id;
    if (!id) {
      throw new ContractsCodegenError(
        'Schema is missing a top-level `$id` and cannot be registered',
        {emitterKind: 'schema-registry', schemaId: ''},
      );
    }
    const incoming = fingerprint(schema);
    const existing = this.fingerprints.get(id);
    if (existing !== undefined) {
      if (existing === incoming) return;
      throw new ContractsCodegenError(
        `Duplicate schema \`$id\` '${id}' with differing content; ` +
          'rename one or reconcile the source files',
        {emitterKind: 'schema-registry', schemaId: id},
      );
    }
    this.schemas.set(id, schema);
    this.fingerprints.set(id, incoming);
  }

  /** Bulk-register; same collision rules as {@link add}. */
  addAll(schemas: readonly JSONSchema[]): void {
    for (const schema of schemas) this.add(schema);
  }

  /** Reset the registry between engine runs. */
  clear(): void {
    this.schemas.clear();
    this.fingerprints.clear();
  }
}
