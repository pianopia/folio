import { test, expect } from "bun:test";
import { createApp } from "./src/app";
import { alice, bob, addUser, client } from "./test-support";
import { hash, verifyGoogleIdentity } from "./src/auth";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

test("OAuth is state/nonce/PKCE bound, private to each account, and sharing only authorizes one imported artwork", async () => {
  const keys = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "API_ORIGIN",
  ];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]])),
    originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture-secret",
    TOKEN_ENCRYPTION_KEY: "c".repeat(64),
    API_ORIGIN: "https://folio.example",
  });
  let nonce = "",
    nextIdentity = alice,
    previewRequests: string[] = [],
    imageRequests: string[] = [],
    revoked: string[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input),
      auth = new Headers(init?.headers).get("Authorization") ?? "";
    if (url === "https://oauth2.googleapis.com/token") {
      const body = init?.body as URLSearchParams;
      expect(body.get("code_verifier")).toBeString();
      return Response.json({
        id_token: "signed-provider-token",
        access_token: nextIdentity.id + "-access",
        refresh_token: nextIdentity.id + "-refresh",
        expires_in: 3600,
        scope:
          "openid email profile https://www.googleapis.com/auth/drive.readonly",
      });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?"))
      return Response.json({
        files: [
          {
            id: "same-file-id",
            name: "Private.png",
            mimeType: "image/png",
            thumbnailLink:
              "https://lh3.googleusercontent.com/drive-storage/same=s220",
            thumbnailVersion: "1",
          },
        ],
      });
    if (
      url.startsWith(
        "https://www.googleapis.com/drive/v3/files/same-file-id?alt=media",
      )
    ) {
      imageRequests.push(auth);
      return new Response(auth, { headers: { "Content-Type": "image/png" } });
    }
    if (url.startsWith("https://lh3.googleusercontent.com/")) {
      previewRequests.push(auth);
      return new Response(auth, { headers: { "Content-Type": "image/png" } });
    }
    if (url === "https://oauth2.googleapis.com/revoke") {
      revoked.push((init?.body as URLSearchParams).get("token")!);
      return new Response(null, { status: 200 });
    }
    throw Error("Unexpected provider call");
  }) as typeof fetch;
  let db: Awaited<ReturnType<typeof createApp>>["db"] | undefined;
  try {
    const created = await createApp({
      database: ":memory:",
      webOrigin: "https://folio.example",
      verifyIdentity: async (token, n) => {
        expect(token).toBe("signed-provider-token");
        expect(n).toBe(nonce);
        return nextIdentity;
      },
    });
    db = created.db;
    await addUser(db, alice, "a");
    await addUser(db, bob, "b");
    const a = client(created.app, "a"),
      b = client(created.app, "b");
    async function begin(call: typeof a, login = false) {
      const response = await call(login ? "/auth/login" : "/drive/connect");
      const auth = new URL(
        login ? response.headers.get("location")! : (await response.json()).url,
      );
      nonce = auth.searchParams.get("nonce")!;
      const state = auth.searchParams.get("state")!;
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect(auth.searchParams.get("code_challenge")).toBeString();
      return { auth, state, cookie: `folio_oauth=${state}` };
    }
    const request = await begin(a);
    expect(request.auth.searchParams.get("scope")).toContain("drive.readonly");
    expect(
      (await a(`/drive/callback?state=${request.state}&code=fixture`)).status,
    ).toBe(400);
    expect(
      (
        await b(
          `/drive/callback?state=${request.state}&code=fixture`,
          "GET",
          undefined,
          { Cookie: request.cookie },
        )
      ).status,
    ).toBe(403);
    const own = await begin(a);
    expect(
      (
        await a(
          `/drive/callback?state=${own.state}&code=fixture`,
          "GET",
          undefined,
          { Cookie: own.cookie },
        )
      ).status,
    ).toBe(302);
    expect(
      (
        await a(
          `/drive/callback?state=${own.state}&code=fixture`,
          "GET",
          undefined,
          { Cookie: own.cookie },
        )
      ).status,
    ).toBe(400);
    const encrypted = String(
      (
        await db
          .query("SELECT value FROM drive_credentials WHERE user_id=?")
          .get(alice.id)
      )?.value,
    );
    expect(encrypted).not.toContain("access");
    expect(encrypted).not.toContain("refresh");
    expect((await (await a("/drive/status")).json()).connected).toBe(true);
    expect((await (await b("/drive/status")).json()).connected).toBe(false);
    expect((await b("/drive/files")).status).toBe(409);
    expect((await b("/drive/image/same-file-id")).status).toBe(409);
    const list = await (await a("/drive/files")).json();
    expect(list.files[0].thumbnailLink).toBeUndefined();
    expect(
      await (await a(list.files[0].thumbnailUrl.replace("/api", ""))).text(),
    ).toBe("Bearer google-alice-access");
    expect(await (await a("/drive/thumbnail/same-file-id")).text()).toBe(
      "Bearer google-alice-access",
    );
    expect(previewRequests).toHaveLength(1);
    const g = await (
      await a("/groups", "POST", { name: "Shared selection" })
    ).json();
    const art = (
      await (
        await a("/drive/import", "POST", {
          ids: ["same-file-id"],
          groupId: g.id,
        })
      ).json()
    ).artworks[0];
    expect(art.url).toContain(`/api/artworks/${art.id}/image`);
    expect((await b(`/artworks/${art.id}/image`)).status).toBe(404);
    expect(
      (await a(`/groups/${g.id}/members`, "POST", { email: bob.email })).status,
    ).toBe(201);
    expect(await (await b(`/artworks/${art.id}/image`)).text()).toBe(
      "Bearer google-alice-access",
    );
    expect(await (await b(`/artworks/${art.id}/thumbnail`)).text()).toBe(
      "Bearer google-alice-access",
    );
    expect(imageRequests).toEqual(["Bearer google-alice-access"]);
    expect((await b("/drive/files")).status).toBe(409);
    // Connecting a different Google identity must not attach its Drive to Alice.
    nextIdentity = bob;
    const mismatch = await begin(a);
    expect(
      (
        await a(
          `/drive/callback?state=${mismatch.state}&code=fixture`,
          "GET",
          undefined,
          { Cookie: mismatch.cookie },
        )
      ).status,
    ).toBe(403);
    const bobRequest = await begin(b);
    expect(
      (
        await b(
          `/drive/callback?state=${bobRequest.state}&code=fixture`,
          "GET",
          undefined,
          { Cookie: bobRequest.cookie },
        )
      ).status,
    ).toBe(302);
    await b("/drive/files");
    expect(await (await b("/drive/thumbnail/same-file-id")).text()).toBe(
      "Bearer google-bob-access",
    );
    expect(previewRequests).toEqual([
      "Bearer google-alice-access",
      "Bearer google-bob-access",
    ]);
    await a(`/groups/${g.id}/members/${bob.id}`, "DELETE");
    expect((await b(`/artworks/${art.id}/thumbnail`)).status).toBe(404);
    expect((await b(`/artworks/${art.id}/image`)).status).toBe(404);
    expect((await b("/drive", "DELETE")).status).toBe(200);
    expect(revoked).toEqual(["google-bob-refresh"]);
    expect((await (await a("/drive/status")).json()).connected).toBe(true);
    expect((await (await b("/drive/status")).json()).connected).toBe(false);
    // Sign-in only requests identity; it does not silently grant Drive access.
    const login = await begin(b, true);
    expect(login.auth.searchParams.get("scope")).toBe("openid email profile");
    const result = await b(
      `/drive/callback?state=${login.state}&code=fixture`,
      "GET",
      undefined,
      { Cookie: login.cookie },
    );
    expect(result.status).toBe(302);
    expect(result.headers.get("set-cookie")).toContain("HttpOnly");
    const cookie = result.headers
      .getSetCookie()
      .find((c) => c.startsWith("folio_session="))!
      .split(";")[0];
    expect(
      (
        await created.app.request("https://folio.example/api/library", {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(200);
    expect((await b("/library")).status).toBe(401);
  } finally {
    db?.close();
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});

test("Google ID tokens require a valid signature, issuer, audience, expiry, verified email and nonce", async () => {
  const original = globalThis.fetch,
    oldClient = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = "identity-test-client";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "fixture-key";
  jwk.alg = "RS256";
  globalThis.fetch = (async () =>
    Response.json({ keys: [jwk] })) as unknown as typeof fetch;
  const sign = (overrides: Record<string, unknown> = {}) =>
    new SignJWT({
      email: "Alice@Example.com",
      email_verified: true,
      name: "Alice",
      nonce: "expected-nonce",
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience("identity-test-client")
      .setSubject("google-alice")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  try {
    expect(await verifyGoogleIdentity(await sign(), "expected-nonce")).toEqual(
      alice,
    );
    await expect(
      verifyGoogleIdentity(await sign(), "wrong-nonce"),
    ).rejects.toThrow();
    await expect(
      verifyGoogleIdentity(
        await sign({ email_verified: false }),
        "expected-nonce",
      ),
    ).rejects.toThrow();
    const badAudience = await new SignJWT({
      nonce: "expected-nonce",
      email: alice.email,
      email_verified: true,
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience("attacker-client")
      .setSubject(alice.id)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(
      verifyGoogleIdentity(badAudience, "expected-nonce"),
    ).rejects.toThrow();
    for (const invalid of ["issuer", "expiry"]) {
      const invalidToken = await new SignJWT({
        nonce: "expected-nonce",
        email: alice.email,
        email_verified: true,
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
        .setIssuer(
          invalid === "issuer"
            ? "https://attacker.example"
            : "https://accounts.google.com",
        )
        .setAudience("identity-test-client")
        .setSubject(alice.id)
        .setIssuedAt()
        .setExpirationTime(invalid === "expiry" ? 1 : "5m")
        .sign(privateKey);
      await expect(
        verifyGoogleIdentity(invalidToken, "expected-nonce"),
      ).rejects.toThrow();
    }
    const forged = await new SignJWT({
      nonce: "expected-nonce",
      email: alice.email,
      email_verified: true,
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience("identity-test-client")
      .setSubject(alice.id)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign((await generateKeyPair("RS256")).privateKey);
    await expect(
      verifyGoogleIdentity(forged, "expected-nonce"),
    ).rejects.toThrow();
  } finally {
    globalThis.fetch = original;
    if (oldClient === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = oldClient;
  }
});
