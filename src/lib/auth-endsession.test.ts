import { describe, it, expect } from "vitest";
import { buildEndSessionUrl, MP_PROVIDER_ID } from "@/lib/auth-endsession";

const BASE = "https://mpi.ministryplatform.com/ministryplatformapi";
const APP = "https://app.example.org";

/** Parses the built URL so assertions read as intent rather than string matching. */
function parse(url: string) {
  const u = new URL(url);
  return { path: u.origin + u.pathname, params: u.searchParams };
}

describe("buildEndSessionUrl", () => {
  it("targets the endpoint MP advertises in its discovery document", () => {
    // MINISTRY_PLATFORM_BASE_URL already carries the /ministryplatformapi
    // segment, so this must NOT add its own; the result matches the
    // end_session_endpoint in MP's discovery document.
    expect(parse(buildEndSessionUrl({ baseUrl: BASE, postLogoutUri: APP })).path).toBe(
      "https://mpi.ministryplatform.com/ministryplatformapi/oauth/connect/endsession"
    );
  });

  it("sends id_token_hint when a token is available", () => {
    // This is the whole point. MP runs IdentityServer, which honours
    // post_logout_redirect_uri ONLY when id_token_hint identifies the client.
    // Without it MP discards the redirect and strands the user on its own page.
    const { params } = parse(
      buildEndSessionUrl({ baseUrl: BASE, postLogoutUri: APP, idToken: "eyJhbGci.payload.sig" })
    );
    expect(params.get("id_token_hint")).toBe("eyJhbGci.payload.sig");
    expect(params.get("post_logout_redirect_uri")).toBe(APP);
  });

  it("still produces a usable URL with no token", () => {
    // Sign-out must never depend on the hint. The token is held in memory, so
    // a restart loses it and null is a NORMAL state. The user is still signed
    // out; they just land on MP's page instead of back here.
    const { path, params } = parse(buildEndSessionUrl({ baseUrl: BASE, postLogoutUri: APP }));
    expect(path).toContain("/oauth/connect/endsession");
    expect(params.has("id_token_hint")).toBe(false);
    expect(params.get("post_logout_redirect_uri")).toBe(APP);
  });

  it("treats an empty-string token as absent, not as a hint", () => {
    // An empty string is not a token: omit the parameter rather than send an
    // empty `id_token_hint=`.
    const { params } = parse(
      buildEndSessionUrl({ baseUrl: BASE, postLogoutUri: APP, idToken: "" })
    );
    expect(params.has("id_token_hint")).toBe(false);
  });

  it("encodes both parameters, so a JWT's dots and padding survive", () => {
    const url = buildEndSessionUrl({
      baseUrl: BASE,
      postLogoutUri: "https://example.org/landing?a=b&c=d",
      idToken: "a.b+c/d=",
    });
    const { params } = parse(url);
    expect(params.get("post_logout_redirect_uri")).toBe("https://example.org/landing?a=b&c=d");
    expect(params.get("id_token_hint")).toBe("a.b+c/d=");
    // The app's own query string must not leak out as top-level parameters.
    expect(params.has("a")).toBe(false);
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(parse(buildEndSessionUrl({ baseUrl: BASE + "/", postLogoutUri: APP })).path).toBe(
      "https://mpi.ministryplatform.com/ministryplatformapi/oauth/connect/endsession"
    );
  });

  it("pins the provider id the account lookup filters on", () => {
    // src/auth.test.ts also asserts the configured provider uses this id; if they
    // drift, the sign-out account lookup silently finds nothing.
    expect(MP_PROVIDER_ID).toBe("ministry-platform");
  });
});
