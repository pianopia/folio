import { test, expect } from "bun:test";
import sharp from "sharp";
import { createApp } from "./src/app";
import { addUser, alice, bob, client } from "./test-support";
import { DRIVE_FILE_SCOPE, type ObjectStorage } from "./src/uploads";
import { createCipheriv, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
const origin = "https://folio.example";
function memoryStorage() {
  const data = new Map<string, { bytes: Uint8Array; type: string }>();
  const sessions = new Map<string, string>();
  let sessionNumber = 0;
  const backend: ObjectStorage = {
    async save(key, bytes, type) {
      data.set(key, { bytes, type });
    },
    async read(key) {
      if (!data.has(key)) throw Error("not found");
      return data.get(key)!.bytes;
    },
    async remove(key) {
      data.delete(key);
    },
    async createResumableUpload(key) {
      const url = `https://session.example/${++sessionNumber}`;
      sessions.set(url, key);
      return url;
    },
    async stat(key) {
      const item = data.get(key);
      if (!item) throw Error("not found");
      return { size: item.bytes.byteLength, contentType: item.type };
    },
    openRead(key) {
      const item = data.get(key);
      if (!item) throw Error("not found");
      return Readable.from([item.bytes]);
    },
  };
  return { backend, data, sessions, uploadSession(url: string, bytes: Uint8Array, type = "image/jpeg") {
    const key = sessions.get(url);
    if (!key) throw Error("unknown session");
    data.set(key, { bytes, type });
  } };
}
async function png() {
  return sharp({
    create: { width: 64, height: 48, channels: 4, background: "#5b7b46" },
  })
    .png()
    .toBuffer();
}
function post(
  app: Awaited<ReturnType<typeof createApp>>["app"],
  token: string,
  groupId: string,
  bytes: Uint8Array,
  fileType = "image/png",
  filename = "Artwork.png",
) {
  const body = new FormData();
  body.append("groupId", groupId);
  body.append("collection", "Uploads");
  body.append(
    "file",
    new File([bytes as BlobPart], filename, { type: fileType }),
  );
  return app.request(origin + "/api/artworks/upload", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body,
  });
}

test("unconnected users upload private originals and bounded previews to Storage; group sharing checks every media request", async () => {
  const store = memoryStorage(),
    { app, db } = await createApp({
      database: ":memory:",
      webOrigin: origin,
      objectStorage: store.backend,
    });
  try {
    await addUser(db, alice, "a");
    await addUser(db, bob, "b");
    const a = client(app, "a"),
      b = client(app, "b");
    const group = await (
      await a("/groups", "POST", { name: "Uploads" })
    ).json();
    expect((await (await a("/uploads/status")).json()).destination).toBe(
      "storage",
    );
    const original = await png();
    expect((await post(app, "b", group.id, original)).status).toBe(404);
    expect((await post(app, "", group.id, original)).status).toBe(401);
    const response = await post(app, "a", group.id, original);
    expect(response.status).toBe(201);
    const art = await response.json();
    expect(art.source).toBe("storage");
    expect(art.ownerId).toBe(alice.id);
    expect(art.contentType).toBe("image/png");
    expect(store.data.size).toBe(3);
    const loaded = await a(`/artworks/${art.id}/image`);
    expect(loaded.status).toBe(200);
    expect(Buffer.from(await loaded.arrayBuffer())).toEqual(original);
    expect(loaded.headers.get("Cache-Control")).toBe("no-store");
    const preview = await a(`/artworks/${art.id}/thumbnail?size=512`);
    expect(preview.headers.get("content-type")).toBe("image/webp");
    expect(
      (await sharp(await preview.arrayBuffer()).metadata()).width,
    ).toBeLessThanOrEqual(512);
    expect((await b(`/artworks/${art.id}/image`)).status).toBe(404);
    await a(`/groups/${group.id}/members`, "POST", { email: bob.email });
    expect((await b(`/artworks/${art.id}/thumbnail`)).status).toBe(200);
    expect((await b(`/artworks/${art.id}/image`)).status).toBe(200);
    expect((await post(app, "b", group.id, original)).status).toBe(404);
    await a(`/groups/${group.id}/members/${bob.id}`, "DELETE");
    expect((await b(`/artworks/${art.id}/thumbnail`)).status).toBe(404);
    expect((await a(`/artworks/${art.id}`, "DELETE")).status).toBe(204);
    expect(store.data.size).toBe(0);
    expect((await a(`/artworks/${art.id}/image`)).status).toBe(404);
  } finally {
    db.close();
  }
});

test("rejects disguised SVG/HTML, invalid image payloads, oversized files and unsupported formats without creating objects", async () => {
  const store = memoryStorage(),
    { app, db } = await createApp({
      database: ":memory:",
      webOrigin: origin,
      objectStorage: store.backend,
    });
  try {
    await addUser(db, alice, "a");
    const a = client(app, "a");
    const group = await (
      await a("/groups", "POST", { name: "Private" })
    ).json();
    for (const content of [
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
      "<html>not an image</html>",
    ])
      expect(
        (await post(app, "a", group.id, new TextEncoder().encode(content)))
          .status,
      ).toBe(415);
    expect(
      (await post(app, "a", group.id, new Uint8Array(20 * 1024 * 1024 + 1)))
        .status,
    ).toBe(413);
    const over = await sharp({
      create: { width: 6000, height: 6000, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    expect((await post(app, "a", group.id, over)).status).toBe(415);
    expect(store.data.size).toBe(0);
    expect((await (await a("/library")).json()).artworks).toHaveLength(0);
    // Actual decoded format, rather than caller-supplied MIME type, determines stored content type.
    const image = await (
      await post(app, "a", group.id, await png(), "text/html", "photo.html")
    ).json();
    expect(image.contentType).toBe("image/png");
  } finally {
    db.close();
  }
});

test("failed Storage writes roll back created objects and never create a library record", async () => {
  const store = memoryStorage();
  let writes = 0;
  const broken = {
    ...store.backend,
    async save(key: string, bytes: Uint8Array, type: string) {
      if (++writes === 2) throw Error("unavailable");
      await store.backend.save(key, bytes, type);
    },
  };
  const { app, db } = await createApp({
    database: ":memory:",
    webOrigin: origin,
    objectStorage: broken,
  });
  try {
    await addUser(db, alice, "a");
    const a = client(app, "a");
    const group = await (
      await a("/groups", "POST", { name: "Private" })
    ).json();
    expect((await post(app, "a", group.id, await png())).status).toBe(502);
    expect(store.data.size).toBe(0);
    expect((await (await a("/library")).json()).artworks).toHaveLength(0);
  } finally {
    db.close();
  }
});

test("direct upload validates init, streams finalization, and is idempotent", async () => {
  const store = memoryStorage(), { app, db } = await createApp({ database: ":memory:", webOrigin: origin, objectStorage: store.backend });
  try {
    await addUser(db, alice, "a"); await addUser(db, bob, "b");
    const a = client(app, "a"), b = client(app, "b");
    const group = await (await a("/groups", "POST", { name: "Textures" })).json();
    const status = await (await a("/uploads/status")).json();
    expect(status.maxBytes).toBe(20 * 1024 * 1024);
    expect(status.maxDirectBytes).toBe(100 * 1024 * 1024);
    expect(status.maxPixels).toBe(64_000_000);
    const valid = { groupId: group.id, filename: "field.jpg", contentType: "image/png", size: (await png()).byteLength, collection: "Textures" };
    expect((await a("/uploads/init", "POST", { ...valid, size: 100 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await a("/uploads/init", "POST", { ...valid, contentType: "image/svg+xml" })).status).toBe(415);
    expect((await b("/uploads/init", "POST", valid)).status).toBe(404);
    const original = await png();
    const initialized = await a("/uploads/init", "POST", { ...valid, size: original.byteLength });
    expect(initialized.status).toBe(201);
    const session = await initialized.json();
    expect(session.method).toBe("PUT");
    expect(session.headers["Content-Range"]).toBe(`bytes 0-${original.byteLength - 1}/${original.byteLength}`);
    expect((await b(`/uploads/${session.uploadId}/complete`, "POST", {})).status).toBe(404);
    store.uploadSession(session.uploadUrl, original, "image/png");
    const completed = await a(`/uploads/${session.uploadId}/complete`, "POST", {});
    expect(completed.status).toBe(201);
    const art = await completed.json();
    expect(art.source).toBe("storage"); expect(art.contentType).toBe("image/png");
    expect(store.data.size).toBe(3);
    const repeated = await a(`/uploads/${session.uploadId}/complete`, "POST", {});
    expect(repeated.status).toBe(200); expect((await repeated.json()).id).toBe(art.id);
    expect((await a(`/artworks/${art.id}/image`)).status).toBe(200);
  } finally { db.close(); }
});

test("direct completion rejects size mismatches, corrupt images, and expired sessions", async () => {
  const store = memoryStorage(), { app, db } = await createApp({ database: ":memory:", webOrigin: origin, objectStorage: store.backend });
  try {
    await addUser(db, alice, "a");
    const a = client(app, "a"), group = await (await a("/groups", "POST", { name: "Textures" })).json();
    const image = await png();
    const init = async (size = image.byteLength) => a("/uploads/init", "POST", { groupId: group.id, filename: "photo.png", contentType: "image/png", size });
    const mismatch = await (await init(image.byteLength + 1)).json();
    store.uploadSession(mismatch.uploadUrl, image, "image/png");
    expect((await a(`/uploads/${mismatch.uploadId}/complete`, "POST", {})).status).toBe(413);
    const corruptBytes = new TextEncoder().encode("not an image");
    const corrupt = await (await init(corruptBytes.byteLength)).json();
    store.uploadSession(corrupt.uploadUrl, corruptBytes, "image/png");
    expect((await a(`/uploads/${corrupt.uploadId}/complete`, "POST", {})).status).toBe(415);
    const expired = await (await init()).json();
    await db.query("UPDATE pending_uploads SET expires_at=? WHERE upload_id=?").run(Date.now() - 1, expired.uploadId);
    expect((await a(`/uploads/${expired.uploadId}/complete`, "POST", {})).status).toBe(410);
  } finally { db.close(); }
});

test("connected users upload only to their Drive; old read-only grants request reauthorization and never fall back to Storage", async () => {
  const previous = { ...process.env },
    originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture-secret",
    TOKEN_ENCRYPTION_KEY: "d".repeat(64),
  });
  function encrypt(value: unknown) {
    const iv = randomBytes(12),
      cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from("d".repeat(64), "hex"),
        iv,
      );
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  let calls: string[] = [],
    failUpload = false;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer alice-drive-access",
    );
    if (url === "https://www.googleapis.com/drive/v3/files?fields=id")
      return Response.json({ id: "own-folder" });
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files?")) {
      expect(new Headers(init?.headers).get("Content-Type")).toContain(
        "multipart/related",
      );
      expect(await (init?.body as Blob).text()).toContain(
        '"parents":["own-folder"]',
      );
      return failUpload
        ? new Response(null, { status: 403 })
        : Response.json({
            id: "uploaded-file",
            name: "Artwork.png",
            mimeType: "image/png",
            thumbnailVersion: "1",
          });
    }
    throw Error("Unexpected upload provider request");
  }) as typeof fetch;
  const store = memoryStorage(),
    { app, db } = await createApp({
      database: ":memory:",
      webOrigin: origin,
      objectStorage: store.backend,
    });
  try {
    await addUser(db, alice, "a");
    await addUser(db, bob, "b");
    const a = client(app, "a"),
      b = client(app, "b");
    const group = await (
      await a("/groups", "POST", { name: "Private" })
    ).json();
    const credentials = {
      access_token: "alice-drive-access",
      refresh_token: "refresh",
      scope: "https://www.googleapis.com/auth/drive.readonly",
      expiresAt: Date.now() + 3600000,
    };
    await db
      .query("INSERT INTO drive_credentials(user_id,value) VALUES(?,?)")
      .run(alice.id, encrypt(credentials));
    expect((await (await a("/uploads/status")).json()).reauthRequired).toBe(
      true,
    );
    expect((await post(app, "a", group.id, await png())).status).toBe(409);
    expect(calls).toHaveLength(0);
    expect(store.data.size).toBe(0);
    credentials.scope += " https://www.googleapis.com/auth/drive.file";
    await db
      .query("UPDATE drive_credentials SET value=? WHERE user_id=?")
      .run(encrypt(credentials), alice.id);
    const result = await post(app, "a", group.id, await png());
    expect(result.status).toBe(201);
    const art = await result.json();
    expect(art.source).toBe("drive");
    expect(art.driveId).toBe("uploaded-file");
    expect(store.data.size).toBe(0);
    // Prepared previews are immediately available without fetching or exposing the original.
    expect((await a(`/artworks/${art.id}/thumbnail`)).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect((await b(`/artworks/${art.id}/thumbnail`)).status).toBe(404);
    failUpload = true;
    expect((await post(app, "a", group.id, await png())).status).toBe(403);
    expect(store.data.size).toBe(0);
    expect((await (await a("/library")).json()).artworks).toHaveLength(1);
  } finally {
    db.close();
    globalThis.fetch = originalFetch;
    for (const key of [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "TOKEN_ENCRYPTION_KEY",
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("direct upload creates and finalizes a Drive resumable session with mocked Google APIs", async () => {
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "fixture-secret", TOKEN_ENCRYPTION_KEY: "d".repeat(64) });
  function encrypt(value: unknown) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from("d".repeat(64), "hex"), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  const image = await png();
  let calls: string[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "https://www.googleapis.com/drive/v3/files?fields=id") return Response.json({ id: "drive-folder" });
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files?")) {
      expect(new Headers(init?.headers).get("X-Upload-Content-Length")).toBe(String(image.byteLength));
      expect(new Headers(init?.headers).get("X-Upload-Content-Type")).toBe("image/png");
      return new Response(null, { status: 200, headers: { Location: "https://drive-session.example/upload" } });
    }
    if (url === "https://drive-session.example/upload") return Response.json({ id: "direct-drive-file" });
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/direct-drive-file?fields=")) return Response.json({ id: "direct-drive-file", name: "texture.png", size: String(image.byteLength), mimeType: "image/png", parents: ["drive-folder"], imageMediaMetadata: { width: 64, height: 48 } });
    if (url === "https://www.googleapis.com/drive/v3/files/direct-drive-file/?alt=media") return new Response(image, { headers: { "Content-Type": "image/png" } });
    throw Error(`Unexpected Drive request: ${url}`);
  }) as typeof fetch;
  const { app, db } = await createApp({ database: ":memory:", webOrigin: origin, objectStorage: memoryStorage().backend });
  try {
    await addUser(db, alice, "a");
    const a = client(app, "a");
    const group = await (await a("/groups", "POST", { name: "Textures" })).json();
    await db.query("INSERT INTO drive_credentials(user_id,value) VALUES(?,?)").run(alice.id, encrypt({ access_token: "alice-drive-access", refresh_token: "refresh", scope: `${DRIVE_FILE_SCOPE}`, expiresAt: Date.now() + 3600000 }));
    const init = await a("/uploads/init", "POST", { groupId: group.id, filename: "texture.png", contentType: "image/png", size: image.byteLength });
    expect(init.status).toBe(201);
    const session = await init.json();
    expect(session.uploadUrl).toBe("https://drive-session.example/upload");
    const completed = await a(`/uploads/${session.uploadId}/complete`, "POST", {});
    expect(completed.status).toBe(201);
    expect(await completed.json()).toMatchObject({ source: "drive", driveId: "direct-drive-file", groupId: group.id });
    expect(calls.some((call) => call.includes("uploadType=resumable"))).toBe(true);
    expect(calls.some((call) => call.includes("alt=media"))).toBe(true);
  } finally {
    db.close(); globalThis.fetch = originalFetch;
    for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
