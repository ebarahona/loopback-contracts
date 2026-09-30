import {describe, expect, it} from 'vitest';
import {
  isPlainSchemaId,
  schemaNameStems,
  toKebab,
  toPascal,
} from '../../helpers';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FILE_SAFE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('isPlainSchemaId', () => {
  it('accepts identifier-shaped ids', () => {
    for (const id of ['appraisal-intake', 'customer.v1', 'order_item', 'A1']) {
      expect(isPlainSchemaId(id)).toBe(true);
    }
  });

  it('rejects URLs, URNs, paths and digit-leading ids', () => {
    for (const id of [
      'https://schemas.example.com/intake/1.0.0',
      'urn:acme:intake:v2',
      'schemas/customer.json',
      '1customer',
      '',
    ]) {
      expect(isPlainSchemaId(id)).toBe(false);
    }
  });
});

describe('schemaNameStems', () => {
  it('returns plain ids verbatim per style and ignores title', () => {
    const schema = {$id: 'customer.v1', title: 'Something Else'};
    expect(schemaNameStems(schema, 'full', 'x')).toEqual({
      typeStem: 'customer.v1',
      fileStem: 'customer.v1',
    });
    expect(schemaNameStems(schema, 'strip-version', 'x').typeStem).toBe(
      'customer',
    );
    expect(schemaNameStems(schema, 'head', 'x').typeStem).toBe('customer');
  });

  it('derives the type name from title and the file slug from the URL $id', () => {
    const stems = schemaNameStems(
      {
        $id: 'https://schemas.example.com/intake/1.0.0',
        title: 'AppraisalIntake',
      },
      'full',
      'x',
    );
    expect(toPascal(stems.typeStem)).toBe('AppraisalIntake');
    expect(toKebab(stems.fileStem)).toBe('intake-1-0-0');
  });

  it('falls back to the last non-version segment when there is no title', () => {
    const stems = schemaNameStems(
      {$id: 'https://schemas.example.com/intake/1.0.0'},
      'strip-version',
      'x',
    );
    expect(toPascal(stems.typeStem)).toBe('Intake');
  });

  it('keeps versions in the file slug so versions never collide', () => {
    const v1 = schemaNameStems(
      {$id: 'https://schemas.example.com/intake/1.0.0'},
      'head',
      'x',
    );
    const v2 = schemaNameStems(
      {$id: 'https://schemas.example.com/intake/2.0.0'},
      'head',
      'x',
    );
    expect(v1.fileStem).not.toBe(v2.fileStem);
  });

  it('always yields a valid identifier and a filesystem-safe slug', () => {
    const cases = [
      {$id: 'https://schemas.example.com/intake/1.0.0', title: 'Intake (v1)!'},
      {$id: 'urn:acme:intake:v2'},
      {$id: 'https://example.com/schemas/customer.schema.json'},
      {$id: 'https://example.com/'},
      {$id: 'https://example.com/1.0.0'},
      {$id: '1customer'},
      {$id: 'schemas/Évaluation.json', title: 'Évaluation'},
    ];
    for (const schema of cases) {
      const {typeStem, fileStem} = schemaNameStems(schema, 'full', 'fb');
      expect(toPascal(typeStem)).toMatch(IDENTIFIER);
      expect(toKebab(fileStem)).toMatch(FILE_SAFE);
    }
    expect(
      toKebab(
        schemaNameStems(
          {$id: 'https://example.com/schemas/customer.schema.json'},
          'full',
          'fb',
        ).fileStem,
      ),
    ).toBe('schemas-customer');
    expect(
      toPascal(
        schemaNameStems(
          {$id: 'schemas/x.json', title: 'Évaluation'},
          'full',
          '',
        ).typeStem,
      ),
    ).toBe('Evaluation');
  });

  it('uses the fallback when the schema has no $id', () => {
    expect(schemaNameStems({}, 'full', 'fixture')).toEqual({
      typeStem: 'fixture',
      fileStem: 'fixture',
    });
  });
});

describe('schemaNameStems collision handling (peers)', () => {
  const names = (
    peers: ReadonlyArray<{$id: string; title?: string}>,
    style: 'full' | 'head' | 'strip-version' = 'full',
  ): Array<[string, string]> =>
    peers.map(p => {
      const s = schemaNameStems(p, style, '', peers);
      return [toPascal(s.typeStem), toKebab(s.fileStem)];
    });

  it('leaves unique names untouched', () => {
    const peers = [
      {$id: 'https://a.example.com/x/address', title: 'Address'},
      {$id: 'https://a.example.com/x/customer', title: 'Customer'},
    ];
    expect(names(peers)).toEqual([
      ['Address', 'x-address'],
      ['Customer', 'x-customer'],
    ]);
  });

  it('adds the host to file stems that differ only by host', () => {
    const peers = [
      {$id: 'https://a.example.com/x/address', title: 'Address'},
      {$id: 'https://b.example.com/x/address', title: 'Address'},
    ];
    expect(names(peers)).toEqual([
      ['AExampleComXAddress', 'a-example-com-x-address'],
      ['BExampleComXAddress', 'b-example-com-x-address'],
    ]);
  });

  it('qualifies same-titled type names by path, keeping files', () => {
    const peers = [
      {$id: 'https://a.example.com/x/address', title: 'Address'},
      {$id: 'https://b.example.com/y/address', title: 'Address'},
      {$id: 'https://s.example.com/intake/1.0.0', title: 'Intake'},
      {$id: 'https://s.example.com/intake/2.0.0', title: 'Intake'},
    ];
    expect(names(peers)).toEqual([
      ['XAddress', 'x-address'],
      ['YAddress', 'y-address'],
      ['Intake100', 'intake-1-0-0'],
      ['Intake200', 'intake-2-0-0'],
    ]);
  });

  it('never renames a plain id; the URL id yields', () => {
    const peers = [
      {$id: 'address'},
      {$id: 'https://a.example.com/address', title: 'Address'},
    ];
    expect(names(peers)).toEqual([
      ['Address', 'address'],
      ['AExampleComAddress', 'a-example-com-address'],
    ]);
  });

  it('falls back to a hash suffix when the host does not help', () => {
    const peers = [
      {$id: 'urn:acme:address', title: 'A'},
      {$id: 'urn:acme:address#', title: 'B'},
    ];
    const [a, b] = names(peers);
    expect(a?.[1]).toMatch(/^acme-address-[0-9a-f]{8}$/);
    expect(b?.[1]).toMatch(/^acme-address-[0-9a-f]{8}$/);
    expect(a?.[1]).not.toBe(b?.[1]);
    if (!a || !b) throw new Error('expected names for both peers');
    for (const [type, file] of [a, b]) {
      expect(type).toMatch(IDENTIFIER);
      expect(file).toMatch(FILE_SAFE);
    }
  });

  it('is independent of peer order', () => {
    const peers = [
      {$id: 'https://a.example.com/x/address', title: 'Address'},
      {$id: 'https://b.example.com/x/address', title: 'Address'},
      {$id: 'https://s.example.com/intake/1.0.0', title: 'Intake'},
    ];
    const forward = new Map(
      peers.map(p => [p.$id, schemaNameStems(p, 'full', '', peers)]),
    );
    const reversed = [...peers].reverse();
    for (const p of reversed) {
      expect(schemaNameStems(p, 'full', '', reversed)).toEqual(
        forward.get(p.$id),
      );
    }
  });

  it('reserves plain names under the requested style', () => {
    const peers = [
      {$id: 'user.v1'},
      {$id: 'https://a.example.com/people/user', title: 'User'},
    ];
    const [plain, url] = names(peers, 'strip-version');
    expect(plain).toEqual(['User', 'user']);
    expect(url?.[0]).toBe('PeopleUser');
  });
});
