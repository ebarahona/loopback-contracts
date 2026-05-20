import {describe, expect, it} from 'vitest';
import {ContractsSourceError} from '../../helpers';
import {parseNpmPackageName} from '../../sources/npm-source';

/**
 * Hardening guard for the `npm:<package>` descriptor parser. The validator
 * mirrors the npm registry's package-name grammar plus extra
 * defence-in-depth rejections (path traversal, URL chars, whitespace,
 * uppercase). It is a PURE function — exported only so we can pin every
 * rejection rule here without going through a full `fetch` cycle.
 *
 * Every negative case must throw `ContractsSourceError` AND carry the
 * offending descriptor in the message; the engine surfaces that message
 * verbatim to the operator.
 */
describe('parseNpmPackageName — positive cases', () => {
  it('accepts a plain unscoped name', () => {
    expect(parseNpmPackageName('lodash')).toBe('lodash');
  });

  it('accepts an unscoped name with digits, dots, dashes, underscores', () => {
    expect(parseNpmPackageName('a1.b-c_d')).toBe('a1.b-c_d');
  });

  it('accepts an unscoped name starting with an underscore', () => {
    // npm allows `_` as the leading character (e.g., legacy `_inherits`).
    expect(parseNpmPackageName('_legacy')).toBe('_legacy');
  });

  it('accepts an unscoped name starting with a digit', () => {
    expect(parseNpmPackageName('3d-mat')).toBe('3d-mat');
  });

  it('accepts a scoped name', () => {
    expect(parseNpmPackageName('@loopback/core')).toBe('@loopback/core');
  });

  it('accepts a scoped name with dots/dashes in scope and name', () => {
    expect(parseNpmPackageName('@my.org/some-pkg.v2')).toBe(
      '@my.org/some-pkg.v2',
    );
  });

  it('accepts a 214-character name (registry hard ceiling)', () => {
    const longName = 'a'.repeat(214);
    expect(parseNpmPackageName(longName)).toBe(longName);
  });
});

describe('parseNpmPackageName — negative cases', () => {
  it('rejects the empty string', () => {
    expect(() => parseNpmPackageName('')).toThrow(ContractsSourceError);
    expect(() => parseNpmPackageName('')).toThrow(/is empty/);
  });

  it('rejects whitespace-only input', () => {
    expect(() => parseNpmPackageName('   ')).toThrow(ContractsSourceError);
    expect(() => parseNpmPackageName('   ')).toThrow(/whitespace/);
  });

  it('rejects an embedded space', () => {
    expect(() => parseNpmPackageName('foo bar')).toThrow(/whitespace/);
  });

  it('rejects an embedded tab', () => {
    expect(() => parseNpmPackageName('foo\tbar')).toThrow(/whitespace/);
  });

  it('rejects path-traversal segment `..`', () => {
    expect(() => parseNpmPackageName('../../etc/passwd')).toThrow(
      ContractsSourceError,
    );
    expect(() => parseNpmPackageName('../../etc/passwd')).toThrow(
      /path-traversal/,
    );
  });

  it('rejects a name containing `..` even without a slash', () => {
    expect(() => parseNpmPackageName('foo..bar')).toThrow(/path-traversal/);
  });

  it('rejects a backslash (Windows-style traversal)', () => {
    expect(() => parseNpmPackageName('foo\\bar')).toThrow(/backslash/);
  });

  it('rejects a URL-like descriptor `https://...`', () => {
    expect(() => parseNpmPackageName('https://attacker.com/x')).toThrow(
      ContractsSourceError,
    );
    expect(() => parseNpmPackageName('https://attacker.com/x')).toThrow(
      /URL character/,
    );
  });

  it('rejects `?` (query character)', () => {
    expect(() => parseNpmPackageName('foo?bar')).toThrow(/URL character/);
  });

  it('rejects `#` (fragment character)', () => {
    expect(() => parseNpmPackageName('foo#bar')).toThrow(/URL character/);
  });

  it('rejects uppercase letters (hardening — registry tolerates legacy)', () => {
    expect(() => parseNpmPackageName('LoDash')).toThrow(ContractsSourceError);
    expect(() => parseNpmPackageName('LoDash')).toThrow(/lowercase/);
  });

  it('rejects an unscoped name with a leading dot', () => {
    expect(() => parseNpmPackageName('.npmrc')).toThrow(/may not start/);
  });

  it('rejects an unscoped name with a leading dash', () => {
    expect(() => parseNpmPackageName('-foo')).toThrow(/lowercase/);
  });

  it('rejects a leading `/` (absolute path bait)', () => {
    expect(() => parseNpmPackageName('/etc/passwd')).toThrow(/starts with/);
  });

  it('rejects an unscoped name containing `/`', () => {
    expect(() => parseNpmPackageName('foo/bar')).toThrow(/may not contain/);
  });

  it('rejects an empty scope `@/foo`', () => {
    expect(() => parseNpmPackageName('@/foo')).toThrow(/scope is empty/);
  });

  it('rejects a missing name after scope `@scope/`', () => {
    expect(() => parseNpmPackageName('@scope/')).toThrow(
      /name after scope is empty/,
    );
  });

  it('rejects a scoped name with no `/` separator', () => {
    expect(() => parseNpmPackageName('@scope')).toThrow(/missing '\/'/);
  });

  it('rejects more than one `/` in a scoped name', () => {
    expect(() => parseNpmPackageName('@scope/foo/bar')).toThrow(
      /more than one/,
    );
  });

  it('rejects a scope starting with `.`', () => {
    expect(() => parseNpmPackageName('@.bad/name')).toThrow(/scope must match/);
  });

  it('rejects a scope starting with `_`', () => {
    expect(() => parseNpmPackageName('@_bad/name')).toThrow(/scope must match/);
  });

  it('rejects uppercase inside a scoped name', () => {
    expect(() => parseNpmPackageName('@scope/FooBar')).toThrow(
      /name after scope must match/,
    );
  });

  it('rejects a 215-character name (one past the registry ceiling)', () => {
    const tooLong = 'a'.repeat(215);
    expect(() => parseNpmPackageName(tooLong)).toThrow(/214-character/);
  });

  it('attaches scheme=npm and uri=`npm:<raw>` to the thrown error', () => {
    // Pin the structured error shape — downstream consumers branch on
    // `err.scheme` / `err.code` rather than parsing the free-form message.
    try {
      parseNpmPackageName('../../etc/passwd');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractsSourceError);
      const se = err as ContractsSourceError;
      expect(se.code).toBe('CONTRACTS_SOURCE');
      expect(se.scheme).toBe('npm');
      expect(se.uri).toBe('npm:../../etc/passwd');
    }
  });
});
