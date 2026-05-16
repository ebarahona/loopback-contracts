import {
  BindingScope,
  ContextView,
  filterByTag,
  inject,
  injectable,
} from '@loopback/core';
import {ContractsSourceError} from '../helpers';
import type {SchemaSource, SchemaSourceResult} from '../interfaces';
import type {SchemaSourceDescriptor} from '../types';
import {SOURCE_TAG} from '../keys';

/**
 * Recognised built-in URI scheme prefixes the registry uses to pick a
 * {@link SchemaSource}. The set is intentionally small at v1.0; new
 * schemes (`s3:`, `gh:`, `gcs:`) join by registering a `SchemaSource`
 * under {@link SOURCE_TAG} — no change to this file is required.
 *
 * The "local" pseudo-scheme matches a bare path (no `<scheme>:` prefix).
 */
const LOCAL_SCHEME = 'local';

/**
 * Engine-internal wrapper around the `@extensions.view({tag: SOURCE_TAG})`
 * list. The pipeline calls {@link resolve} for every entry in
 * `loopback.config.json.schemas[]`; the registry selects the right
 * {@link SchemaSource} based on the descriptor's scheme prefix and forwards
 * the fetch. The concrete `SchemaSource` implementations are being authored
 * by the schema-source agent in parallel — wiring is by extension-point
 * tag, so this registry needs no knowledge of their concrete types.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class SourceResolverRegistry {
  constructor(
    @inject.view(filterByTag(SOURCE_TAG))
    private readonly view: ContextView<SchemaSource>,
  ) {}

  /**
   * Resolve one descriptor to a list of {@link SchemaSourceResult}.
   *
   * A single descriptor can produce many files (e.g., a directory or a git
   * repo's `schemas/` folder). Wrapping each call in an array keeps the
   * downstream pipeline shape uniform regardless of source cardinality.
   *
   * @throws ContractsSourceError When no {@link SchemaSource} claims the
   *   descriptor's scheme prefix.
   */
  async resolve(
    descriptor: SchemaSourceDescriptor,
  ): Promise<SchemaSourceResult[]> {
    const scheme = detectScheme(descriptor);
    const all = await this.view.values();
    const match = all.find(s => s.scheme.toLowerCase() === scheme);
    if (!match) {
      throw new ContractsSourceError(
        `No SchemaSource registered for scheme '${scheme}' (descriptor: ${descriptor})`,
        {scheme, uri: descriptor},
      );
    }
    try {
      const result = await match.fetch(descriptor);
      return [result];
    } catch (cause) {
      throw new ContractsSourceError(
        `SchemaSource '${scheme}' failed to fetch '${descriptor}'`,
        {scheme, uri: descriptor},
        {cause},
      );
    }
  }

  /**
   * Resolve every descriptor in parallel. Aggregates results into a single
   * flat list (preserving descriptor order is left to callers that care —
   * stages 2/3 key by `$id` and source URL, not by array index).
   *
   * Uses `Promise.allSettled` so a single failing source does not orphan
   * every other in-flight fetch. If any descriptor fails the registry still
   * throws — partial source data must not leak into the downstream pipeline
   * — but the thrown {@link ContractsSourceError} carries every failure as
   * its `cause` (`AggregateError` when more than one descriptor failed).
   */
  async resolveAll(
    descriptors: readonly SchemaSourceDescriptor[],
  ): Promise<SchemaSourceResult[]> {
    const results = await Promise.allSettled(
      descriptors.map(d => this.resolve(d)),
    );
    const errors: unknown[] = [];
    for (const r of results) {
      if (r.status === 'rejected') errors.push(r.reason);
    }
    if (errors.length > 0) {
      const messages = errors
        .map(e => (e instanceof Error ? e.message : String(e)))
        .join('; ');
      throw new ContractsSourceError(
        `${errors.length} source(s) failed: ${messages}`,
        {scheme: 'aggregate', uri: '<multiple>'},
        {
          cause:
            errors.length === 1
              ? errors[0]
              : new AggregateError(errors, 'multiple source errors'),
        },
      );
    }
    return results.flatMap(
      r => (r as PromiseFulfilledResult<SchemaSourceResult[]>).value,
    );
  }
}

/**
 * Pick the scheme prefix from a descriptor. Recognises `<scheme>:`
 * (case-insensitive); `git+ssh://…` and `git+https://…` both fold to
 * `git+`; a bare path returns the `local` pseudo-scheme.
 */
function detectScheme(descriptor: SchemaSourceDescriptor): string {
  const trimmed = descriptor.trim();
  // git+<transport>://… — fold every git+* prefix to a single 'git+'.
  if (/^git\+/i.test(trimmed)) return 'git+';
  // <scheme>: prefix — capture letters/digits/+/-/.
  const m = /^([a-z][a-z0-9+\-.]*):/i.exec(trimmed);
  if (m && m[1] !== undefined) return m[1].toLowerCase();
  return LOCAL_SCHEME;
}
