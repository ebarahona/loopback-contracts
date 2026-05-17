import {describe, expect, it} from 'vitest';
import {interpolatePath} from '../../engine/manifest-path-template';
import type {PathInterpolationContext} from '../../engine/manifest-path-template';
import {ContractsCodegenError} from '../../helpers';

const CTX: PathInterpolationContext = {
  kebabName: 'customer-v1',
  pascalName: 'CustomerV1',
  camelName: 'customerV1',
  snakeName: 'customer_v1',
  kind: 'create-dto',
};

describe('interpolatePath', () => {
  it('substitutes a single known variable', () => {
    expect(interpolatePath('models/{{kebabName}}.ts', CTX)).toBe(
      'models/customer-v1.ts',
    );
  });

  it('substitutes every supported variable', () => {
    expect(interpolatePath('{{kebabName}}', CTX)).toBe('customer-v1');
    expect(interpolatePath('{{pascalName}}', CTX)).toBe('CustomerV1');
    expect(interpolatePath('{{camelName}}', CTX)).toBe('customerV1');
    expect(interpolatePath('{{snakeName}}', CTX)).toBe('customer_v1');
    expect(interpolatePath('{{kind}}', CTX)).toBe('create-dto');
  });

  it('substitutes multiple placeholders in one template', () => {
    expect(
      interpolatePath('dto/{{kebabName}}/{{pascalName}}.{{kind}}.ts', CTX),
    ).toBe('dto/customer-v1/CustomerV1.create-dto.ts');
  });

  it('tolerates whitespace inside placeholders', () => {
    expect(interpolatePath('models/{{ kebabName }}.ts', CTX)).toBe(
      'models/customer-v1.ts',
    );
  });

  it('leaves text without {{var}} placeholders unchanged', () => {
    expect(interpolatePath('models/static.ts', CTX)).toBe('models/static.ts');
    expect(interpolatePath('', CTX)).toBe('');
  });

  it('throws ContractsCodegenError on an unknown variable', () => {
    expect(() => interpolatePath('models/{{unknown}}.ts', CTX)).toThrow(
      ContractsCodegenError,
    );
    expect(() => interpolatePath('models/{{unknown}}.ts', CTX)).toThrow(
      /unknown variable '\{\{unknown\}\}'/,
    );
  });

  it('throws ContractsCodegenError on an empty placeholder', () => {
    expect(() => interpolatePath('models/{{}}.ts', CTX)).toThrow(
      ContractsCodegenError,
    );
    expect(() => interpolatePath('models/{{ }}.ts', CTX)).toThrow(
      ContractsCodegenError,
    );
  });

  it('reports the emitter kind in the thrown error', () => {
    try {
      interpolatePath('models/{{unknown}}.ts', CTX);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractsCodegenError);
      expect((err as ContractsCodegenError).emitterKind).toBe(
        'manifest:create-dto',
      );
    }
  });
});
