'use server';

import { auth } from "@/lib/auth";
import { buildEndSessionUrl, MP_PROVIDER_ID } from "@/lib/auth-endsession";
import { takeIdToken } from "@/lib/id-token-store";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Finds the signed-in user's OIDC ID token, for `id_token_hint` on the
 * end-session request. See `src/lib/auth-endsession.ts` for why that parameter
 * is load-bearing.
 *
 * NEVER THROWS. Sign-out must not depend on this succeeding. A session that
 * predates a restart has no stored token, and that is a normal state rather
 * than an error. So is `no-session` if the JWT cookie cache has lapsed: this
 * server action can read the session only from that cookie. The user menu
 * refreshes it through `GET /api/auth/get-session` first for that reason. Returning null degrades to signing out without the hint:
 * still signed out, just left on MP's page instead of returned here.
 *
 * The token is deliberately never logged. It is a JWT full of user claims.
 */
async function findMpIdToken(requestHeaders: Headers): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) return warnNoHint("no-session");

    // PRIMARY: the process-wide store, written at sign-in by `getUserInfo`.
    // Not a cache in front of the account record — with the JWT cookie cache
    // and the in-memory adapter, the account lookup below finds nothing in
    // this bundle. See src/lib/id-token-store.ts.
    const userGuid = (session.user as { userGuid?: unknown }).userGuid;
    const stored = takeIdToken(typeof userGuid === "string" ? userGuid : null);
    if (stored) return stored;

    // FALLBACK: the account record. Correct when it does work, and it starts
    // working on its own if a real database is configured.
    const ctx = await auth.$context;
    const accounts = await ctx.internalAdapter.findAccountByUserId(session.user.id);
    const mpAccount = accounts?.find((a) => a.providerId === MP_PROVIDER_ID);
    if (!mpAccount) return warnNoHint("no-mp-account");
    if (!mpAccount.idToken) return warnNoHint("account-has-no-id-token");

    return mpAccount.idToken;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "signout.id_token_lookup_failed",
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return warnNoHint("lookup-failed");
  }
}

/**
 * Says why sign-out could not include `id_token_hint`, and returns null.
 *
 * A WARNING because the consequence is real and otherwise invisible: without
 * the hint, MP discards `post_logout_redirect_uri` and leaves the user on its
 * own logged-out page, while sign-out itself still works. If this line does NOT
 * appear on a sign-out that strands the user, the app did its part and the
 * remaining problem is the Post-Logout Redirect URI registration in MP.
 *
 * Carries no user identifier and never the token itself.
 */
function warnNoHint(
  reason: "no-session" | "no-mp-account" | "account-has-no-id-token" | "lookup-failed",
): null {
  console.warn(
    `[signout] id_token_hint omitted (${reason}) — MP will ignore post_logout_redirect_uri ` +
      `and leave the user on its logged-out page. See docs/OAUTH_LOGOUT_SETUP.md.`,
  );
  return null;
}

export async function handleSignOut() {
  const requestHeaders = await headers();

  // 1. Read the hint while the session still exists. ORDER MATTERS: the
  //    session is how the user is identified, and signing out destroys it.
  const idToken = await findMpIdToken(requestHeaders);

  // 2. Clear the Better Auth session.
  await auth.api.signOut({ headers: requestHeaders });

  const baseUrl = process.env.MINISTRY_PLATFORM_BASE_URL;
  if (!baseUrl) {
    throw new Error('MINISTRY_PLATFORM_BASE_URL is not configured');
  }

  // 3. Hand the browser to MP, the only thing that can end the IdP session.
  //    `redirect()` throws NEXT_REDIRECT, so it must stay outside any catch.
  redirect(
    buildEndSessionUrl({
      baseUrl,
      postLogoutUri: process.env.BETTER_AUTH_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000',
      idToken,
    }),
  );
}
