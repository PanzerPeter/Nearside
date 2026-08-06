import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(), getLaunchUrl: vi.fn() } }));

const exchangeCodeForSession = vi.fn();
vi.mock('./supabase', () => ({
  supabase: { auth: { exchangeCodeForSession: (code: string) => exchangeCodeForSession(code) } },
}));

const { handleAuthLink, subscribeToAuthLinkError } = await import('./nativeAuthLinks');

describe('handleAuthLink', () => {
  beforeEach(() => {
    exchangeCodeForSession.mockReset();
    exchangeCodeForSession.mockResolvedValue({ error: null });
  });

  it('exchanges the code from a confirmation link', async () => {
    const handled = await handleAuthLink('app.nearside://auth/confirm?code=abc123');

    expect(handled).toBe(true);
    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc123');
  });

  it('exchanges the code from a recovery link', async () => {
    await handleAuthLink('app.nearside://auth/recovery?code=xyz789');

    expect(exchangeCodeForSession).toHaveBeenCalledWith('xyz789');
  });

  it('leaves links that are not ours alone', async () => {
    const handled = await handleAuthLink('https://example.com/whatever');

    expect(handled).toBe(false);
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('does not attempt an exchange for an expired link', async () => {
    await handleAuthLink(
      'app.nearside://auth/confirm?error=access_denied&error_description=Email+link+has+expired'
    );

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('reports an expired link to subscribers', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeToAuthLinkError((message) => seen.push(message));

    await handleAuthLink(
      'app.nearside://auth/confirm?error=access_denied&error_description=Email+link+has+expired'
    );
    unsubscribe();

    expect(seen).toEqual(['Email link has expired']);
  });

  it('reports a rejected exchange to subscribers', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: 'code challenge does not match' } });
    const seen: string[] = [];
    const unsubscribe = subscribeToAuthLinkError((message) => seen.push(message));

    await handleAuthLink('app.nearside://auth/confirm?code=abc123');
    unsubscribe();

    expect(seen).toEqual(['code challenge does not match']);
  });

  // A link tapped while the app was killed arrives at startup, before any
  // screen has mounted. Throwing there would take the app down on launch.
  it('survives an exchange that throws', async () => {
    exchangeCodeForSession.mockRejectedValue(new Error('offline'));
    const seen: string[] = [];
    const unsubscribe = subscribeToAuthLinkError((message) => seen.push(message));

    await expect(handleAuthLink('app.nearside://auth/confirm?code=abc123')).resolves.toBe(true);
    unsubscribe();

    expect(seen).toEqual(['offline']);
  });

  it('stops delivering to a subscriber that unsubscribed', async () => {
    const seen: string[] = [];
    subscribeToAuthLinkError((message) => seen.push(message))();

    await handleAuthLink('app.nearside://auth/confirm?error=access_denied');

    expect(seen).toEqual([]);
  });
});
