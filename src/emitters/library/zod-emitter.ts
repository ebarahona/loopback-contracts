import {BindingScope, injectable} from '@loopback/core';
import {
  ContractsPeerDepMissingError,
  ContractsValidationError,
  toKebab,
  toPascal,
} from '../../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  LossyReport,
  ProjectionEmitter,
} from '../../interfaces';
import {ContractsBindings} from '../../keys';

/**
 * Lossy features the emitter promotes to hard errors in `--strict` mode.
 * The conversion library does the detection; this list is the policy gate.
 *
 * Keep entries here aligned with the feature labels the upstream library
 * reports so a new lossy translation gets caught the first time it appears
 * in a CI run rather than silently shipping.
 *
 * @see https://github.com/StefanTerdell/json-schema-to-zod
 */
const STRICT_LOSSY_FEATURES: ReadonlySet<string> = new Set([
  'z.brand',
  'z.lazy without explicit type',
  'oneOf without discriminator',
  'multipleOf precision loss',
]);

const PEER_DEP = 'json-schema-to-zod';

/**
 * Sidecar emitter that compiles a JSON Schema into a runtime-validated Zod
 * schema plus the inferred TS type. Used to share validators with TS
 * frontends or tRPC services without duplicating the source-of-truth schema.
 *
 * @experimental
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'zod',
  },
})
export class ZodEmitter implements ProjectionEmitter {
  readonly kind = 'zod';
  readonly outputSuffix = '.zod.ts';
  readonly tier = 'real-translation' as const;
  readonly description =
    'Zod sidecar (runtime validation, share with TS frontends / tRPC)';
  readonly peerDeps: string[] = [PEER_DEP];
  // Zod has no per-schema options today, but declaring the closed-object
  // shape keeps the emitter list uniform with siblings that DO take options
  // and gives a future contributor a single place to add fields without
  // re-typing the surrounding scaffolding. No `validateOptions` call here —
  // there is nothing to validate against an `additionalProperties: false`
  // schema when `options` is also empty.
  readonly perSchemaOptionsSchema = {
    type: 'object',
    additionalProperties: false,
  } as const;

  emit(ctx: EmitterContext): EmittedFile[] {
    const schemaId = ctx.schema.$id ?? '<no-$id>';
    const pascalName = toPascal(schemaId);
    const fileBase = toKebab(schemaId);

    const jsonSchemaToZod = loadJsonSchemaToZod();
    // `module: 'none'` already suppresses every `import` statement the
    // upstream renderer would emit (and prevents the `module.exports = ...`
    // wrapper); a separate `noImport` was redundant and is now dropped.
    // We prepend our own `import {z} from 'zod';` below so the file is
    // self-contained when consumers wire it into a TS pipeline.
    const zodSrc = jsonSchemaToZod(
      ctx.schema as Parameters<typeof jsonSchemaToZod>[0],
      {module: 'none'},
    );

    const content =
      `import {z} from 'zod';\n\n` +
      `export const ${pascalName}Schema = ${zodSrc};\n` +
      `export type ${pascalName} = z.infer<typeof ${pascalName}Schema>;\n`;

    return [
      {
        path: `models/${fileBase}.zod.ts`,
        content,
        policy: 'regen',
        producer: 'zod-emitter',
      },
    ];
  }

  validate(input: {schema: JSONSchema; lossy: LossyReport}): void {
    if (!STRICT_LOSSY_FEATURES.has(input.lossy.feature)) return;
    const schemaId =
      typeof input.schema.$id === 'string' ? input.schema.$id : '<unknown>';
    throw new ContractsValidationError(
      `Zod emitter rejected lossy translation '${input.lossy.feature}' ` +
        `on schema '${schemaId}': ${input.lossy.message}`,
      {
        sourcePath: schemaId,
        instancePath: input.lossy.source.propertyPath ?? '',
        ...(typeof input.schema.$id === 'string'
          ? {schemaId: input.schema.$id}
          : {}),
      },
    );
  }
}

// Signature of the relevant export from `json-schema-to-zod`. Declared
// locally so the public `.d.ts` surface stays free of an optional peer-dep
// type import (the peer is only required at emit time).
type JsonSchemaToZodFn = (
  schema: unknown,
  opts?: Record<string, unknown>,
) => string;

interface JsonSchemaToZodModule {
  jsonSchemaToZod: JsonSchemaToZodFn;
  default?: JsonSchemaToZodFn;
}

/**
 * Load the optional `json-schema-to-zod` peer-dep lazily and surface a
 * typed {@link ContractsPeerDepMissingError} when it is absent so the CLI
 * can prompt the user to `npm install` the right package.
 */
function loadJsonSchemaToZod(): JsonSchemaToZodFn {
  let mod: JsonSchemaToZodModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(PEER_DEP) as JsonSchemaToZodModule;
  } catch (err) {
    const code = (err as {code?: unknown} | null)?.code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new ContractsPeerDepMissingError({
        emitterKind: 'zod',
        packageName: PEER_DEP,
      });
    }
    throw err;
  }
  return (
    mod.jsonSchemaToZod ?? mod.default ?? (mod as unknown as JsonSchemaToZodFn)
  );
}
