import { describe, test, expect } from "bun:test";
import { createApp } from "./src/app";
import { alice, bob, addUser, client } from "./test-support";
import { hash, migrateLegacy } from "./src/auth";

describe("account and group isolation", () => {
  test("rejects legacy tokens and revoked/expired sessions; never exposes private records through group or object IDs", async () => {
    const { app, db } = await createApp({
      database: ":memory:",
      token: "old-shared-key",
      webOrigin: "https://folio.example",
    });
    await addUser(db, alice, "alice-session");
    await addUser(db, bob, "bob-session");
    const a = client(app, "alice-session"),
      b = client(app, "bob-session"),
      legacy = client(app, "old-shared-key");
    try {
      expect(
        (await app.request("https://folio.example/api/health")).status,
      ).toBe(200);
      for (const path of [
        "/library",
        "/drive/status",
        "/drive/files",
        "/drive/thumbnail/private",
        "/drive/image/private",
      ]) {
        expect(
          (await app.request(`https://folio.example/api${path}`)).status,
        ).toBe(401);
        expect((await legacy(path)).status).toBe(401);
        expect(
          (
            await app.request(`https://folio.example/api${path}`, {
              headers: { Cookie: "folio_session=old-shared-key" },
            })
          ).status,
        ).toBe(401);
      }
      expect((await legacy("/session", "POST")).status).toBe(401);
      expect(
        (
          await a(
            "/groups",
            "POST",
            { name: "x" },
            { Origin: "https://evil.example" },
          )
        ).status,
      ).toBe(403);
      expect((await a("/groups", "POST", null)).status).toBe(400);
      expect((await a("/groups", "POST", { name: " " })).status).toBe(400);
      const privateGroup = await (
        await a("/groups", "POST", { name: "Alice private" })
      ).json();
      const sharedGroup = await (
        await a("/groups", "POST", { name: "Selected works" })
      ).json();
      const bobGroup = await (
        await b("/groups", "POST", { name: "Bob private" })
      ).json();
      const add = async (groupId: string) =>
        await (
          await a("/artworks", "POST", {
            title: "Original",
            url: "https://example.com/image.png",
            groupId,
          })
        ).json();
      const privateArt = await add(privateGroup.id),
        sharedArt = await add(sharedGroup.id);
      expect(
        (
          await a("/artworks", "POST", {
            title: "Bad",
            url: "javascript:alert(1)",
            groupId: privateGroup.id,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await a("/artworks", "POST", {
            title: "No access",
            url: "https://example.com/image.png",
            groupId: bobGroup.id,
          })
        ).status,
      ).toBe(404);
      expect(
        (await b(`/artworks/${privateArt.id}`, "PATCH", { title: "Stolen" }))
          .status,
      ).toBe(404);
      expect((await b(`/artworks/${privateArt.id}`, "DELETE")).status).toBe(
        404,
      );
      expect((await b(`/artworks/${privateArt.id}/image`)).status).toBe(404);
      expect((await b(`/artworks/${privateArt.id}/thumbnail`)).status).toBe(
        404,
      );
      expect((await b(`/groups/${privateGroup.id}/members`)).status).toBe(404);
      expect(
        (
          await b(`/groups/${privateGroup.id}/members`, "POST", {
            email: bob.email,
          })
        ).status,
      ).toBe(404);
      expect((await (await b("/library")).json()).artworks).toHaveLength(0);
      expect(
        (
          await a(`/groups/${sharedGroup.id}/members`, "POST", {
            email: bob.email,
          })
        ).status,
      ).toBe(201);
      const shared = await (await b("/library")).json();
      expect(shared.artworks.map((x: any) => x.id)).toEqual([sharedArt.id]);
      expect(shared.groups.some((g: any) => g.id === privateGroup.id)).toBe(
        false,
      );
      expect(
        (
          await b(`/artworks/${sharedArt.id}`, "PATCH", {
            groupId: bobGroup.id,
          })
        ).status,
      ).toBe(403);
      expect((await b(`/artworks/${sharedArt.id}`, "DELETE")).status).toBe(403);
      expect(
        (await b(`/groups/${sharedGroup.id}/members/${alice.id}`, "DELETE"))
          .status,
      ).toBe(404);
      expect(
        (
          await b("/drive/import", "POST", {
            groupId: sharedGroup.id,
            ids: ["private"],
          })
        ).status,
      ).toBe(404);
      expect(
        (await a(`/artworks/${privateArt.id}`, "PATCH", { favorite: "yes" }))
          .status,
      ).toBe(400);
      expect(
        (
          await a(`/artworks/${privateArt.id}`, "PATCH", {
            title: "Edited",
            favorite: true,
            tags: ["ok"],
          })
        ).status,
      ).toBe(200);
      expect(
        (await a(`/groups/${sharedGroup.id}/members/${bob.id}`, "DELETE"))
          .status,
      ).toBe(204);
      expect((await b(`/artworks/${sharedArt.id}/thumbnail`)).status).toBe(404);
      expect((await (await b("/library")).json()).artworks).toHaveLength(0);
      expect((await a("/library")).headers.get("Cache-Control")).toBe(
        "no-store",
      );
      expect((await a("/session", "DELETE")).status).toBe(200);
      expect((await a("/library")).status).toBe(401);
      await db
        .query("UPDATE user_sessions SET expires=0 WHERE hash=?")
        .run(hash("bob-session"));
      expect((await b("/library")).status).toBe(401);
    } finally {
      db.close();
    }
  });
  test("legacy workspace is quarantined, migrates once to the configured owner, and survives restart", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises"),
      { tmpdir } = await import("node:os"),
      { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "folio-isolation-")),
      path = join(dir, "db.sqlite");
    let first = await createApp({
      database: path,
      webOrigin: "https://folio.example",
    });
    try {
      await addUser(first.db, alice, "a");
      await addUser(first.db, bob, "b");
      await first.db
        .query(
          "INSERT INTO records(kind,id,data) VALUES('group','old-group',?)",
        )
        .run(
          JSON.stringify({ id: "old-group", name: "Legacy", color: "green" }),
        );
      await first.db
        .query("INSERT INTO records(kind,id,data) VALUES('art','old-art',?)")
        .run(
          JSON.stringify({
            id: "old-art",
            groupId: "old-group",
            source: "drive",
            driveId: "old-file",
            url: "/api/drive/image/old-file",
          }),
        );
      await first.db
        .query(
          "INSERT INTO secrets(id,value) VALUES('google','encrypted-old-credential')",
        )
        .run();
      expect(
        (await (await client(first.app, "b")("/library")).json()).groups,
      ).toHaveLength(0);
      await migrateLegacy(first.db, bob, alice.email);
      expect(
        await first.db.query("SELECT * FROM drive_credentials").get(),
      ).toBeUndefined();
      await migrateLegacy(first.db, alice, alice.email);
      expect(
        (await first.db.query("SELECT user_id FROM drive_credentials").get())
          ?.user_id,
      ).toBe(alice.id);
      expect(
        await first.db.query("SELECT * FROM secrets WHERE id='google'").get(),
      ).toBeUndefined();
      expect(
        (await (await client(first.app, "a")("/library")).json()).artworks[0]
          .url,
      ).toBe("/api/artworks/old-art/image");
      await migrateLegacy(first.db, bob, bob.email);
      expect(
        (await (await client(first.app, "b")("/library")).json()).groups,
      ).toHaveLength(0);
      first.db.close();
      first = await createApp({
        database: path,
        webOrigin: "https://folio.example",
      });
      expect(
        (await (await client(first.app, "a")("/library")).json()).groups[0]
          .ownerId,
      ).toBe(alice.id);
      expect(
        (await (await client(first.app, "b")("/library")).json()).artworks,
      ).toHaveLength(0);
    } finally {
      first.db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("mobile grants require authenticated approval and device secrets are single use", async () => {
    const { app, db } = await createApp({
      database: ":memory:",
      webOrigin: "https://folio.example",
    });
    await addUser(db, alice, "a");
    const a = client(app, "a");
    try {
      const start = await app.request(
        "https://folio.example/api/auth/device/start",
        { method: "POST" },
      );
      const grant = await start.json();
      const exchange = () =>
        app.request("https://folio.example/api/auth/device/token", {
          method: "POST",
          body: JSON.stringify({ deviceCode: grant.deviceCode }),
          headers: { "Content-Type": "application/json" },
        });
      expect((await exchange()).status).toBe(409);
      expect(
        (
          await app.request("https://folio.example/api/auth/device/approve", {
            method: "POST",
            body: JSON.stringify({ userCode: grant.userCode }),
          })
        ).status,
      ).toBe(401);
      expect(
        (await a("/auth/device/approve", "POST", { userCode: grant.userCode }))
          .status,
      ).toBe(200);
      const response = await exchange(),
        token = (await response.json()).token;
      expect(token).toBeString();
      expect(token).not.toBe("a");
      expect(
        (await (await client(app, token)("/auth/me")).json()).user.id,
      ).toBe(alice.id);
      expect((await exchange()).status).toBe(400);
      expect(
        (await a("/auth/device/approve", "POST", { userCode: grant.userCode }))
          .status,
      ).toBe(400);
      expect(
        (
          await db
            .query("SELECT hash FROM user_sessions WHERE hash=?")
            .get(hash(token))
        )?.hash,
      ).not.toBe(token);
    } finally {
      db.close();
    }
  });
});
