import { test, expect } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { createApp } from "./src/app";
import { hash } from "./src/auth";
import { addUser, alice, bob, client } from "./test-support";
function encrypt(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(process.env.TOKEN_ENCRYPTION_KEY!, "hex"),
      iv,
    );
  const data = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
test("deletion is confirmed, private to the caller, retryable and blocks in-flight writes; Drive originals and other accounts survive", async () => {
  const old = process.env.TOKEN_ENCRYPTION_KEY,
    originalFetch = globalThis.fetch;
  process.env.TOKEN_ENCRYPTION_KEY = "29".repeat(32);
  const data = new Set<string>(),
    removed: string[] = [],
    revoked: string[] = [];
  let fail = true;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://oauth2.googleapis.com/revoke");
    expect(init?.method).toBe("POST");
    revoked.push(
      String(new URLSearchParams(init!.body as URLSearchParams).get("token")),
    );
    return new Response("", { status: 200 });
  }) as typeof fetch;
  const { app, db } = await createApp({
    database: ":memory:",
    webOrigin: "https://folio.example",
    objectStorage: {
      save: async () => {},
      read: async () => new Uint8Array(),
      remove: async (key) => {
        if (fail && key.endsWith("512.webp")) throw Error("storage down");
        removed.push(key);
        data.delete(key);
      },
    },
    appleAuth: {
      revoke: async (token) => {
        revoked.push(token);
      },
    },
  });
  const a = client(app, "a"),
    b = client(app, "b");
  try {
    await addUser(db, alice, "a");
    await addUser(db, alice, "a-other");
    await addUser(db, bob, "b");
    const ga = await (
        await a("/groups", "POST", { name: "Alice private" })
      ).json(),
      gb = await (await b("/groups", "POST", { name: "Bob private" })).json();
    await a(`/groups/${ga.id}/members`, "POST", { email: bob.email });
    for (const [owner, group, id] of [
      [alice, ga, "alice-image"],
      [bob, gb, "bob-image"],
    ] as const) {
      const key = `users/${hash(owner.id)}/${id}`;
      for (const suffix of ["original", "512.webp", "1024.webp"])
        data.add(`${key}/${suffix}`);
      await db
        .query(
          "INSERT INTO library_records(kind,id,owner_id,group_id,data) VALUES('art',?,?,?,?)",
        )
        .run(
          id,
          owner.id,
          group.id,
          JSON.stringify({
            id,
            ownerId: owner.id,
            groupId: group.id,
            source: "storage",
            storageKey: key,
          }),
        );
    }
    await db
      .query("INSERT INTO drive_credentials(user_id,value) VALUES(?,?)")
      .run(
        alice.id,
        encrypt(JSON.stringify({ refresh_token: "google-alice-refresh" })),
      );
    await db
      .query(
        "INSERT INTO apple_accounts(subject,user_id,refresh_token) VALUES(?,?,?)",
      )
      .run("apple-alice", alice.id, encrypt("apple-alice-refresh"));
    await db
      .query("INSERT INTO drive_upload_folders(user_id,folder_id) VALUES(?,?)")
      .run(alice.id, "original-folder-keep");
    await db
      .query("INSERT INTO records(kind,id,data) VALUES('art','legacy','{}')")
      .run();
    await db
      .query(
        "INSERT INTO secrets(id,value) VALUES('user-isolation-migration',?)",
      )
      .run(alice.id);
    expect((await a("/account", "DELETE", {})).status).toBe(400);
    expect(data.size).toBe(6);
    expect(
      (await a("/account", "DELETE", { confirmation: "DELETE" })).status,
    ).toBe(502);
    expect((await (await a("/auth/me")).json()).deletionPending).toBe(true);
    expect((await a("/library")).status).toBe(403);
    expect((await b("/artworks/alice-image/image")).status).toBe(404);
    await expect(
      db
        .query(
          "INSERT INTO library_records(kind,id,owner_id,group_id,data) VALUES('art','late',?,?, '{}')",
        )
        .run(alice.id, ga.id),
    ).rejects.toBeTruthy();
    await expect(
      db.query("UPDATE users SET name='late' WHERE id=?").run(alice.id),
    ).rejects.toBeTruthy();
    expect((await b("/library")).status).toBe(200);
    fail = false;
    expect(
      (await a("/account", "DELETE", { confirmation: "DELETE" })).status,
    ).toBe(204);
    expect(revoked).toEqual(["apple-alice-refresh", "google-alice-refresh"]);
    expect(data.size).toBe(3);
    expect(
      removed.every((key) => key.startsWith(`users/${hash(alice.id)}/`)),
    ).toBe(true);
    for (const table of [
      "users",
      "user_sessions",
      "library_records",
      "drive_credentials",
      "drive_upload_folders",
      "apple_accounts",
    ]) {
      const column =
        table === "users"
          ? "id"
          : table === "library_records"
            ? "owner_id"
            : "user_id";
      expect(
        await db
          .query(`SELECT * FROM ${table} WHERE ${column}=?`)
          .get(alice.id),
      ).toBeUndefined();
    }
    expect(await db.query("SELECT * FROM records").get()).toBeUndefined();
    expect(
      await db.query("SELECT * FROM group_members WHERE group_id=?").get(ga.id),
    ).toBeUndefined();
    expect((await a("/library")).status).toBe(401);
    expect((await client(app, "a-other")("/library")).status).toBe(401);
    expect((await b("/artworks/bob-image/image")).status).toBe(200);
    await expect(
      db
        .query("INSERT INTO users(id,email,name) VALUES(?,?,?)")
        .run(alice.id, alice.email, alice.name),
    ).rejects.toBeTruthy();
  } finally {
    db.close();
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = old;
  }
});
