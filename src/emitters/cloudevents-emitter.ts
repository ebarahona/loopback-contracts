import {BindingScope, injectable} from '@loopback/core';
import Ajv2020 from 'ajv/dist/2020';
import {resolve} from 'node:path';
import {
  ContractsPeerDepMissingError,
  ContractsValidationError,
  toKebab,
  toPascal,
} from '../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  ProjectionEmitter,
} from '../interfaces';
import {ContractsBindings} from '../keys';

/**
 * Per-schema options block the CloudEvents emitter reads from
 * `x-cloudevents` on the source schema. `type` is REQUIRED whenever the
 * schema opts in; the emitter skips schemas with no `x-cloudevents` block.
 *
 * @experimental
 */
export interface CloudEventsPerSchemaOptions {
  /** CloudEvents `type` attribute — typically reverse-DNS, e.g. `com.example.user.created`. */
  type: string;
  /** Default CloudEvents `source` for emitted events. */
  source?: string;
  /** Default CloudEvents `subject` for emitted events. */
  subject?: string;
}

const TEMPLATE_PATH = resolve(
  __dirname,
  '..',
  'templates',
  'cloudevents.ts.ejs',
);

/**
 * `@experimental` projection emitter producing typed `CloudEvent<T>` wrappers
 * and a `create<Name>Event` factory for every schema that opts in via an
 * `x-cloudevents` block. Schemas without the block are silently skipped — the
 * emitter is opt-in per schema and never speculates an event type.
 *
 * @experimental
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'cloudevents',
  },
})
export class CloudEventsEmitter implements ProjectionEmitter<CloudEventsPerSchemaOptions> {
  readonly kind = 'cloudevents';
  readonly outputSuffix = '.cloudevents.ts';
  readonly tier = 'real-translation' as const;
  readonly description =
    'Typed CloudEvent<T> wrappers (uses official cloudevents package)';
  readonly peerDeps = ['cloudevents'];
  readonly templatePaths = [TEMPLATE_PATH];
  readonly perSchemaOptionsSchema: JSONSchema = {
    type: 'object',
    properties: {
      type: {type: 'string'},
      source: {type: 'string'},
      subject: {type: 'string'},
    },
    required: ['type'],
  };

  emit(ctx: EmitterContext<CloudEventsPerSchemaOptions>): EmittedFile[] {
    const {schema, templates, options} = ctx;
    const xBlock = schema['x-cloudevents'];
    // Opt-in gate: this emitter contributes nothing unless EITHER the
    // schema declares an `x-cloudevents` object OR the caller supplies an
    // explicit non-empty `options` block. An empty object (`options ===
    // {}`) is treated as opt-out — without it, Ajv would otherwise reject
    // the missing required `type` and surface a validation error that
    // looks like a real misconfiguration to the user; we want the more
    // honest "nothing requested, nothing emitted" outcome.
    const noOptions =
      options === undefined ||
      options === null ||
      (typeof options === 'object' && Object.keys(options).length === 0);
    const noXBlock = xBlock === undefined || xBlock === null;
    if (noOptions && noXBlock) return [];

    // Validate `options` against the declared per-schema options schema so
    // `type` (and any future required fields) is enforced uniformly rather
    // than silently fabricated by the emitter. When `options` is empty
    // (treated as opt-out above unless `xBlock` is set), prefer `xBlock`
    // so the `type` declared on the schema is honoured.
    const validated = validateOptions<CloudEventsPerSchemaOptions>(
      this.kind,
      this.perSchemaOptionsSchema,
      noOptions ? xBlock : options,
    );

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('cloudevents');
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      if (err && err.code === 'MODULE_NOT_FOUND') {
        throw new ContractsPeerDepMissingError({
          emitterKind: 'cloudevents',
          packageName: 'cloudevents',
        });
      }
      throw cause;
    }

    const id = typeof schema.$id === 'string' ? schema.$id : 'anonymous';
    const baseName = id.replace(/\.v\d+$/, '');
    const Name = toPascal(baseName);
    const kebab = toKebab(baseName);
    const eventType = validated.type;
    // Sibling `<kebab>.types.ts` written by the types emitter; co-enabling
    // `--emit-types` is the documented happy path. The import is structural
    // and a missing file surfaces at `tsc --noEmit` rather than at codegen.
    const typesImport = `./${kebab}.types`;

    const content = templates.render(TEMPLATE_PATH, {
      name: Name,
      eventType,
      typesImport,
    });

    return [
      {
        path: `models/${kebab}.cloudevents.ts`,
        content,
        policy: 'regen',
        producer: 'cloudevents-emitter',
      },
    ];
  }
}

/**
 * Validate the per-schema options block against the emitter's declared
 * `perSchemaOptionsSchema` with Ajv 2020. Required-field violations (e.g.,
 * a missing `type`) raise a typed {@link ContractsValidationError} so the
 * CLI can render an actionable pointer instead of letting the emitter
 * fabricate a guess.
 */
function validateOptions<T>(
  kind: string,
  schema: JSONSchema | undefined,
  options: unknown,
): T {
  if (schema === undefined) return (options ?? {}) as T;
  const ajv = new Ajv2020({strict: false});
  const validate = ajv.compile(schema);
  const candidate = options ?? {};
  if (!validate(candidate)) {
    throw new ContractsValidationError(
      `Invalid options for ${kind} emitter: ${ajv.errorsText(validate.errors)}`,
      {
        sourcePath: `<schema x-${kind}>`,
        instancePath: validate.errors?.[0]?.instancePath ?? '',
      },
    );
  }
  return candidate as T;
}
