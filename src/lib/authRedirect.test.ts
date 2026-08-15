import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getPlatform = vi.fn();
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => getPlatform() } }));

const { authRedirectTo } = await import('./authRedirect');

describe('authRedirectTo', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  describe('on the device', () => {
    beforeEach(() => {
      getPlatform.mockReturnValue('android');
      // Capacitor serves the bundle from http://localhost, so an origin-based
      // redirect would send the user to a page that does not exist.
      (globalThis as { window?: unknown }).window = {
        location: { origin: 'http://localhost' },
      };
    });

    it('sends confirmation links to the app', () => {
      expect(authRedirectTo('confirm')).toBe('app.nearside://auth/confirm');
    });

    it('sends recovery links to the app', () => {
      expect(authRedirectTo('recovery')).toBe('app.nearside://auth/recovery');
    });
  });

  describe('on the web', () => {
    beforeEach(() => {
      getPlatform.mockReturnValue('web');
      (globalThis as { window?: unknown }).window = {
        location: { origin: 'https://nearside.example' },
      };
    });

    it('sends links back to the page they were requested from', () => {
      expect(authRedirectTo('confirm')).toBe('https://nearside.example');
      expect(authRedirectTo('recovery')).toBe('https://nearside.example');
    });
  });

  // Nothing calls this without a document today, but returning undefined lets
  // GoTrue fall back to the project's Site URL instead of mailing a link to
  // the string "undefined".
  it('yields no redirect when there is no window to return to', () => {
    getPlatform.mockReturnValue('web');
    expect(authRedirectTo('confirm')).toBeUndefined();
  });
});
