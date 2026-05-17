import {ContractsCodegenError} from '../helpers';

/**
 * Variables an {@link EmitterManifestOutput.path} template can interpolate.
 *
 * The set is intentionally small and fixed — manifest authors render one
 * output path per schema, and the engine derives every value from the
 * source schema's `$id` (kebab/pascal/camel/snake of the stem) plus the
 * manifest's own `kind`. Adding a new variable requires widening this
 * interface so consumers get a compile-time signal.
 *
 * @internal
 */
export interface PathInterpolationContext {
  /** Schema `$id` stem in `kebab-case` (e.g. `customer-v1`). */
  readonly kebabName: string;
  /** Schema `$id` stem in `PascalCase` (e.g. `CustomerV1`). */
  readonly pascalName: string;
  /** Schema `$id` stem in `camelCase` (e.g. `customerV1`). */
  readonly camelName: string;
  /** Schema `$id` stem in `snake_case` (e.g. `customer_v1`). */
  readonly snakeName: string;
  /** Manifest emitter `kind` (e.g. `create-dto`). */
  readonly kind: string;
}

/**
 * Regex matching every `{{...}}` placeholder in an output-path template.
 *
 * Captures the raw token between the braces (including leading and
 * trailing whitespace) so we can validate it precisely and report the
 * exact source text in error messages. Whitespace-trimming and
 * empty-token rejection happen in {@link interpolatePath}; keeping the
 * regex permissive lets us catch malformed placeholders explicitly
 * instead of silently passing them through.
 */
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

/**
 * Interpolate `{{var}}` placeholders in an emitter output-path template
 * against a fixed context derived from the current schema.
 *
 * Grammar: a placeholder is exactly `{{<name>}}`. Whitespace inside the
 * braces (e.g. `{{ kind }}`) is tolerated. Unknown variable names and
 * empty placeholders (`{{}}` / `{{ }}`) throw
 * {@link ContractsCodegenError} so manifest authors get a precise error
 * instead of a silently-broken output path.
 *
 * Escaping: there is no escape syntax at v1. A template that needs a
 * literal `{{` followed by `}}` in the output filename is not supported;
 * such filenames are vanishingly rare in real codebases and the cost of
 * an escape grammar outweighs the benefit. Revisit if a real use-case
 * emerges.
 *
 * @internal
 */
export function interpolatePath(
  template: string,
  ctx: PathInterpolationContext,
): string {
  return template.replace(PLACEHOLDER_RE, (_match, rawToken: string) => {
    const name = rawToken.trim();
    if (name.length === 0) {
      throw new ContractsCodegenError(
        `Manifest output path template '${template}' contains an empty ` +
          `'{{}}' placeholder`,
        {emitterKind: `manifest:${ctx.kind}`, schemaId: '<unknown>'},
      );
    }
    if (!isKnownVar(name)) {
      throw new ContractsCodegenError(
        `Manifest output path template '${template}' references unknown ` +
          `variable '{{${name}}}' (known: kebabName, pascalName, camelName, ` +
          `snakeName, kind)`,
        {emitterKind: `manifest:${ctx.kind}`, schemaId: '<unknown>'},
      );
    }
    return ctx[name];
  });
}

/**
 * Type-guard for the closed set of variable names {@link interpolatePath}
 * recognises. Centralised so the runtime check and the error message stay
 * in sync.
 */
function isKnownVar(name: string): name is keyof PathInterpolationContext {
  return (
    name === 'kebabName' ||
    name === 'pascalName' ||
    name === 'camelName' ||
    name === 'snakeName' ||
    name === 'kind'
  );
}
