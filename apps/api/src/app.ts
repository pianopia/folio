import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { openDatabase, type SqlStore } from "./database";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { initialGroups, initialArtworks, type Artwork } from "@folio/shared";

import { DriveCache } from "./drive-cache";

type Options = { database?: string; token?: string; webOrigin?: string };
export async function createApp(options: Options = {}) {
  const db = await openDatabase(options.database);
  const all = async <T>(kind: string): Promise<T[]> =>
    (
      await db
        .query("SELECT data FROM records WHERE kind = ? ORDER BY rowid DESC")
        .all(kind)
    ).map((row) => JSON.parse(String(row.data)));
  const get = async <T>(kind: string, id: string): Promise<T | undefined> => {
    const row = await db
      .query("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(String(row.data)) : undefined;
  };
  const save = async (kind: string, value: any, store: SqlStore = db) => {
    await store
      .query("INSERT OR REPLACE INTO records(kind,id,data) VALUES (?,?,?)")
      .run(kind, value.id, JSON.stringify(value));
    return value;
  };
  await db.transaction(async (tx) => {
    if (!(await tx.query("SELECT id FROM secrets WHERE id='seeded'").get())) {
      await tx.batch([
        ...initialGroups.map((value) => ({
          sql: "INSERT OR IGNORE INTO records(kind,id,data) VALUES (?,?,?)",
          args: ["group", value.id, JSON.stringify(value)],
        })),
        ...initialArtworks.map((value) => ({
          sql: "INSERT OR IGNORE INTO records(kind,id,data) VALUES (?,?,?)",
          args: ["art", value.id, JSON.stringify(value)],
        })),
        {
          sql: "INSERT OR IGNORE INTO secrets(id,value) VALUES('seeded','true')",
          args: [],
        },
      ]);
    }
  });
  const origin =
    options.webOrigin ?? process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173";
  const token = options.token ?? process.env.API_TOKEN;
  const app = new Hono();
  app.use(
    "/api/*",
    cors({
      origin,
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    })
  );
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: "リクエストが大きすぎます" }, 413),
    })
  );
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    // Reject cross-site writes even when no development token is configured.
    const reqOrigin = c.req.header("Origin");
    if (reqOrigin && reqOrigin !== origin)
      return c.json({ error: "Origin not allowed" }, 403);
    if (token) {
      const supplied =
        (c.req.header("Authorization") ?? "").replace(/^Bearer /, "") ||
        getCookie(c, "folio_session") ||
        "";
      const a = Buffer.from(supplied),
        b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        return c.json({ error: "認証が必要です" }, 401);
    }
    return next();
  });
  app.onError((e, c) => {
    if (e instanceof HTTPException)
      return c.json({ error: e.message }, e.status);
    console.error(e.message);
    return c.json(
      { error: "処理できませんでした。もう一度お試しください。" },
      500
    );
  });
  const parse = async (c: any) => {
    try {
      const b = await c.req.json();
      if (!b || typeof b !== "object" || Array.isArray(b)) throw Error();
      return b;
    } catch {
      throw new HTTPException(400, { message: "有効なJSONが必要です" });
    }
  };
  const name = (v: unknown) => {
    if (typeof v !== "string" || !v.trim() || v.trim().length > 120)
      throw new HTTPException(400, {
        message: "名前は1〜120文字で入力してください",
      });
    return v.trim();
  };
  const group = async (id: string) => {
    if (typeof id !== "string" || !(await get("group", id)))
      throw new HTTPException(404, { message: "グループがありません" });
  };
  app.get("/api/health", async (c) => {
    await db.query("SELECT 1 AS ok").get();
    return c.json({
      ok: true,
      storage: process.env.TURSO_DATABASE_URL ? "turso" : "sqlite",
    });
  });
  app.post("/api/session", (c) => {
    if (!token) return c.json({ authenticated: true });
    setCookie(c, "folio_session", token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https:"),
      path: "/api",
      maxAge: 7 * 24 * 60 * 60,
    });
    c.header("Cache-Control", "no-store");
    return c.json({ authenticated: true });
  });
  app.delete("/api/session", (c) => {
    deleteCookie(c, "folio_session", { path: "/api" });
    return c.json({ authenticated: false });
  });
  app.get("/api/library", async (c) => {
    const [groups, artworks] = await Promise.all([all("group"), all("art")]);
    return c.json({ groups, artworks });
  });
  app.post("/api/groups", async (c) => {
    const b = await parse(c);
    return c.json(
      await save("group", {
        id: crypto.randomUUID(),
        name: name(b.name),
        color: "#9b9be8",
      }),
      201
    );
  });
  app.patch("/api/artworks/:id", async (c) => {
    const a = await get<Artwork>("art", c.req.param("id"));
    if (!a) return c.json({ error: "作品がありません" }, 404);
    const b = await parse(c);
    if (b.title !== undefined) a.title = name(b.title);
    if (b.groupId !== undefined) {
      await group(b.groupId);
      a.groupId = b.groupId;
    }
    if (b.collection !== undefined) a.collection = name(b.collection);
    if (b.favorite !== undefined) {
      if (typeof b.favorite !== "boolean")
        throw new HTTPException(400, { message: "favoriteはbooleanです" });
      a.favorite = b.favorite;
    }
    if (b.tags !== undefined) {
      if (!Array.isArray(b.tags) || b.tags.length > 20)
        throw new HTTPException(400, { message: "タグは20個までです" });
      a.tags = b.tags.map(name);
    }
    return c.json(await save("art", a));
  });
  app.delete("/api/artworks/:id", async (c) => {
    await db
      .query("DELETE FROM records WHERE kind='art' AND id=?")
      .run(c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/api/artworks", async (c) => {
    const b = await parse(c);
    await group(b.groupId);
    let url: URL;
    try {
      url = new URL(b.url);
    } catch {
      throw new HTTPException(400, { message: "画像のURLが必要です" });
    }
    if (url.protocol !== "https:")
      throw new HTTPException(400, {
        message: "HTTPSの画像URLを指定してください",
      });
    return c.json(
      await save("art", {
        id: crypto.randomUUID(),
        title: name(b.title),
        groupId: b.groupId,
        collection: name(b.collection ?? "Unsorted"),
        url: url.href,
        tags: [],
        favorite: false,
        createdAt: new Date().toISOString(),
        source: "sample",
      }),
      201
    );
  });
  const configured = () =>
    Boolean(
      process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        /^[a-fA-F0-9]{64}$/.test(process.env.TOKEN_ENCRYPTION_KEY ?? "")
    );
  const encrypt = (value: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(process.env.TOKEN_ENCRYPTION_KEY!, "hex"),
      iv
    );
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  };
  const decrypt = (value: string) => {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(process.env.TOKEN_ENCRYPTION_KEY!, "hex"),
      data.subarray(0, 12)
    );
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      cipher.update(data.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  };
  const secret = async () => {
    const row = await db
      .query("SELECT value FROM secrets WHERE id='google'")
      .get();
    return row ? { value: String(row.value) } : undefined;
  };
  const redirectURI = () =>
    `${process.env.API_ORIGIN ?? "http://127.0.0.1:5173"}/api/drive/callback`;
  async function googleToken() {
    if (!configured() || !(await secret()))
      throw new HTTPException(409, {
        message: "Google Driveを接続してください",
      });
    let t = JSON.parse(decrypt((await secret())!.value));
    if (t.expiresAt > Date.now() + 60000) return t.access_token;
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: t.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    if (!r.ok)
      throw new HTTPException(409, {
        message: "Google Driveの再接続が必要です",
      });
    const fresh = (await r.json()) as any;
    t = { ...t, ...fresh, expiresAt: Date.now() + fresh.expires_in * 1000 };
    await db
      .query("INSERT OR REPLACE INTO secrets VALUES('google',?)")
      .run(encrypt(JSON.stringify(t)));
    return t.access_token;
  }
  const driveCache = new DriveCache(googleToken);
  app.get("/api/drive/status", async (c) =>
    c.json({
      configured: configured(),
      connected: configured() && Boolean(await secret()),
    })
  );
  app.get("/api/drive/connect", (c) => {
    if (!configured())
      return c.json(
        {
          error:
            "GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、TOKEN_ENCRYPTION_KEYをサーバーに設定してください",
        },
        503
      );
    const state = crypto.randomUUID();
    setCookie(c, "drive_state", state, {
      httpOnly: true,
      sameSite: "Lax",
      secure: redirectURI().startsWith("https:"),
      path: "/api/drive",
      maxAge: 600,
    });
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.search = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectURI(),
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.readonly",
      state,
      access_type: "offline",
      prompt: "consent",
    }).toString();
    if (token)
      setCookie(c, "folio_session", token, {
        httpOnly: true,
        sameSite: "Lax",
        secure: redirectURI().startsWith("https:"),
        path: "/api",
        maxAge: 3600,
      });
    return c.json({ url: u.href });
  });
  app.get("/api/drive/callback", async (c) => {
    const state = getCookie(c, "drive_state");
    deleteCookie(c, "drive_state", { path: "/api/drive" });
    if (!state || state !== c.req.query("state"))
      return c.json({ error: "認証の状態が一致しません" }, 400);
    const code = c.req.query("code");
    if (!code) return c.redirect(`${origin}/?drive=cancelled`);
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectURI(),
        grant_type: "authorization_code",
      }),
    });
    if (!r.ok)
      throw new HTTPException(400, { message: "Google認証に失敗しました" });
    const t = (await r.json()) as any;
    await db
      .query("INSERT OR REPLACE INTO secrets VALUES('google',?)")
      .run(
        encrypt(
          JSON.stringify({ ...t, expiresAt: Date.now() + t.expires_in * 1000 })
        )
      );
    driveCache.clear();
    return c.redirect(`${origin}/?drive=connected`);
  });
  app.delete("/api/drive", async (c) => {
    if (configured() && (await secret())) {
      const t = JSON.parse(decrypt((await secret())!.value));
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }),
      });
    }
    await db.query("DELETE FROM secrets WHERE id='google'").run();
    driveCache.clear();
    return c.json({ connected: false });
  });
  app.get("/api/drive/files", async (c) => {
    const folder = c.req.query("folder") ?? "";
    if (folder && !/^[a-zA-Z0-9_-]+$/.test(folder))
      throw new HTTPException(400, { message: "フォルダIDが無効です" });
    // Authenticate before serving workspace-private cached data.
    await googleToken();
    const page = await driveCache.list(
      folder,
      c.req.query("pageToken") ?? "",
      c.req.query("refresh") === "1"
    );
    return c.json({
      ...page,
      files: page.files.map(({ thumbnailLink, ...file }) => ({
        ...file,
        ...(thumbnailLink
          ? { thumbnailUrl: `/api/drive/thumbnail/${file.id}?size=512` }
          : {}),
      })),
    });
  });
  app.get("/api/drive/thumbnail/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return c.body(null, 400);
    const size = c.req.query("size") === "1024" ? 1024 : 512;
    await googleToken();
    const preview = await driveCache.preview(id, size);
    const headers = {
      "Content-Type": preview.contentType,
      "Cache-Control": "private, max-age=300",
      ETag: preview.etag,
      Vary: "Authorization, Cookie",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    };
    if (c.req.header("If-None-Match") === preview.etag)
      return new Response(null, { status: 304, headers });
    return new Response(preview.bytes as BodyInit, { headers });
  });
  app.post("/api/drive/import", async (c) => {
    const b = await parse(c);
    await group(b.groupId);
    if (
      !Array.isArray(b.ids) ||
      !b.ids.length ||
      b.ids.length > 100 ||
      b.ids.some(
        (id: any) => typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)
      )
    )
      throw new HTTPException(400, {
        message: "画像を1〜100件選択してください",
      });
    await googleToken();
    // Cached list metadata avoids a separate round trip for every selected image.
    const imported: Artwork[] = await Promise.all(
      (b.ids as string[]).map(async (id) => {
        const f = await driveCache.file(id);
        if (!f.mimeType.startsWith("image/"))
          throw new HTTPException(400, {
            message: "画像ファイルのみ取り込めます",
          });
        const artworkId = `drive-${b.groupId}-${f.id}`;
        return (
          (await get<Artwork>("art", artworkId)) ?? {
            id: artworkId,
            driveId: f.id,
            title: f.name,
            groupId: b.groupId,
            collection: name(b.collection ?? "Google Drive"),
            url: `/api/drive/image/${f.id}`,
            tags: [],
            favorite: false,
            createdAt: new Date().toISOString(),
            source: "drive" as const,
          }
        );
      })
    );
    await db.batch(
      imported.map((a) => ({
        sql: "INSERT OR REPLACE INTO records(kind,id,data) VALUES (?,?,?)",
        args: ["art", a.id, JSON.stringify(a)],
      }))
    );
    return c.json({ artworks: imported }, 201);
  });
  app.get("/api/drive/image/:id", async (c) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(c.req.param("id"))) return c.body(null, 400);
    const access = await googleToken();
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${c.req.param(
        "id"
      )}?alt=media`,
      { headers: { Authorization: `Bearer ${access}` } }
    );
    if (!r.ok) return c.body(null, 502);
    if (!r.headers.get("content-type")?.startsWith("image/"))
      return c.body(null, 415);
    return new Response(r.body, {
      headers: {
        "Content-Type": r.headers.get("content-type")!,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  });
  return { app, db };
}
