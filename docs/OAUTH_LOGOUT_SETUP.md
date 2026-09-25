# OAuth Logout Configuration for Ministry Platform

## Current Status
✅ Server-side sign-out via the `handleSignOut()` server action
✅ OIDC RP-initiated logout implemented (Option A below), with `id_token_hint`
⚠️ Requires a **Post-Logout Redirect URI** registered on the MP OAuth client

## What's Working
- Better Auth session cookie cleared server-side by `auth.api.signOut()`
- The browser is then redirected to Ministry Platform's `end_session` endpoint,
  which ends the MP OAuth (SSO) session
- The redirect carries `id_token_hint`, which is what makes MP honour
  `post_logout_redirect_uri` (see below)
- MP redirects back to the app, which now has no session, so `src/proxy.ts`
  sends the user to `/signin`

## Implementation

Three pieces:

- **`src/lib/id-token-store.ts`** — `getUserInfo` in `src/lib/auth.ts` parks
  `tokens.idToken` here at sign-in, keyed by the validated `sub` (the
  `userGuid`). Process-wide (`globalThis`), bounded, expiring, and read once.
- **`src/lib/auth-endsession.ts`** — `buildEndSessionUrl()` builds
  `${MINISTRY_PLATFORM_BASE_URL}/oauth/connect/endsession` with
  `post_logout_redirect_uri` and, when available, `id_token_hint`.
- **`src/components/user-menu/actions.ts`** — `handleSignOut()`:

```typescript
export async function handleSignOut() {
  const requestHeaders = await headers();

  // Read the hint while the session still exists — signing out destroys it.
  const idToken = await findMpIdToken(requestHeaders); // store first, account record as fallback; never throws

  await auth.api.signOut({ headers: requestHeaders });

  const baseUrl = process.env.MINISTRY_PLATFORM_BASE_URL;
  if (!baseUrl) {
    throw new Error('MINISTRY_PLATFORM_BASE_URL is not configured');
  }

  redirect(
    buildEndSessionUrl({
      baseUrl,
      postLogoutUri: process.env.BETTER_AUTH_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000',
      idToken,
    }),
  );
}
```

Callers: the user menu (`src/components/user-menu/user-menu.tsx`) and the
broken-session recovery page (`src/app/session-error/page.tsx`), which wires it to
a plain `<form action={handleSignOut}>` so a user with an unusable session can
still get out. (That path cannot send `id_token_hint` — the session has no
`userGuid` to look the token up by — so the user ends up on MP's logged-out
page. Signing out is what matters there.)

### Sign-out is server-side only

`POST /api/auth/sign-out` is **not** in `allowedAuthRoutes`
(`src/app/api/auth/[...all]/route.ts`), so `authClient.signOut()` from the
browser returns 404. That is deliberate: sign-out runs in-process through
`auth.api.signOut()`, so no HTTP sign-out route is needed, and the 404 makes an
accidental client-side call loud instead of a silent no-op. If a client-side
sign-out is ever genuinely required, add the path to the allowlist first.

### `id_token_hint` is required for the return trip

`id_token_hint` is optional in the OIDC RP-initiated logout spec, and MP does
end its session without it. But MP runs IdentityServer, which honours
`post_logout_redirect_uri` **only** when the hint identifies the client.
Without it, MP discards the redirect and leaves the user on its own logged-out
page (which serves `window.returnUrl = ""`). With it, MP sends the user back.

The token comes from `src/lib/id-token-store.ts` first, with the account record
only as a fallback. With the JWT cookie cache and the in-memory adapter, the
account lookup runs in a different module instance from the one sign-in wrote
to and finds nothing — which is also why better-auth 1.7's own provider-logout
URL is not used: `auth.api.signOut()` finds no session or account in that
instance and returns no URL at all.

The server action can read the session only from the JWT cookie cache, which
lasts an hour. So the user menu calls `GET /api/auth/get-session` just before
`handleSignOut()`: that runs in the auth route, which holds the session, and
re-issues the cookie.

If no token is available — a session that predates a restart, say — sign-out
still works without the hint, and the server logs
`[signout] id_token_hint omitted (<reason>)`. If a user is stranded on MP's page
and that line is **absent**, the app sent the hint and the remaining problem is
the Post-Logout Redirect URI registration below.

## Ministry Platform OAuth Configuration

Register **Post-Logout Redirect URIs** on the MP OAuth client (the one named by
`OIDC_CLIENT_ID`). The value sent is `BETTER_AUTH_URL` verbatim — an origin with
**no trailing slash and no path** — so that exact string must be registered.

**Production:**
```
https://yourdomain.com
```

**Development:**
```
http://localhost:3000
```

Without this, MP rejects the `post_logout_redirect_uri` and the user is left on
an MP error page, or is auto-logged back in on the next sign-in (SSO behavior).

## Environment Variables

```env
MINISTRY_PLATFORM_BASE_URL=https://your-mp-instance.com/ministryplatformapi
BETTER_AUTH_URL=https://yourdomain.com  # Production
BETTER_AUTH_URL=http://localhost:3000   # Development
```

`handleSignOut()` throws if `MINISTRY_PLATFORM_BASE_URL` is unset.
`BETTER_AUTH_URL` falls back to `NEXTAUTH_URL`, then to `http://localhost:3000`
— in production, set `BETTER_AUTH_URL` explicitly, or sign-out will try to send
users to localhost.

## Testing

Unit coverage: `src/components/user-menu/actions.test.ts` pins the
`auth.api.signOut` call, the end-session redirect, the `NEXTAUTH_URL` and
localhost fallbacks, the missing-`MINISTRY_PLATFORM_BASE_URL` throw, and the
`id_token_hint` lookup (store first, account-record fallback, read before
sign-out, never blocking sign-out, never logged). `src/lib/auth-endsession.test.ts`
and `src/lib/id-token-store.test.ts` cover the URL builder and the store, and
`src/auth.test.ts` asserts `getUserInfo` captures the token.

**Manual (the only thing that exercises MP):**
1. Sign in to the application
2. Click "Sign out"
3. You should bounce through Ministry Platform briefly, then back to the app.
   If you are left on MP's logged-out page, check the server log for
   `[signout] id_token_hint omitted` (see above)
4. You land on `/signin`, which immediately restarts the OAuth flow
5. MP should now ask for credentials rather than signing you straight back in —
   if it does not, the MP session was not ended (check the post-logout redirect
   URI registration)

## References
- [OpenID Connect RP-Initiated Logout Spec](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
- [Better Auth Documentation](https://www.better-auth.com/docs)
- [Auth Reference](../.claude/references/auth.md) — § Logout Flow

## Alternative considered: local-only logout

Clearing only the Better Auth cookie and skipping the MP end-session redirect is
simpler, but leaves the MP SSO session alive — the next visit to `/signin`
signs the user straight back in without a credential prompt. **Not used here.**
Sign-out must mean signed out at both the application and the identity provider.
