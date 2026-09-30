// End-to-end regression for two Zod-sidecar bugs, driven through the BUILT
// `bin/lb-contracts.js`:
//
//   1. Cross-schema `$ref` rendered as `z.any()` instead of importing the
//      referenced schema's generated export.
//   2. URL-style `$id`s (`https://schemas.example.com/intake/1.0.0`)
//      produced invalid identifiers (`export const Https://…Schema`) and
//      `:`-bearing output paths.
//
// The generated `.zod.ts` files are transpiled and required against the
// repo's own `zod` so the test proves the referenced schema actually
// validates, not just that the text looks right.

import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {ModuleKind, ScriptTarget, transpileModule} from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const PLUGIN_ROOT = resolve(__dirname, '..', '..', '..');
const BIN = join(PLUGIN_ROOT, 'bin', 'lb-contracts.js');
const DIST_ENTRY = join(PLUGIN_ROOT, 'dist', 'cli', 'index.js');
const SUITE_ROOT = join(
  tmpdir(),
  `lb-contracts-zod-refs-${randomBytes(6).toString('hex')}`,
);

const ADDRESS = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://schemas.example.com/address/1.0.0',
  title: 'Address',
  type: 'object',
  properties: {
    street: {type: 'string'},
    zip: {type: 'string', pattern: '^[0-9]{5}$'},
  },
  required: ['street', 'zip'],
};

const INTAKE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://schemas.example.com/intake/1.0.0',
  title: 'AppraisalIntake',
  type: 'object',
  properties: {
    name: {type: 'string'},
    home: {$ref: 'https://schemas.example.com/address/1.0.0'},
    work: {$ref: '../address/1.0.0'},
    tag: {$ref: '#/$defs/tag'},
  },
  required: ['name', 'home'],
  $defs: {tag: {type: 'string', minLength: 2}},
};

beforeAll(() => {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      `dist/cli/index.js missing — run \`npm run build\` before \`npm test\`. ` +
        `Missing: ${DIST_ENTRY}`,
    );
  }
  mkdirSync(SUITE_ROOT, {recursive: true});
});

afterAll(() => {
  rmSync(SUITE_ROOT, {recursive: true, force: true});
});

function seedProject(
  label: string,
  schemas: readonly object[],
  sidecars: readonly string[] = ['zod', 'types', 'openapi-components'],
): string {
  const root = join(SUITE_ROOT, label);
  mkdirSync(join(root, 'schemas'), {recursive: true});
  mkdirSync(join(root, 'configs'), {recursive: true});
  symlinkSync(join(PLUGIN_ROOT, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(
    join(root, 'loopback.config.json'),
    JSON.stringify({
      name: 't',
      schemasDir: './schemas',
      configsDir: './configs',
      validator: 'zod',
      schemas: ['./schemas'],
      emit: {
        ...Object.fromEntries(sidecars.map(kind => [kind, true])),
        model: false,
        repository: false,
        controller: false,
        datasource: false,
      },
      security: {codegen: {runTsc: false}},
    }),
  );
  schemas.forEach((schema, i) => {
    writeFileSync(
      join(root, 'schemas', `s${i}.schema.json`),
      JSON.stringify(schema),
    );
  });
  return root;
}

function runGen(root: string, args: readonly string[]) {
  const r = spawnSync('node', [BIN, 'gen', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return {status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`};
}

describe('lb-contracts gen: Zod $ref + URL $id', () => {
  it('emits safe names and a Zod sidecar that validates through the ref', () => {
    const root = seedProject('esm', [ADDRESS, INTAKE]);
    const result = runGen(root, ['--esm']);
    expect(result.output).not.toContain('Pipeline failed');
    expect(result.status).toBe(0);

    const models = join(root, 'src', 'models');
    expect(readdirSync(models).sort()).toEqual([
      'address-1-0-0.openapi-components.yaml',
      'address-1-0-0.types.ts',
      'address-1-0-0.zod.ts',
      'intake-1-0-0.openapi-components.yaml',
      'intake-1-0-0.types.ts',
      'intake-1-0-0.zod.ts',
    ]);

    const intakeSrc = readFileSync(join(models, 'intake-1-0-0.zod.ts'), 'utf8');
    expect(intakeSrc).toContain(
      "import {AddressSchema} from './address-1-0-0.zod.js';",
    );
    expect(intakeSrc).toContain('export const AppraisalIntakeSchema =');
    expect(intakeSrc).not.toContain('z.any()');

    // Transpile both sidecars next to their sources (`.zod.js`, the
    // specifier the ESM pass wrote) and run them against real Zod.
    for (const base of ['address-1-0-0', 'intake-1-0-0']) {
      const src = readFileSync(join(models, `${base}.zod.ts`), 'utf8');
      const js = transpileModule(src, {
        compilerOptions: {
          module: ModuleKind.CommonJS,
          target: ScriptTarget.ES2022,
        },
      }).outputText;
      writeFileSync(join(models, `${base}.zod.js`), js);
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(join(models, 'intake-1-0-0.zod.js')) as {
      AppraisalIntakeSchema: {safeParse(v: unknown): {success: boolean}};
    };
    const schema = mod.AppraisalIntakeSchema;
    const home = {street: '1 Main St', zip: '33101'};
    expect(schema.safeParse({name: 'Ed', home}).success).toBe(true);
    expect(
      schema.safeParse({name: 'Ed', home: {street: 'x', zip: 'nope'}}).success,
    ).toBe(false);
    expect(
      schema.safeParse({name: 'Ed', home, work: {street: 'x'}}).success,
    ).toBe(false);
  });

  it('rejects a dangling local pointer at stage 4, strict or not', () => {
    const broken = {
      ...INTAKE,
      properties: {...INTAKE.properties, bad: {$ref: '#/$defs/missing'}},
    };
    // Stage 4 validates JSON Pointer fragments, so no emitter sees the
    // dangling ref; the emitters' `unresolved-$ref` lossy path covers
    // programmatic use and is exercised by the unit specs.
    for (const [name, flags] of [
      ['lenient', []],
      ['strict', ['--strict']],
    ] as const) {
      const result = runGen(seedProject(name, [ADDRESS, broken], ['zod']), [
        ...flags,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("has no '#/$defs/missing'");
    }
  });
});

describe('lb-contracts gen: name collisions', () => {
  const A = {
    $id: 'https://a.example.com/x/address',
    title: 'Address',
    type: 'object',
    properties: {city: {type: 'string'}},
    required: ['city'],
  };
  const B = {
    $id: 'https://b.example.com/x/address',
    title: 'Address',
    type: 'object',
    properties: {zip: {type: 'string'}},
  };
  const C = {
    $id: 'https://b.example.com/y/address',
    title: 'Address',
    type: 'object',
    properties: {a: {$ref: 'https://a.example.com/x/address'}},
  };

  it('gives same-title and same-path schemas distinct files and names', () => {
    const root = seedProject(
      'collide',
      [A, B, C],
      ['zod', 'types', 'openapi-components', 'mongodb'],
    );
    const result = runGen(root, []);
    expect(result.output).not.toContain('Pipeline failed');
    expect(result.status).toBe(0);

    const models = join(root, 'src', 'models');
    const stems = new Set(readdirSync(models).map(f => f.split('.')[0]));
    expect([...stems].sort()).toEqual([
      'a-example-com-x-address',
      'b-example-com-x-address',
      'y-address',
    ]);

    // OpenAPI: one component key per schema, and C's ref targets A.
    const keys = [...stems].map(stem => {
      const yaml = readFileSync(
        join(models, `${stem}.openapi-components.yaml`),
        'utf8',
      );
      return /^ {4}(\w+):/m.exec(yaml)?.[1];
    });
    expect(new Set(keys).size).toBe(3);
    const cYaml = readFileSync(
      join(models, 'y-address.openapi-components.yaml'),
      'utf8',
    );
    expect(cYaml).toContain('    YAddress:');
    expect(cYaml).toContain("$ref: '#/components/schemas/AExampleComXAddress'");
    expect(
      readFileSync(
        join(models, 'a-example-com-x-address.openapi-components.yaml'),
        'utf8',
      ),
    ).toContain('    AExampleComXAddress:');

    // Zod: C imports A's export by its disambiguated name.
    const cZod = readFileSync(join(models, 'y-address.zod.ts'), 'utf8');
    expect(cZod).toContain(
      "import {AExampleComXAddressSchema} from './a-example-com-x-address.zod';",
    );
    expect(cZod).toContain('export const YAddressSchema =');
  });

  it('names both schemas when two plain ids map to one file', () => {
    const root = seedProject(
      'plain-collide',
      [
        {$id: 'user.v1', type: 'object'},
        {$id: 'user-v1', type: 'object'},
      ],
      ['zod'],
    );
    const result = runGen(root, []);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "Two emitters target the same output path 'models/user-v1.zod.ts'",
    );
    expect(result.output).toMatch(/schema 'user\.v1'/);
    expect(result.output).toMatch(/schema 'user-v1'/);
    expect(result.output).not.toContain('<unknown>');
  });
});

describe('lb-contracts gen: Zod $ref cycles at runtime', () => {
  // A -> B -> C -> B: B and C are mutually recursive, A enters the cycle.
  const base = 'https://cycle.example.com';
  const CYCLE = [
    {
      $id: `${base}/a`,
      title: 'A',
      type: 'object',
      properties: {b: {$ref: `${base}/b`}},
    },
    {
      $id: `${base}/b`,
      title: 'B',
      type: 'object',
      properties: {name: {type: 'string'}, c: {$ref: `${base}/c`}},
    },
    {
      $id: `${base}/c`,
      title: 'C',
      type: 'object',
      properties: {b: {$ref: `${base}/b`}},
    },
  ];
  const PROBE = [
    {b: {name: 'x', c: {b: {name: 'y', c: {}}}}},
    {b: {name: 'x', c: {b: {name: 1}}}},
  ];

  // Transpile every sidecar to `ext`, then import A in a fresh Node
  // process (so the module graph, not the test runner, resolves the cycle)
  // and print the two `safeParse` results.
  function probe(
    models: string,
    kind: ModuleKind,
    ext: string,
    load: string,
  ): string {
    for (const f of readdirSync(models).filter(n => n.endsWith('.zod.ts'))) {
      const js = transpileModule(readFileSync(join(models, f), 'utf8'), {
        compilerOptions: {module: kind, target: ScriptTarget.ES2022},
      }).outputText;
      writeFileSync(join(models, f.replace(/\.ts$/, ext)), js);
    }
    const script =
      `${load}` +
      `const probe = ${JSON.stringify(PROBE)};` +
      `console.log(JSON.stringify(probe.map(v => m.ASchema.safeParse(v).success)));`;
    const r = spawnSync(
      'node',
      [
        kind === ModuleKind.ESNext
          ? '--input-type=module'
          : '--input-type=commonjs',
        '-e',
        script,
      ],
      {cwd: models, encoding: 'utf8'},
    );
    expect(r.stderr).toBe('');
    return r.stdout.trim();
  }

  it('loads and validates under CommonJS', () => {
    const root = seedProject('cycle-cjs', CYCLE, ['zod']);
    expect(runGen(root, []).status).toBe(0);
    const models = join(root, 'src', 'models');
    expect(
      probe(
        models,
        ModuleKind.CommonJS,
        '.js',
        "const m = require('./a.zod');",
      ),
    ).toBe('[true,false]');
  });

  it('loads and validates under ESM', () => {
    const root = seedProject('cycle-esm', CYCLE, ['zod']);
    expect(runGen(root, ['--esm']).status).toBe(0);
    const models = join(root, 'src', 'models');
    writeFileSync(join(models, 'package.json'), '{"type": "module"}');
    expect(
      probe(
        models,
        ModuleKind.ESNext,
        '.js',
        "const m = await import('./a.zod.js');",
      ),
    ).toBe('[true,false]');
  });
});
