import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Database, SqlStore } from "./database";
export type User = { id: string; email: string; name: string };
export type AuthEnv = { Variables: { user: User; sessionHash: string } };
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const keys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
export async function verifyGoogleIdentity(
  token: string,
  nonce: string,
): Promise<User> {
  const { payload: p } = await jwtVerify(token, keys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: process.env.GOOGLE_CLIENT_ID!,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat", "nonce", "email"],
  });
  if (
    p.nonce !== nonce ||
    (p.azp !== undefined && p.azp !== process.env.GOOGLE_CLIENT_ID) ||
    p.email_verified !== true ||
    typeof p.email !== "string" ||
    !p.sub
  )
    throw new HTTPException(400, {
      message: "Googleアカウントを検証できませんでした",
    });
  return {
    id: p.sub,
    email: p.email.toLowerCase(),
    name: typeof p.name === "string" ? p.name : p.email,
  };
}
export async function initializeAuth(db: Database) {
  await db.client.batch(
    [
      "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS user_sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS oauth_states (hash TEXT PRIMARY KEY, mode TEXT NOT NULL, user_id TEXT, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL, return_device TEXT)",
      "CREATE TABLE IF NOT EXISTS library_records (kind TEXT NOT NULL,id TEXT NOT NULL,owner_id TEXT NOT NULL,group_id TEXT,data TEXT NOT NULL,PRIMARY KEY(kind,id))",
      "CREATE INDEX IF NOT EXISTS library_group ON library_records(kind,group_id)",
      "CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(group_id,user_id))",
      "CREATE TABLE IF NOT EXISTS drive_credentials (user_id TEXT PRIMARY KEY,value TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS device_logins (hash TEXT PRIMARY KEY,user_code TEXT UNIQUE NOT NULL,user_id TEXT,expires INTEGER NOT NULL)",
    ],
    "write",
  );
}
export async function migrateLegacy(
  db: Database,
  user: User,
  ownerEmail?: string,
) {
  // An explicitly configured verified owner alone can claim the old workspace.
  if (!ownerEmail || user.email !== ownerEmail.toLowerCase()) return;
  await db.transaction(async (tx) => {
    if (
      await tx
        .query("SELECT id FROM secrets WHERE id='user-isolation-migration'")
        .get()
    )
      return;
    const rows = await tx.query("SELECT kind,id,data FROM records").all();
    for (const row of rows) {
      const data = JSON.parse(String(row.data));
      const ownerId = user.id;
      if (row.kind === "art" && data.source === "drive")
        data.url = `/api/artworks/${encodeURIComponent(data.id)}/image`;
      data.ownerId = ownerId;
      await tx
        .query(
          "INSERT OR IGNORE INTO library_records(kind,id,owner_id,group_id,data) VALUES(?,?,?,?,?)",
        )
        .run(
          String(row.kind),
          String(row.id),
          ownerId,
          row.kind === "group" ? String(row.id) : data.groupId,
          JSON.stringify(data),
        );
    }
    await tx
      .query(
        "INSERT OR IGNORE INTO drive_credentials(user_id,value) SELECT ?,value FROM secrets WHERE id='google'",
      )
      .run(user.id);
    await tx.query("DELETE FROM secrets WHERE id='google'").run();
    await tx
      .query(
        "INSERT INTO secrets(id,value) VALUES('user-isolation-migration',?)",
      )
      .run(user.id);
  });
}
export function setupAuth(
  app: Hono<AuthEnv>,
  db: Database,
  origin: string,
  configured: () => boolean,
  options: {
    legacyOwnerEmail?: string;
    verifyIdentity?: typeof verifyGoogleIdentity;
    saveDrive: (userId: string, tokens: any) => Promise<void>;
  },
) {
  const callback = `${process.env.API_ORIGIN ?? origin}/api/drive/callback`;
  const sessionCookie = (c: Context, token: string) =>
    setCookie(c, "folio_session", token, {
      httpOnly: true,
      secure: origin.startsWith("https:"),
      sameSite: "Lax",
      path: "/api",
      maxAge: 7 * 86400,
    });
  async function issueSession(userId: string, store: SqlStore = db) {
    const token = random();
    await store
      .query("INSERT INTO user_sessions(hash,user_id,expires) VALUES(?,?,?)")
      .run(hash(token), userId, Date.now() + 7 * 86400_000);
    return token;
  }
  async function resolve(c: Context) {
    const bearer = c.req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1];
    const token = bearer || getCookie(c, "folio_session");
    if (!token) return;
    const user = await db
      .query(
        "SELECT u.id,u.email,u.name FROM users u JOIN user_sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires>?",
      )
      .get(hash(token), Date.now());
    return user
      ? {
          user: {
            id: String(user.id),
            email: String(user.email),
            name: String(user.name),
          },
          sessionHash: hash(token),
        }
      : undefined;
  }
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const reqOrigin = c.req.header("Origin");
    if (reqOrigin && reqOrigin !== origin)
      return c.json({ error: "Origin not allowed" }, 403);
    const publicPaths = [
      "/api/health",
      "/api/auth/me",
      "/api/auth/login",
      "/api/drive/callback",
      "/api/auth/device/start",
      "/api/auth/device/token",
    ];
    const identity = await resolve(c);
    if (identity) {
      c.set("user", identity.user);
      c.set("sessionHash", identity.sessionHash);
    }
    if (!publicPaths.includes(c.req.path) && !identity)
      return c.json({ error: "Googleアカウントでログインしてください" }, 401);
    return next();
  });
  app.get("/api/auth/me", (c) =>
    c.json({ user: c.get("user") ?? null, configured: configured() }),
  );
  async function begin(c: Context<AuthEnv>, mode: "login" | "drive") {
    if (!configured())
      throw new HTTPException(503, {
        message: "Googleログインの設定が必要です",
      });
    const state = random(),
      nonce = random(),
      verifier = random();
    const device = c.req.query("device") ?? "";
    if (device && !/^[A-F0-9]{12}$/.test(device)) throw new HTTPException(400);
    await db.query("DELETE FROM oauth_states WHERE expires<?").run(Date.now());
    await db
      .query(
        "INSERT INTO oauth_states(hash,mode,user_id,nonce,verifier,expires,return_device) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        hash(state),
        mode,
        c.get("user")?.id ?? null,
        nonce,
        verifier,
        Date.now() + 600_000,
        device || null,
      );
    setCookie(c, "folio_oauth", state, {
      httpOnly: true,
      secure: origin.startsWith("https:"),
      sameSite: "Lax",
      path: "/api",
      maxAge: 600,
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: callback,
      response_type: "code",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope:
        mode === "login"
          ? "openid email profile"
          : "openid email profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
      ...(mode === "drive"
        ? {
            access_type: "offline",
            prompt: "consent",
            login_hint: c.get("user").email,
          }
        : { prompt: "select_account" }),
    }).toString();
    return mode === "login" ? c.redirect(url.href) : c.json({ url: url.href });
  }
  app.get("/api/auth/login", (c) => begin(c, "login"));
  app.get("/api/drive/connect", (c) => begin(c, "drive"));
  app.get("/api/drive/callback", async (c) => {
    const state = c.req.query("state"),
      cookie = getCookie(c, "folio_oauth");
    deleteCookie(c, "folio_oauth", { path: "/api" });
    if (!state || state !== cookie)
      throw new HTTPException(400, { message: "認証の状態が一致しません" });
    const stored = await db.transaction(async (tx) => {
      const row = await tx
        .query("SELECT * FROM oauth_states WHERE hash=? AND expires>?")
        .get(hash(state), Date.now());
      if (row)
        await tx
          .query("DELETE FROM oauth_states WHERE hash=?")
          .run(hash(state));
      return row;
    });
    if (!stored)
      throw new HTTPException(400, { message: "認証リクエストが期限切れです" });
    if (
      stored.mode === "drive" &&
      (!c.get("user") || c.get("user").id !== stored.user_id)
    )
      throw new HTTPException(403);
    const code = c.req.query("code");
    if (!code) return c.redirect(`${origin}/?auth=cancelled`);
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: callback,
        grant_type: "authorization_code",
        code_verifier: String(stored.verifier),
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok)
      throw new HTTPException(400, { message: "Google認証に失敗しました" });
    const tokens = (await r.json()) as any;
    let user: User;
    try {
      user = await (options.verifyIdentity ?? verifyGoogleIdentity)(
        tokens.id_token,
        String(stored.nonce),
      );
    } catch {
      throw new HTTPException(400, {
        message: "Googleアカウントを検証できませんでした",
      });
    }
    if (stored.mode === "drive") {
      if (user.id !== stored.user_id)
        throw new HTTPException(403, {
          message: "ログイン中と同じGoogleアカウントを選択してください",
        });
      if (
        !String(tokens.scope ?? "")
          .split(" ")
          .includes("https://www.googleapis.com/auth/drive.readonly")
      )
        throw new HTTPException(400, {
          message: "Driveの読み取り権限が許可されませんでした",
        });
      await options.saveDrive(user.id, tokens);
      return c.redirect(`${origin}/?drive=connected`);
    }
    await db
      .query(
        "INSERT INTO users(id,email,name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name",
      )
      .run(user.id, user.email, user.name);
    await migrateLegacy(
      db,
      user,
      options.legacyOwnerEmail ?? process.env.LEGACY_OWNER_EMAIL,
    );
    if (
      !(await db
        .query(
          "SELECT id FROM library_records WHERE kind='group' AND owner_id=? LIMIT 1",
        )
        .get(user.id))
    ) {
      const id = crypto.randomUUID();
      await db
        .query(
          "INSERT INTO library_records(kind,id,owner_id,group_id,data) VALUES('group',?,?,?,?)",
        )
        .run(
          id,
          user.id,
          id,
          JSON.stringify({
            id,
            name: "Personal space",
            color: "#88b8a3",
            ownerId: user.id,
          }),
        );
    }
    // Old workspace cookies have no authority; login always issues a new random session.
    const old = c.get("sessionHash");
    if (old) await db.query("DELETE FROM user_sessions WHERE hash=?").run(old);
    sessionCookie(c, await issueSession(user.id));
    const device = stored.return_device
      ? `?device=${encodeURIComponent(String(stored.return_device))}`
      : "";
    return c.redirect(`${origin}/${device}`);
  });
  app.delete("/api/session", async (c) => {
    await db
      .query("DELETE FROM user_sessions WHERE hash=?")
      .run(c.get("sessionHash"));
    deleteCookie(c, "folio_session", { path: "/api" });
    return c.json({ authenticated: false });
  });
  app.post("/api/auth/device/start", async (c) => {
    const deviceCode = random(),
      userCode = randomBytes(6).toString("hex").toUpperCase();
    await db.query("DELETE FROM device_logins WHERE expires<?").run(Date.now());
    await db
      .query("INSERT INTO device_logins(hash,user_code,expires) VALUES(?,?,?)")
      .run(hash(deviceCode), userCode, Date.now() + 600_000);
    return c.json({
      deviceCode,
      userCode,
      verificationUri: `${origin}/?device=${userCode}`,
      expiresIn: 600,
    });
  });
  app.post("/api/auth/device/approve", async (c) => {
    const { userCode } = await c.req.json();
    if (typeof userCode !== "string" || !/^[A-F0-9]{12}$/.test(userCode))
      throw new HTTPException(400);
    const changed = await db
      .query(
        "UPDATE device_logins SET user_id=? WHERE user_code=? AND user_id IS NULL AND expires>?",
      )
      .run(c.get("user").id, userCode, Date.now());
    if (!changed.rowsAffected)
      throw new HTTPException(400, {
        message: "接続コードが期限切れか、すでに使用されています",
      });
    return c.json({ approved: true });
  });
  app.post("/api/auth/device/token", async (c) => {
    const { deviceCode } = await c.req.json();
    if (typeof deviceCode !== "string" || deviceCode.length > 100)
      throw new HTTPException(400);
    const token = await db.transaction(async (tx) => {
      const row = await tx
        .query("SELECT * FROM device_logins WHERE hash=? AND expires>?")
        .get(hash(deviceCode), Date.now());
      if (!row)
        throw new HTTPException(400, { message: "接続コードが期限切れです" });
      if (!row.user_id)
        throw new HTTPException(409, {
          message: "ブラウザでスマホへの接続を許可してください",
        });
      await tx
        .query("DELETE FROM device_logins WHERE hash=?")
        .run(hash(deviceCode));
      return issueSession(String(row.user_id), tx);
    });
    return c.json({ token });
  });
}
