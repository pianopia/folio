import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { openDatabase } from "./database";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Artwork, Group } from "@folio/shared";
import {
  cloudStorage,
  prepareImage,
  uploadDriveImage,
  DRIVE_FILE_SCOPE,
  MAX_UPLOAD_BYTES,
  type ObjectStorage,
} from "./uploads";
import { hash } from "./auth";
import { DriveCache } from "./drive-cache";
import {
  initializeAuth,
  setupAuth,
  type AuthEnv,
  type verifyGoogleIdentity,
} from "./auth";

type Options = {
  database?: string;
  token?: string;
  webOrigin?: string;
  legacyOwnerEmail?: string;
  verifyIdentity?: typeof verifyGoogleIdentity;
  objectStorage?: ObjectStorage;
};
export async function createApp(options: Options = {}) {
  const db = await openDatabase(options.database);
  await initializeAuth(db);
  await db
    .query(
      "CREATE TABLE IF NOT EXISTS drive_upload_folders (user_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL)",
    )
    .run();
  const objects = options.objectStorage ?? cloudStorage();
  let activeUploads = 0;
  const folderPending = new Map<string, Promise<string>>();
  const origin =
    options.webOrigin ?? process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173";
  const app = new Hono<AuthEnv>();
  app.use(
    "/api/*",
    cors({
      origin,
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use("/api/*", (c, next) =>
    bodyLimit({
      maxSize:
        c.req.path === "/api/artworks/upload" && c.req.method === "POST"
          ? MAX_UPLOAD_BYTES + 64 * 1024
          : 1024 * 1024,
      onError: (c) => c.json({ error: "画像は1枚20MB以下にしてください" }, 413),
    })(c, next),
  );
  app.onError((e, c) => {
    if (e instanceof HTTPException)
      return c.json({ error: e.message }, e.status);
    console.error(
      e instanceof SyntaxError ? "Invalid JSON request" : "Request failed",
    );
    return c.json(
      { error: "処理できませんでした。もう一度お試しください。" },
      e instanceof SyntaxError ? 400 : 500,
    );
  });
  const configured = () =>
    Boolean(
      process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        /^[a-fA-F0-9]{64}$/.test(process.env.TOKEN_ENCRYPTION_KEY ?? ""),
    );
  const encrypt = (value: string) => {
    const iv = randomBytes(12),
      cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(process.env.TOKEN_ENCRYPTION_KEY!, "hex"),
        iv,
      );
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  };
  const decrypt = (value: string) => {
    const data = Buffer.from(value, "base64"),
      cipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(process.env.TOKEN_ENCRYPTION_KEY!, "hex"),
        data.subarray(0, 12),
      );
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      cipher.update(data.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  };
  const secret = async (userId: string) =>
    (
      await db
        .query("SELECT value FROM drive_credentials WHERE user_id=?")
        .get(userId)
    )?.value;
  const caches = new Map<string, DriveCache>();
  const refreshing = new Map<string, Promise<string>>();
  const clear = (userId: string) => {
    caches.get(userId)?.clear();
    caches.delete(userId);
  };
  async function saveDrive(userId: string, tokens: any) {
    const previous = await secret(userId);
    const old = previous ? JSON.parse(decrypt(String(previous))) : {};
    await db
      .query(
        "INSERT OR REPLACE INTO drive_credentials(user_id,value) VALUES(?,?)",
      )
      .run(
        userId,
        encrypt(
          JSON.stringify({
            ...old,
            ...tokens,
            expiresAt: Date.now() + tokens.expires_in * 1000,
          }),
        ),
      );
    clear(userId);
  }
  const canUploadDrive = async (userId: string) => {
    const value = await secret(userId);
    if (!value) return false;
    const credentials = JSON.parse(decrypt(String(value)));
    const scopes = String(credentials?.scope ?? "").split(" ");
    return (
      scopes.includes(DRIVE_FILE_SCOPE) ||
      scopes.includes("https://www.googleapis.com/auth/drive")
    );
  };
  async function driveFolder(userId: string, access: string): Promise<string> {
    const existing = await db
      .query("SELECT folder_id FROM drive_upload_folders WHERE user_id=?")
      .get(userId);
    if (existing) return String(existing.folder_id);
    const pending = folderPending.get(userId);
    if (pending) return pending;
    const task = (async () => {
      const response = await fetch(
        "https://www.googleapis.com/drive/v3/files?fields=id",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "Folio uploads",
            mimeType: "application/vnd.google-apps.folder",
          }),
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok)
        throw new HTTPException(502, {
          message:
            "Driveの保存フォルダを作成できませんでした。追加権限・空き容量を確認してください",
        });
      const folder = (await response.json()) as { id: string };
      if (!/^[a-zA-Z0-9_-]+$/.test(folder.id)) throw new HTTPException(502);
      await db
        .query(
          "INSERT OR REPLACE INTO drive_upload_folders(user_id,folder_id) VALUES(?,?)",
        )
        .run(userId, folder.id);
      return folder.id;
    })().finally(() => folderPending.delete(userId));
    folderPending.set(userId, task);
    return task;
  }
  setupAuth(app, db, origin, configured, { ...options, saveDrive });
  async function googleToken(userId: string): Promise<string> {
    const encrypted = await secret(userId);
    if (!configured() || !encrypted)
      throw new HTTPException(409, {
        message: "Google Driveを接続してください",
      });
    const tokens = JSON.parse(decrypt(String(encrypted)));
    if (tokens.expiresAt > Date.now() + 60000) return tokens.access_token;
    if (refreshing.has(userId)) return refreshing.get(userId)!;
    const task = (async () => {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          refresh_token: tokens.refresh_token,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok)
        throw new HTTPException(409, {
          message: "Google Driveの再接続が必要です",
        });
      const fresh = (await r.json()) as any;
      // A disconnect while refresh is in flight must never recreate credentials.
      const result = await db
        .query(
          "UPDATE drive_credentials SET value=? WHERE user_id=? AND value=?",
        )
        .run(
          encrypt(
            JSON.stringify({
              ...tokens,
              ...fresh,
              expiresAt: Date.now() + fresh.expires_in * 1000,
            }),
          ),
          userId,
          String(encrypted),
        );
      if (!result.rowsAffected)
        throw new HTTPException(409, { message: "Drive接続が変更されました" });
      return fresh.access_token as string;
    })().finally(() => refreshing.delete(userId));
    refreshing.set(userId, task);
    return task;
  }
  function cache(userId: string) {
    let result = caches.get(userId);
    if (!result) {
      // Keep memory bounded across accounts; each cache is private to its owner.
      if (caches.size >= 16) {
        const oldest = caches.keys().next().value!;
        clear(oldest);
      }
      result = new DriveCache(() => googleToken(userId));
      caches.set(userId, result);
    }
    return result;
  }
  const parse = async (c: Context) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b))
      throw new HTTPException(400, { message: "有効なJSONが必要です" });
    return b;
  };
  const name = (v: unknown): string => {
    if (typeof v !== "string" || !v.trim() || v.trim().length > 120)
      throw new HTTPException(400, {
        message: "名前は1〜120文字で入力してください",
      });
    return v.trim();
  };
  const get = async <T>(kind: string, id: string): Promise<T | undefined> => {
    const row = await db
      .query("SELECT data FROM library_records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(String(row.data)) : undefined;
  };
  const save = async (kind: string, value: any) => {
    await db
      .query(
        "INSERT OR REPLACE INTO library_records(kind,id,owner_id,group_id,data) VALUES(?,?,?,?,?)",
      )
      .run(
        kind,
        value.id,
        value.ownerId,
        kind === "group" ? value.id : value.groupId,
        JSON.stringify(value),
      );
    return value;
  };
  async function requireGroup(
    userId: string,
    id: unknown,
    write = false,
  ): Promise<Group> {
    const group =
      typeof id === "string" ? await get<Group>("group", id) : undefined;
    if (
      !group ||
      (group.ownerId !== userId &&
        (write ||
          !(await db
            .query(
              "SELECT user_id FROM group_members WHERE group_id=? AND user_id=?",
            )
            .get(group.id, userId))))
    )
      throw new HTTPException(404, { message: "グループがありません" });
    return group;
  }
  async function requireArtwork(userId: string, id: string, write = false) {
    const art = await get<Artwork>("art", id);
    if (!art) throw new HTTPException(404, { message: "作品がありません" });
    await requireGroup(userId, art.groupId);
    if (write && art.ownerId !== userId) {
      const g = await get<Group>("group", art.groupId);
      if (g?.ownerId !== userId)
        throw new HTTPException(403, { message: "閲覧のみのグループです" });
    }
    return art;
  }
  app.get("/api/health", async (c) => {
    await db.query("SELECT 1 AS ok").get();
    return c.json({
      ok: true,
      storage: process.env.TURSO_DATABASE_URL ? "turso" : "sqlite",
    });
  });
  app.get("/api/library", async (c) => {
    const userId = c.get("user").id;
    const rows = await db
      .query(
        "SELECT data,kind FROM library_records WHERE group_id IN (SELECT id FROM library_records WHERE kind='group' AND owner_id=? UNION SELECT group_id FROM group_members WHERE user_id=?) ORDER BY rowid DESC",
      )
      .all(userId, userId);
    return c.json({
      groups: rows
        .filter((r) => r.kind === "group")
        .map((r) => JSON.parse(String(r.data))),
      artworks: rows
        .filter((r) => r.kind === "art")
        .map((r) => JSON.parse(String(r.data))),
    });
  });
  app.post("/api/groups", async (c) => {
    const b = await parse(c),
      id = crypto.randomUUID();
    return c.json(
      await save("group", {
        id,
        name: name(b.name),
        color: "#9b9be8",
        ownerId: c.get("user").id,
      }),
      201,
    );
  });
  app.get("/api/groups/:id/members", async (c) => {
    const g = await requireGroup(c.get("user").id, c.req.param("id"), true);
    const members = await db
      .query(
        "SELECT u.id,u.email,u.name FROM users u JOIN group_members m ON m.user_id=u.id WHERE m.group_id=?",
      )
      .all(g.id);
    return c.json({ members });
  });
  app.post("/api/groups/:id/members", async (c) => {
    const g = await requireGroup(c.get("user").id, c.req.param("id"), true);
    const b = await parse(c);
    const email =
      typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const user = await db
      .query("SELECT id FROM users WHERE email=?")
      .get(email);
    if (!user)
      throw new HTTPException(400, {
        message: "相手に先にFolioへGoogleログインしてもらってください",
      });
    if (user.id === g.ownerId)
      throw new HTTPException(400, {
        message: "オーナーはすでにアクセスできます",
      });
    await db
      .query(
        "INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)",
      )
      .run(g.id, String(user.id));
    return c.json({ added: true }, 201);
  });
  app.delete("/api/groups/:id/members/:userId", async (c) => {
    await requireGroup(c.get("user").id, c.req.param("id"), true);
    await db
      .query("DELETE FROM group_members WHERE group_id=? AND user_id=?")
      .run(c.req.param("id"), c.req.param("userId"));
    return c.body(null, 204);
  });
  app.patch("/api/artworks/:id", async (c) => {
    const userId = c.get("user").id,
      a = await requireArtwork(userId, c.req.param("id"), true),
      b = await parse(c);
    if (b.title !== undefined) a.title = name(b.title);
    if (b.groupId !== undefined && b.groupId !== a.groupId) {
      // Sharing an imported original into another group is the importer's decision.
      if (a.ownerId !== userId) throw new HTTPException(403);
      await requireGroup(userId, b.groupId, true);
      a.groupId = b.groupId;
    }
    if (b.collection !== undefined) a.collection = name(b.collection);
    if (b.favorite !== undefined) {
      if (typeof b.favorite !== "boolean") throw new HTTPException(400);
      a.favorite = b.favorite;
    }
    if (b.tags !== undefined) {
      if (!Array.isArray(b.tags) || b.tags.length > 20)
        throw new HTTPException(400);
      a.tags = b.tags.map(name);
    }
    return c.json(await save("art", a));
  });
  app.delete("/api/artworks/:id", async (c) => {
    const art = await requireArtwork(c.get("user").id, c.req.param("id"), true);
    await db
      .query("DELETE FROM library_records WHERE kind='art' AND id=?")
      .run(c.req.param("id"));
    if (art.source === "storage" && art.storageKey && objects) {
      const results = await Promise.allSettled(
        ["original", "512.webp", "1024.webp"].map((suffix) =>
          objects.remove(`${art.storageKey}/${suffix}`),
        ),
      );
      if (results.some((r) => r.status === "rejected"))
        console.error("Upload object cleanup failed");
    }
    return c.body(null, 204);
  });
  app.get("/api/uploads/status", async (c) => {
    const drive = Boolean(await secret(c.get("user").id));
    const writable = drive && (await canUploadDrive(c.get("user").id));
    return c.json({
      destination: drive ? "drive" : "storage",
      canUpload: drive ? writable : Boolean(objects),
      reauthRequired: drive && !writable,
      maxBytes: MAX_UPLOAD_BYTES,
    });
  });
  app.post("/api/artworks/upload", async (c) => {
    if (activeUploads >= 2)
      throw new HTTPException(429, {
        message: "アップロードが混み合っています。少し待って再試行してください",
      });
    activeUploads++;
    try {
      const userId = c.get("user").id;
      const form = await c.req.formData().catch(() => {
        throw new HTTPException(400, {
          message: "画像ファイルを選択してください",
        });
      });
      const groupId = String(form.get("groupId") ?? "");
      await requireGroup(userId, groupId, true);
      const file = form.get("file");
      if (!(file instanceof File))
        throw new HTTPException(400, {
          message: "画像ファイルを選択してください",
        });
      const title = name(
        form.get("title") || file.name.replace(/\.[^.]+$/, "").slice(0, 120),
      );
      const collection = name(form.get("collection") || "Uploads");
      const drive = Boolean(await secret(userId));
      if (drive && !(await canUploadDrive(userId)))
        throw new HTTPException(409, {
          message:
            "Driveへの保存に追加権限が必要です。「アップロード権限を追加」から再接続してください",
        });
      if (!drive && !objects)
        throw new HTTPException(503, {
          message: "Cloud Storageの保存先が未設定です",
        });
      const image = await prepareImage(file);
      const id = crypto.randomUUID();
      const artwork: Artwork = {
        id,
        ownerId: userId,
        title,
        groupId,
        collection,
        url: `/api/artworks/${id}/image`,
        tags: [],
        favorite: false,
        createdAt: new Date().toISOString(),
        source: drive ? "drive" : "storage",
        uploaded: true,
        contentType: image.contentType,
      };
      if (drive) {
        const access = await googleToken(userId);
        const folder = await driveFolder(userId, access);
        const uploaded = await uploadDriveImage(access, folder, image);
        artwork.driveId = uploaded.id;
        try {
          await save("art", artwork);
        } catch (error) {
          // Only remove the just-created file when its library registration failed.
          await fetch(
            `https://www.googleapis.com/drive/v3/files/${uploaded.id}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${access}` },
              signal: AbortSignal.timeout(20000),
            },
          ).catch(() => {});
          throw error;
        }
        cache(userId).clear();
        cache(userId).remember(uploaded);
        cache(userId).seedPreview(uploaded.id, 512, image.previews[512]);
        cache(userId).seedPreview(uploaded.id, 1024, image.previews[1024]);
      } else {
        const key = `users/${hash(userId)}/${id}`;
        artwork.storageKey = key;
        const paths = [
          `${key}/original`,
          `${key}/512.webp`,
          `${key}/1024.webp`,
        ];
        try {
          await objects!.save(paths[0], image.bytes, image.contentType);
          await objects!.save(paths[1], image.previews[512], "image/webp");
          await objects!.save(paths[2], image.previews[1024], "image/webp");
          await save("art", artwork);
        } catch {
          await Promise.allSettled(paths.map((path) => objects!.remove(path)));
          throw new HTTPException(502, {
            message: "Cloud Storageへの保存に失敗しました。再試行してください",
          });
        }
      }
      return c.json(artwork, 201);
    } finally {
      activeUploads--;
    }
  });
  app.post("/api/artworks", async (c) => {
    const b = await parse(c);
    await requireGroup(c.get("user").id, b.groupId, true);
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
        ownerId: c.get("user").id,
        title: name(b.title),
        groupId: b.groupId,
        collection: name(b.collection ?? "Unsorted"),
        url: url.href,
        tags: [],
        favorite: false,
        createdAt: new Date().toISOString(),
        source: "sample",
      }),
      201,
    );
  });
  app.get("/api/drive/status", async (c) =>
    c.json({
      configured: configured(),
      connected: configured() && Boolean(await secret(c.get("user").id)),
    }),
  );
  app.delete("/api/drive", async (c) => {
    const userId = c.get("user").id,
      encrypted = await secret(userId);
    if (encrypted) {
      const tokens = JSON.parse(decrypt(String(encrypted)));
      const r = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: tokens.refresh_token ?? tokens.access_token,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok && r.status !== 400)
        throw new HTTPException(502, {
          message: "Google側の接続解除に失敗しました",
        });
    }
    await db.query("DELETE FROM drive_credentials WHERE user_id=?").run(userId);
    clear(userId);
    return c.json({ connected: false });
  });
  app.get("/api/drive/files", async (c) => {
    const userId = c.get("user").id,
      folder = c.req.query("folder") ?? "";
    if (folder && !/^[a-zA-Z0-9_-]+$/.test(folder))
      throw new HTTPException(400);
    await googleToken(userId);
    const page = await cache(userId).list(
      folder,
      c.req.query("pageToken") ?? "",
      c.req.query("refresh") === "1",
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
  async function thumbnail(c: Context, userId: string, id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HTTPException(400);
    await googleToken(userId);
    const preview = await cache(userId).preview(
      id,
      c.req.query("size") === "1024" ? 1024 : 512,
    );
    // No browser/disk caching: logout or removed membership must take effect on the next request.
    return new Response(preview.bytes as BodyInit, {
      headers: {
        "Content-Type": preview.contentType,
        "Cache-Control": "no-store",
        Vary: "Authorization, Cookie",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }
  async function image(userId: string, id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HTTPException(400);
    const access = await googleToken(userId);
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
      {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!r.ok)
      throw new HTTPException(502, { message: "画像を取得できませんでした" });
    if (!r.headers.get("content-type")?.startsWith("image/"))
      throw new HTTPException(415);
    return new Response(r.body, {
      headers: {
        "Content-Type": r.headers.get("content-type")!,
        "Cache-Control": "no-store",
        Vary: "Authorization, Cookie",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }
  app.get("/api/drive/thumbnail/:id", (c) =>
    thumbnail(c, c.get("user").id, c.req.param("id")),
  );
  app.get("/api/drive/image/:id", (c) =>
    image(c.get("user").id, c.req.param("id")),
  );
  async function storageImage(art: Artwork, size?: 512 | 1024) {
    if (!objects || !art.storageKey) throw new HTTPException(404);
    const bytes = await objects.read(
      `${art.storageKey}/${size ? `${size}.webp` : "original"}`,
    );
    return new Response(bytes as BodyInit, {
      headers: {
        "Content-Type": size
          ? "image/webp"
          : (art.contentType ?? "application/octet-stream"),
        "Cache-Control": "no-store",
        Vary: "Authorization, Cookie",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }
  app.get("/api/artworks/:id/thumbnail", async (c) => {
    const art = await requireArtwork(c.get("user").id, c.req.param("id"));
    if (art.source === "storage")
      return storageImage(art, c.req.query("size") === "1024" ? 1024 : 512);
    if (art.source !== "drive" || !art.driveId || !art.ownerId)
      throw new HTTPException(404);
    return thumbnail(c, art.ownerId, art.driveId);
  });
  app.get("/api/artworks/:id/image", async (c) => {
    const art = await requireArtwork(c.get("user").id, c.req.param("id"));
    if (art.source === "storage") return storageImage(art);
    if (art.source !== "drive" || !art.driveId || !art.ownerId)
      throw new HTTPException(404);
    return image(art.ownerId, art.driveId);
  });
  app.post("/api/drive/import", async (c) => {
    const b = await parse(c),
      userId = c.get("user").id;
    await requireGroup(userId, b.groupId, true);
    if (
      !Array.isArray(b.ids) ||
      !b.ids.length ||
      b.ids.length > 100 ||
      b.ids.some(
        (id: any) => typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id),
      )
    )
      throw new HTTPException(400, {
        message: "画像を1〜100件選択してください",
      });
    const collection = name(b.collection ?? "Google Drive");
    await googleToken(userId);
    const imported: Artwork[] = await Promise.all(
      (b.ids as string[]).map(async (id) => {
        const f = await cache(userId).file(id);
        if (!f.mimeType.startsWith("image/"))
          throw new HTTPException(400, {
            message: "画像ファイルのみ取り込めます",
          });
        // Owner identity is included even if multiple users import the same Drive ID.
        const artworkId = `drive-${userId}-${b.groupId}-${f.id}`;
        return (
          (await get<Artwork>("art", artworkId)) ?? {
            id: artworkId,
            ownerId: userId,
            driveId: f.id,
            title: f.name,
            groupId: b.groupId,
            collection,
            url: `/api/artworks/${encodeURIComponent(artworkId)}/image`,
            tags: [],
            favorite: false,
            createdAt: new Date().toISOString(),
            source: "drive" as const,
          }
        );
      }),
    );
    await db.batch(
      imported.map((a) => ({
        sql: "INSERT OR REPLACE INTO library_records(kind,id,owner_id,group_id,data) VALUES('art',?,?,?,?)",
        args: [a.id, userId, a.groupId, JSON.stringify(a)],
      })),
    );
    return c.json({ artworks: imported }, 201);
  });
  return { app, db };
}
