import {describe, expect, it} from 'vitest';
import {redactUrl, redactUrlsInText} from '../../helpers';

describe('redactUrl', () => {
  it('redacts user:pass from an https URL', () => {
    expect(redactUrl('https://user:pass@host/p')).toBe(
      'https://[REDACTED]@host/p',
    );
  });

  it('preserves the git@ user on git+ssh URLs (not a credential)', () => {
    const out = redactUrl('git+ssh://git@host:repo.git');
    expect(out).toContain('git@host');
    expect(out).not.toContain('[REDACTED]');
  });

  it('redacts a password-only URL even when the user is empty', () => {
    expect(redactUrl('https://:secret@host/p')).toBe('https://host/p');
  });

  it('returns the input unchanged when no credentials are present', () => {
    expect(redactUrl('https://host/p')).toBe('https://host/p');
  });

  it('falls back to regex stripping for unparseable URLs', () => {
    // `ht!tp` is not a valid scheme, so the WHATWG parser rejects it; the
    // regex fallback should still strip the embedded credentials.
    const out = redactUrl('ht!tp://user:pass@host/p');
    expect(out).toBe('ht!tp://[REDACTED]@host/p');
  });

  it('regex fallback also preserves `git@` userinfo on unparseable URIs', () => {
    expect(redactUrl('git+ssh://git@host:repo.git')).toBe(
      'git+ssh://git@host:repo.git',
    );
  });
});

describe('redactUrlsInText', () => {
  it('redacts an inline credentialed URL inside a larger message', () => {
    const out = redactUrlsInText(
      'fatal: could not resolve https://u:p@h.com/x — retrying',
    );
    expect(out).toContain('https://[REDACTED]@h.com/x');
    expect(out).not.toContain('u:p@h.com');
  });

  it('leaves credential-free URLs untouched', () => {
    expect(redactUrlsInText('cloned from https://github.com/o/r.git')).toBe(
      'cloned from https://github.com/o/r.git',
    );
  });
});
