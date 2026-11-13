import { test, expect } from "bun:test";
import { createApp } from "./src/app";
import { addUser, alice, bob, client } from "./test-support";
import { verifyAppleIdentity } from "./src/apple-auth";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

test("Apple identity requires the signed issuer, app audience, nonce, expiry and verified email", async () => {
  const original = globalThis.fetch;
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "folio-apple-fixture";
  globalThis.fetch = (async () =>
    Response.json({ keys: [jwk] })) as unknown as typeof fetch;
  const sign = (overrides: Record<string, unknown> = {}) =>
    new SignJWT({
      sub: "apple-subject",
      email: "private@privaterelay.appleid.com",
      email_verified: "true",
      nonce: "nonce",
      iss: "https://appleid.apple.com",
      aud: "studio.folio.app",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .sign(privateKey);
  try {
    expect(await verifyAppleIdentity(await sign(), "nonce")).toEqual({
      subject: "apple-subject",
      email: "private@privaterelay.appleid.com",
    });
    for (const patch of [
      { iss: "https://evil.example" },
      { aud: "another.app" },
      { nonce: "different" },
      { exp: 1 },
      { email_verified: false },
      { email_verified: "false" },
      { email: undefined },
      { nonce: undefined },
    ])
      await expect(
        verifyAppleIdentity(await sign(patch), "nonce"),
      ).rejects.toBeTruthy();
    const impostor = await generateKeyPair("RS256");
    const bad = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .sign(impostor.privateKey);
    await expect(verifyAppleIdentity(bad, "nonce")).rejects.toBeTruthy();
  } finally {
    globalThis.fetch = original;
  }
});

test("Apple sign-in consumes challenges once, encrypts refresh tokens, and links only with explicit authenticated approval", async () => {
  const old = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = "13".repeat(32);
  const codes = new Map<string, { refresh_token: string; id_token: string }>();
  const { app, db } = await createApp({
    database: ":memory:",
    webOrigin: "https://folio.example",
    appleAuth: {
      verify: async (token, nonce) => {
        const identity = JSON.parse(token);
        if (identity.nonce !== nonce) throw Error("nonce");
        return identity;
      },
      exchange: async (code) => {
        if (!codes.has(code)) throw Error("bad code");
        return codes.get(code)!;
      },
      revoke: async () => {},
    },
  });
  const anon = client(app, ""),
    a = client(app, "alice-session"),
    b = client(app, "bob-session");
  async function payload(
    subject = "apple-private",
    email = "private@privaterelay.appleid.com",
  ) {
    const c = await (await anon("/auth/apple/challenge", "POST")).json();
    const identityToken = JSON.stringify({ subject, email, nonce: c.nonce });
    const code = crypto.randomUUID();
    codes.set(code, {
      refresh_token: `refresh-${subject}`,
      id_token: identityToken,
    });
    return { ...c, identityToken, authorizationCode: code };
  }
  try {
    await addUser(db, alice, "alice-session");
    await addUser(db, bob, "bob-session");
    const p = await payload();
    const login = await anon("/auth/apple", "POST", p);
    expect(login.status).toBe(200);
    const body = await login.json();
    expect(body.user.id).toStartWith("apple:");
    expect(body).not.toHaveProperty("refresh_token");
    const stored = await db
      .query("SELECT refresh_token FROM apple_accounts WHERE subject=?")
      .get("apple-private");
    expect(stored?.refresh_token).not.toContain("refresh-apple-private");
    const native = client(app, body.token);
    expect((await (await native("/library")).json()).groups).toHaveLength(1);
    expect((await (await native("/auth/apple/status")).json()).linked).toBe(
      true,
    );
    expect((await anon("/auth/apple", "POST", p)).status).toBe(400);
    const expired = await payload("expired");
    await db.query("UPDATE native_auth_challenges SET expires=1").run();
    expect((await anon("/auth/apple", "POST", expired)).status).toBe(400);
    const mismatch = await payload("wrong-nonce");
    mismatch.identityToken = JSON.stringify({
      subject: "wrong-nonce",
      email: "x@example.com",
      nonce: "other",
    });
    expect((await anon("/auth/apple", "POST", mismatch)).status).toBe(400);
    const sameEmail = await payload("apple-alice", alice.email);
    expect((await anon("/auth/apple", "POST", sameEmail)).status).toBe(409);
    expect(
      await db
        .query("SELECT subject FROM apple_accounts WHERE subject='apple-alice'")
        .get(),
    ).toBeUndefined();
    const linked = await a("/auth/apple", "POST", {
      ...(await payload("apple-alice", alice.email)),
      mode: "link",
    });
    expect(linked.status).toBe(200);
    expect((await linked.json()).user.id).toBe(alice.id);
    expect(
      (
        await b("/auth/apple", "POST", {
          ...(await payload("apple-alice", alice.email)),
          mode: "link",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await anon("/auth/apple", "POST", {
          ...(await payload("new-sub")),
          mode: "link",
        })
      ).status,
    ).toBe(401);
    const again = await anon(
      "/auth/apple",
      "POST",
      await payload("apple-alice", alice.email),
    );
    expect((await again.json()).user.id).toBe(alice.id);
  } finally {
    db.close();
    if (old === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = old;
  }
});
