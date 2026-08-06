import { describe, it, expect } from 'vitest';
import { parseAuthLink } from './deepLink';

describe('parseAuthLink', () => {
  it('reads the code out of a confirmation link', () => {
    expect(parseAuthLink('app.nearside://auth/confirm?code=abc123')).toEqual({
      kind: 'confirm',
      status: 'ok',
      code: 'abc123',
    });
  });

  it('reads the code out of a recovery link', () => {
    expect(parseAuthLink('app.nearside://auth/recovery?code=xyz789')).toEqual({
      kind: 'recovery',
      status: 'ok',
      code: 'xyz789',
    });
  });

  it('tolerates a trailing slash on the path', () => {
    expect(parseAuthLink('app.nearside://auth/confirm/?code=abc123')).toEqual({
      kind: 'confirm',
      status: 'ok',
      code: 'abc123',
    });
  });

  it('surfaces an expired-link error from the query string', () => {
    const link = parseAuthLink(
      'app.nearside://auth/confirm?error=access_denied&error_code=otp_expired' +
        '&error_description=Email+link+is+invalid+or+has+expired'
    );
    expect(link).toEqual({
      kind: 'confirm',
      status: 'error',
      message: 'Email link is invalid or has expired',
    });
  });

  // GoTrue puts errors in the fragment on some paths and in the query on
  // others. A link the app cannot read is a user who is simply stuck, so both
  // are accepted rather than guessing which one this version emits.
  it('surfaces an error delivered in the fragment instead', () => {
    const link = parseAuthLink(
      'app.nearside://auth/recovery#error=access_denied&error_description=Token+has+expired'
    );
    expect(link).toEqual({
      kind: 'recovery',
      status: 'error',
      message: 'Token has expired',
    });
  });

  it('falls back to the error code when no description is given', () => {
    expect(parseAuthLink('app.nearside://auth/confirm?error=access_denied')).toEqual({
      kind: 'confirm',
      status: 'error',
      message: 'access_denied',
    });
  });

  it('ignores a link carrying neither a code nor an error', () => {
    expect(parseAuthLink('app.nearside://auth/confirm')).toBeNull();
  });

  it('ignores an unknown path under the auth host', () => {
    expect(parseAuthLink('app.nearside://auth/signup?code=abc123')).toBeNull();
  });

  it('ignores a different host on our own scheme', () => {
    expect(parseAuthLink('app.nearside://share?code=abc123')).toBeNull();
  });

  it('ignores a link from another scheme', () => {
    expect(parseAuthLink('https://example.com/auth/confirm?code=abc123')).toBeNull();
  });

  it('ignores a string that is not a URL at all', () => {
    expect(parseAuthLink('not a url')).toBeNull();
  });

  it('ignores an empty string', () => {
    expect(parseAuthLink('')).toBeNull();
  });
});
