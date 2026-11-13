import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createRemoteJWKSet, jwtVerify, importPKCS8, SignJWT } from "jose";
import { randomBytes } from "node:crypto";
import { hash, type AuthEnv, type User } from "./auth";
import type { Database, SqlStore } from "./database";

export type AppleIdentity = { subject: string; email: string };
const keys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
const clientId = () => process.env.APPLE_CLIENT_ID ?? "studio.folio.app";
export async function verifyAppleIdentity(
  token: string,
  nonce: string,
): Promise<AppleIdentity> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: "https://appleid.apple.com",
    audience: clientId(),
    algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat", "nonce", "email"],
  });
  if (
    payload.nonce !== nonce ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    ![true, "true"].includes(payload.email_verified as any)
  )
    throw Error("invalid identity");
  return { subject: payload.sub, email: payload.email.toLowerCase() };
}
export async function createAppleClientSecret() {
  if (
    !process.env.APPLE_TEAM_ID ||
    !process.env.APPLE_KEY_ID ||
    !process.env.APPLE_PRIVATE_KEY
  )
    throw Error("Apple authentication is not configured");
  const key = await importPKCS8(process.env.APPLE_PRIVATE_KEY, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: process.env.APPLE_KEY_ID })
    .setIssuer(process.env.APPLE_TEAM_ID)
    .setSubject(clientId())
    .setAudience("https://appleid.apple.com")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}
async function appleRequest(
  path: "token" | "revoke",
  fields: Record<string, string>,
) {
  const response = await fetch(`https://appleid.apple.com/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: await createAppleClientSecret(),
      ...fields,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error("Apple authorization failed");
  return response;
}
export type AppleAuthHooks = {
  verify?: typeof verifyAppleIdentity;
  exchange?: (
    code: string,
  ) => Promise<{ refresh_token: string; id_token: string }>;
  revoke?: (refreshToken: string) => Promise<void>;
};
export async function issueUserSession(db: SqlStore, userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db
    .query("INSERT INTO user_sessions(hash,user_id,expires) VALUES(?,?,?)")
    .run(hash(token), userId, Date.now() + 7 * 86400_000);
  return token;
}
export function setupAppleAuth(
  app: Hono<AuthEnv>,
  db: Database,
  options: {
    encrypt: (s: string) => string;
    decrypt: (s: string) => string;
    hooks?: AppleAuthHooks;
  },
) {
  const configured = () =>
    Boolean(
      (options.hooks ||
        (process.env.APPLE_TEAM_ID &&
          process.env.APPLE_KEY_ID &&
          process.env.APPLE_PRIVATE_KEY)) &&
        process.env.TOKEN_ENCRYPTION_KEY,
    );
  const verify = options.hooks?.verify ?? verifyAppleIdentity;
  app.get("/api/auth/apple/status", async (c) =>
    c.json({
      configured: configured(),
      linked: !!(
        c.get("user") &&
        (await db
          .query("SELECT subject FROM apple_accounts WHERE user_id=?")
          .get(c.get("user").id))
      ),
    }),
  );
  app.post("/api/auth/apple/challenge", async (c) => {
    if (!configured())
      throw new HTTPException(503, {
        message: "Appleログインの設定が必要です",
      });
    await db
      .query("DELETE FROM native_auth_challenges WHERE expires<?")
      .run(Date.now());
    const count = await db
      .query("SELECT COUNT(*) AS count FROM native_auth_challenges")
      .get();
    if (Number(count?.count) > 5000) throw new HTTPException(429);
    const challenge = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("hex");
    await db
      .query(
        "INSERT INTO native_auth_challenges(hash,nonce,expires) VALUES(?,?,?)",
      )
      .run(hash(challenge), nonce, Date.now() + 300_000);
    return c.json({ challenge, nonce });
  });
  app.post("/api/auth/apple", async (c) => {
    if (!configured())
      throw new HTTPException(503, {
        message: "Appleログインの設定が必要です",
      });
    const body = await c.req.json();
    if (
      typeof body.challenge !== "string" ||
      body.challenge.length > 100 ||
      typeof body.identityToken !== "string" ||
      body.identityToken.length > 20000 ||
      typeof body.authorizationCode !== "string" ||
      body.authorizationCode.length > 2000 ||
      ![undefined, "login", "link"].includes(body.mode)
    )
      throw new HTTPException(400);
    if (body.mode === "link" && !c.get("user")) throw new HTTPException(401);
    const nonce = await db.transaction(async (tx) => {
      const row = await tx
        .query(
          "SELECT nonce FROM native_auth_challenges WHERE hash=? AND expires>?",
        )
        .get(hash(body.challenge), Date.now());
      if (row)
        await tx
          .query("DELETE FROM native_auth_challenges WHERE hash=?")
          .run(hash(body.challenge));
      return row?.nonce;
    });
    if (!nonce)
      throw new HTTPException(400, { message: "認証をやり直してください" });
    let identity: AppleIdentity,
      tokens: { refresh_token: string; id_token: string };
    try {
      identity = await verify(body.identityToken, String(nonce));
      tokens = options.hooks?.exchange
        ? await options.hooks.exchange(body.authorizationCode)
        : ((await (
            await appleRequest("token", {
              code: body.authorizationCode,
              grant_type: "authorization_code",
            })
          ).json()) as any);
      if (
        !tokens.refresh_token ||
        !tokens.id_token ||
        (await verify(tokens.id_token, String(nonce))).subject !==
          identity.subject
      )
        throw Error("identity mismatch");
    } catch {
      throw new HTTPException(400, {
        message: "Appleアカウントを検証できませんでした",
      });
    }
    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .query(
          "SELECT u.id,u.email,u.name FROM apple_accounts a JOIN users u ON u.id=a.user_id WHERE a.subject=?",
        )
        .get(identity.subject);
      let user: User;
      if (body.mode === "link") {
        user = c.get("user");
        if (existing && existing.id !== user.id)
          throw new HTTPException(409, {
            message: "このAppleアカウントは別のFolioアカウントに連携済みです",
          });
      } else if (existing)
        user = {
          id: String(existing.id),
          email: String(existing.email),
          name: String(existing.name),
        };
      else {
        // Never merge identities merely because two providers report the same email.
        if (
          await tx
            .query("SELECT id FROM users WHERE email=?")
            .get(identity.email)
        )
          throw new HTTPException(409, {
            message:
              "このメールは登録済みです。既存の方法でログインし、設定からAppleログインを連携してください",
          });
        user = {
          id: `apple:${crypto.randomUUID()}`,
          email: identity.email,
          name:
            typeof body.name === "string" && body.name.trim()
              ? body.name.trim().slice(0, 120)
              : "Folio user",
        };
        await tx
          .query("INSERT INTO users(id,email,name) VALUES(?,?,?)")
          .run(user.id, user.email, user.name);
        const groupId = crypto.randomUUID();
        await tx
          .query(
            "INSERT INTO library_records(kind,id,owner_id,group_id,data) VALUES('group',?,?,?,?)",
          )
          .run(
            groupId,
            user.id,
            groupId,
            JSON.stringify({
              id: groupId,
              ownerId: user.id,
              name: "Personal space",
              color: "#88b8a3",
            }),
          );
      }
      await tx
        .query(
          "INSERT INTO apple_accounts(subject,user_id,refresh_token) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET refresh_token=excluded.refresh_token",
        )
        .run(identity.subject, user.id, options.encrypt(tokens.refresh_token));
      return { user, token: await issueUserSession(tx, user.id) };
    });
    return c.json(result);
  });
  return {
    async revoke(userId: string) {
      const rows = await db
        .query("SELECT refresh_token FROM apple_accounts WHERE user_id=?")
        .all(userId);
      for (const row of rows) {
        const token = options.decrypt(String(row.refresh_token));
        if (options.hooks?.revoke) await options.hooks.revoke(token);
        else
          await appleRequest("revoke", {
            token,
            token_type_hint: "refresh_token",
          });
      }
    },
  };
}
