import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { mockSignOut, mockGetSession, mockFindAccountByUserId, mockRedirect } = vi.hoisted(() => ({
  mockSignOut: vi.fn(),
  mockGetSession: vi.fn(),
  mockFindAccountByUserId: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      signOut: mockSignOut,
      getSession: mockGetSession,
    },
    $context: Promise.resolve({
      internalAdapter: { findAccountByUserId: mockFindAccountByUserId },
    }),
  },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
}));

import { handleSignOut } from './actions';
import { rememberIdToken, __resetIdTokenStore } from '@/lib/id-token-store';

const GUID = 'ab12cd34-ef56-7890-abcd-ef1234567890';
const signedIn = { user: { id: 'user-1', userGuid: GUID } };

/** The URL handleSignOut redirected to, parsed. */
function redirectedTo(): URL {
  expect(mockRedirect).toHaveBeenCalledTimes(1);
  return new URL(mockRedirect.mock.calls[0][0] as string);
}

describe('handleSignOut', () => {
  const originalEnv = process.env;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetIdTokenStore();
    process.env = { ...originalEnv };
    process.env.MINISTRY_PLATFORM_BASE_URL = 'https://mp.example.com';
    process.env.BETTER_AUTH_URL = 'https://myapp.example.com';
    mockSignOut.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue(null);
    mockFindAccountByUserId.mockResolvedValue([]);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should call auth.api.signOut', async () => {
    await handleSignOut();

    expect(mockSignOut).toHaveBeenCalledWith({
      headers: expect.any(Headers),
    });
  });

  it('should redirect to MP end session URL', async () => {
    await handleSignOut();

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining('https://mp.example.com/oauth/connect/endsession')
    );
    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining('post_logout_redirect_uri=https%3A%2F%2Fmyapp.example.com')
    );
  });

  it('should throw when MINISTRY_PLATFORM_BASE_URL is missing', async () => {
    delete process.env.MINISTRY_PLATFORM_BASE_URL;

    await expect(handleSignOut()).rejects.toThrow('MINISTRY_PLATFORM_BASE_URL is not configured');
  });

  it('should fall back to NEXTAUTH_URL when BETTER_AUTH_URL is unset', async () => {
    delete process.env.BETTER_AUTH_URL;
    process.env.NEXTAUTH_URL = 'https://legacy.example.com';

    await handleSignOut();

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining('post_logout_redirect_uri=https%3A%2F%2Flegacy.example.com')
    );
  });

  it('should fall back to localhost when neither auth URL is configured', async () => {
    delete process.env.BETTER_AUTH_URL;
    delete process.env.NEXTAUTH_URL;

    await handleSignOut();

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining('post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A3000')
    );
  });

  describe('id_token_hint', () => {
    // Without it MP ignores post_logout_redirect_uri and leaves the user on its
    // own logged-out page. See src/lib/auth-endsession.ts.

    it('sends the ID token captured at sign-in', async () => {
      rememberIdToken(GUID, 'id.token.jwt');
      mockGetSession.mockResolvedValue(signedIn);

      await handleSignOut();

      const url = redirectedTo();
      expect(url.searchParams.get('id_token_hint')).toBe('id.token.jwt');
      expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://myapp.example.com');
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads the session BEFORE signing out, since signing out destroys it', async () => {
      rememberIdToken(GUID, 'id.token.jwt');
      mockGetSession.mockResolvedValue(signedIn);

      await handleSignOut();

      expect(mockGetSession.mock.invocationCallOrder[0]).toBeLessThan(
        mockSignOut.mock.invocationCallOrder[0]
      );
    });

    it('uses the stored token once, then forgets it', async () => {
      rememberIdToken(GUID, 'id.token.jwt');
      mockGetSession.mockResolvedValue(signedIn);

      await handleSignOut();
      mockRedirect.mockClear();
      await handleSignOut();

      expect(redirectedTo().searchParams.has('id_token_hint')).toBe(false);
    });

    it('falls back to the MP account record when nothing was stored', async () => {
      mockGetSession.mockResolvedValue(signedIn);
      mockFindAccountByUserId.mockResolvedValue([
        { providerId: 'some-other-provider', idToken: 'not.this.one' },
        { providerId: 'ministry-platform', idToken: 'from.account.record' },
      ]);

      await handleSignOut();

      expect(mockFindAccountByUserId).toHaveBeenCalledWith('user-1');
      expect(redirectedTo().searchParams.get('id_token_hint')).toBe('from.account.record');
    });

    it.each([
      ['no-session', null, []],
      ['no-mp-account', signedIn, [{ providerId: 'some-other-provider', idToken: 'x.y.z' }]],
      ['account-has-no-id-token', signedIn, [{ providerId: 'ministry-platform', idToken: null }]],
    ])('still signs out without the hint, and says why (%s)', async (reason, session, accounts) => {
      mockGetSession.mockResolvedValue(session);
      mockFindAccountByUserId.mockResolvedValue(accounts);

      await handleSignOut();

      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(redirectedTo().searchParams.has('id_token_hint')).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`id_token_hint omitted (${reason})`));
    });

    it('ignores a non-string userGuid on the session', async () => {
      rememberIdToken(GUID, 'id.token.jwt');
      mockGetSession.mockResolvedValue({ user: { id: 'user-1', userGuid: 42 } });

      await handleSignOut();

      expect(redirectedTo().searchParams.has('id_token_hint')).toBe(false);
    });

    it('never lets a failed lookup block sign-out', async () => {
      mockGetSession.mockRejectedValue(new TypeError('boom'));

      await handleSignOut();

      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(redirectedTo().searchParams.has('id_token_hint')).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('signout.id_token_lookup_failed'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('TypeError'));
      // The same "hint omitted" line as every other no-hint path, so one grep answers it.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('id_token_hint omitted (lookup-failed)'));
    });

    it('reports a thrown non-Error by its type', async () => {
      mockGetSession.mockRejectedValue('nope');

      await handleSignOut();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('"error":"string"'));
    });

    it('never logs the token itself', async () => {
      mockGetSession.mockResolvedValue(signedIn);
      mockFindAccountByUserId.mockRejectedValue(new Error('adapter down: from.account.record'));

      await handleSignOut();

      const logged = [...warn.mock.calls, ...error.mock.calls].flat().join(' ');
      expect(logged).not.toContain('from.account.record');
    });
  });
});
