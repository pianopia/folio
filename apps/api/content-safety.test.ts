import { describe, expect, test } from "bun:test";
import { createApp } from "./src/app";
import { addUser, alice, bob, client } from "./test-support";

const carol = { id: "google-carol", email: "carol@example.com", name: "Carol" };
async function fixture() {
  const reads: string[] = [],
    removed: string[] = [];
  const { app, db } = await createApp({
    database: ":memory:",
    webOrigin: "https://folio.example",
    objectStorage: {
      async save() {},
      async read(key) {
        reads.push(key);
        return new Uint8Array([1, 2, 3]);
      },
      async remove(key) {
        removed.push(key);
      },
    },
  });
  await addUser(db, alice, "a");
  await addUser(db, bob, "b");
  await addUser(db, carol, "c");
  const a = client(app, "a"),
    b = client(app, "b"),
    c = client(app, "c");
  const group = await (await a("/groups", "POST", { name: "Shared" })).json();
  const privateGroup = await (
    await a("/groups", "POST", { name: "Private" })
  ).json();
  const bobGroup = await (
    await b("/groups", "POST", { name: "Bob private" })
  ).json();
  const add = async (groupId: string) =>
    (
      await a("/artworks", "POST", {
        title: "Reference",
        groupId,
        url: "https://example.com/image.png",
      })
    ).json();
  const art = await add(group.id),
    privateArt = await add(privateGroup.id);
  await a(`/groups/${group.id}/members`, "POST", { email: bob.email });
  return {
    app,
    db,
    a,
    b,
    c,
    group,
    privateGroup,
    bobGroup,
    art,
    privateArt,
    reads,
    removed,
  };
}

describe("shared content safety", () => {
  test("all safety endpoints require auth; reporting requires read access and another owner", async () => {
    const { app, db, a, b, c, group, art, privateArt } = await fixture();
    try {
      for (const [path, method] of [
        [`/artworks/${art.id}/reports`, "POST"],
        [`/users/${alice.id}/block`, "POST"],
        [`/users/${alice.id}/block`, "DELETE"],
        ["/blocks", "GET"],
        [`/groups/${group.id}/membership`, "DELETE"],
      ])
        expect(
          (await app.request(`https://folio.example/api${path}`, { method }))
            .status,
        ).toBe(401);
      const report = (id: string, reason: unknown = "不適切な画像") =>
        b(`/artworks/${id}/reports`, "POST", { reason });
      expect((await report(privateArt.id)).status).toBe(404);
      expect((await report("art-0")).status).toBe(404); // local demo sample
      expect(
        (await c(`/artworks/${art.id}/reports`, "POST", { reason: "x" }))
          .status,
      ).toBe(404);
      expect(
        (await a(`/artworks/${art.id}/reports`, "POST", { reason: "x" }))
          .status,
      ).toBe(400);
      for (const reason of [" ", "x".repeat(1001), 42, null])
        expect((await report(art.id, reason)).status).toBe(400);
      expect((await b(`/artworks/${art.id}/reports`, "POST", {})).status).toBe(
        400,
      );
      expect((await report(art.id, "  確認してください  ")).status).toBe(201);
      expect((await report(art.id, "再度の通報")).status).toBe(201);
      const rows = await db
        .query("SELECT * FROM content_reports ORDER BY rowid")
        .all();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        artwork_id: art.id,
        artwork_owner_id: alice.id,
        reporter_id: bob.id,
        reason: "確認してください",
      });
      expect(rows[0].created_at).toBeString();
      expect(rows[0].id).not.toBe(rows[1].id);
      expect((await (await a("/library")).json()).artworks).toHaveLength(2);
      expect((await b("/content_reports")).status).toBe(404);
      await a(`/groups/${group.id}/members/${bob.id}`, "DELETE");
      expect((await report(art.id)).status).toBe(404);
      expect(
        await db.query("SELECT * FROM content_reports").all(),
      ).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("blocks hide group-only items and artwork/image access, remain private, and unblock restores access", async () => {
    const { db, a, b, c, art, group, privateGroup, bobGroup } = await fixture();
    try {
      const recordsBefore = await db
        .query("SELECT * FROM library_records ORDER BY rowid")
        .all();
      const usersBefore = await db
        .query("SELECT * FROM users ORDER BY id")
        .all();
      expect((await b(`/users/${bob.id}/block`, "POST")).status).toBe(400);
      // Unknown users and known but unrelated users are indistinguishable.
      expect((await b("/users/nonexistent/block", "POST")).status).toBe(404);
      expect((await b(`/users/${carol.id}/block`, "POST")).status).toBe(404);
      expect((await b(`/users/${alice.id}/block`, "POST")).status).toBe(201);
      expect((await b(`/users/${alice.id}/block`, "POST")).status).toBe(200);
      const library = await (await b("/library")).json();
      expect(library.artworks).toEqual([]);
      expect(library.groups.map((g: any) => g.id)).toEqual([bobGroup.id]);
      expect(
        library.groups.some(
          (g: any) => g.id === group.id || g.id === privateGroup.id,
        ),
      ).toBe(false);
      for (const suffix of ["/image", "/thumbnail"])
        expect((await b(`/artworks/${art.id}${suffix}`)).status).toBe(404);
      expect(
        (await b(`/artworks/${art.id}`, "PATCH", { favorite: true })).status,
      ).toBe(404);
      expect((await b(`/artworks/${art.id}`, "DELETE")).status).toBe(404);
      expect(
        (await b(`/artworks/${art.id}/reports`, "POST", { reason: "x" }))
          .status,
      ).toBe(404);
      expect((await (await b("/blocks")).json()).users).toEqual([alice]);
      expect((await (await a("/blocks")).json()).users).toEqual([]);
      expect((await (await c("/blocks")).json()).users).toEqual([]);
      expect(
        await db.query("SELECT * FROM library_records ORDER BY rowid").all(),
      ).toEqual(recordsBefore);
      expect(await db.query("SELECT * FROM users ORDER BY id").all()).toEqual(
        usersBefore,
      );
      expect(
        await db
          .query("SELECT * FROM group_members WHERE group_id=?")
          .all(group.id),
      ).toHaveLength(1);
      expect((await c(`/users/${alice.id}/block`, "DELETE")).status).toBe(204);
      expect(await db.query("SELECT * FROM user_blocks").all()).toHaveLength(1);
      expect((await b(`/users/${alice.id}/block`, "DELETE")).status).toBe(204);
      expect((await b(`/users/${alice.id}/block`, "DELETE")).status).toBe(204);
      expect(
        (await (await b("/library")).json()).artworks.map((x: any) => x.id),
      ).toEqual([art.id]);
      expect((await (await a("/library")).json()).artworks).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("blocked artwork owners are hidden even inside another owner's group", async () => {
    const { db, a, b, c, group, art, reads, removed } = await fixture();
    try {
      const otherGroup = await (
        await c("/groups", "POST", { name: "Carol's group" })
      ).json();
      await c(`/groups/${otherGroup.id}/members`, "POST", { email: bob.email });
      // Cover mixed ownership (including pre-existing records) independently of group ownership.
      const mixed = {
        ...art,
        id: "mixed",
        groupId: otherGroup.id,
        source: "storage",
        storageKey: "users/alice/mixed",
        contentType: "image/png",
      };
      await db
        .query(
          "INSERT INTO library_records(kind,id,owner_id,group_id,data) VALUES('art',?,?,?,?)",
        )
        .run(mixed.id, alice.id, otherGroup.id, JSON.stringify(mixed));
      expect((await b("/artworks/mixed/image")).status).toBe(200);
      expect((await b("/artworks/mixed/thumbnail")).status).toBe(200);
      expect(reads).toHaveLength(2);
      expect((await b(`/users/${alice.id}/block`, "POST")).status).toBe(201);
      const library = await (await b("/library")).json();
      expect(library.groups.some((g: any) => g.id === otherGroup.id)).toBe(
        true,
      );
      expect(library.artworks).toEqual([]);
      expect((await b("/artworks/mixed/image")).status).toBe(404);
      expect((await b("/artworks/mixed/thumbnail")).status).toBe(404);
      expect(reads).toHaveLength(2); // blocked requests never reach object storage
      expect(removed).toEqual([]);
      expect((await a(`/groups/${group.id}/members`)).status).toBe(200);
      expect(
        (await (await c("/library")).json()).artworks.some(
          (x: any) => x.id === "mixed",
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  test("only members can leave; blocked groups can still be left without changing the owner's data", async () => {
    const { db, a, b, c, group, privateGroup, art } = await fixture();
    try {
      expect((await a(`/groups/${group.id}/membership`, "DELETE")).status).toBe(
        403,
      );
      expect((await c(`/groups/${group.id}/membership`, "DELETE")).status).toBe(
        404,
      );
      expect(
        (await b(`/groups/${privateGroup.id}/membership`, "DELETE")).status,
      ).toBe(404);
      expect((await b(`/groups/${group.id}/membership`, "DELETE")).status).toBe(
        204,
      );
      expect((await b(`/groups/${group.id}/membership`, "DELETE")).status).toBe(
        404,
      );
      expect((await (await b("/library")).json()).artworks).toEqual([]);
      expect(
        (await b(`/artworks/${art.id}/reports`, "POST", { reason: "x" }))
          .status,
      ).toBe(404);
      await a(`/groups/${group.id}/members`, "POST", { email: bob.email });
      await b(`/users/${alice.id}/block`, "POST");
      expect((await b(`/groups/${group.id}/membership`, "DELETE")).status).toBe(
        204,
      );
      expect((await (await a("/library")).json()).artworks).toHaveLength(2);
      expect(
        (await (await a(`/groups/${group.id}/members`)).json()).members,
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("deletion-pending accounts cannot use safety endpoints or recreate safety data in flight", async () => {
    const { db, b, group, art } = await fixture();
    try {
      await db
        .query("INSERT INTO account_deletions(user_id,expires) VALUES(?,0)")
        .run(bob.id);
      for (const [path, method, body] of [
        [`/artworks/${art.id}/reports`, "POST", { reason: "x" }],
        [`/users/${alice.id}/block`, "POST", undefined],
        [`/users/${alice.id}/block`, "DELETE", undefined],
        ["/blocks", "GET", undefined],
        [`/groups/${group.id}/membership`, "DELETE", undefined],
      ] as const)
        expect((await b(path, method, body)).status).toBe(403);
      await expect(
        db
          .query(
            "INSERT INTO user_blocks(blocker_id,blocked_id,created_at) VALUES(?,?,'now')",
          )
          .run(bob.id, alice.id),
      ).rejects.toThrow("account unavailable");
      await expect(
        db
          .query(
            "INSERT INTO content_reports(id,artwork_id,artwork_owner_id,reporter_id,reason,created_at) VALUES('pending',?,?,?,'x','now')",
          )
          .run(art.id, alice.id, bob.id),
      ).rejects.toThrow("account unavailable");
      // The target account is guarded too, including writes already in flight.
      await expect(
        db
          .query(
            "INSERT INTO user_blocks(blocker_id,blocked_id,created_at) VALUES(?,?,'now')",
          )
          .run(alice.id, bob.id),
      ).rejects.toThrow("account unavailable");
    } finally {
      db.close();
    }
  });

  test("account deletion cleans up only related safety records and preserves other accounts and reports", async () => {
    const { db, a, b, c, group, art } = await fixture();
    try {
      await a(`/groups/${group.id}/members`, "POST", { email: carol.email });
      await b(`/artworks/${art.id}/reports`, "POST", {
        reason: "Bob's report",
      });
      await c(`/artworks/${art.id}/reports`, "POST", {
        reason: "Carol's report",
      });
      await b(`/users/${alice.id}/block`, "POST");
      await c(`/users/${alice.id}/block`, "POST");
      expect(
        (await b("/account", "DELETE", { confirmation: "DELETE" })).status,
      ).toBe(204);
      expect(
        (await db.query("SELECT reporter_id FROM content_reports").all()).map(
          (r) => r.reporter_id,
        ),
      ).toEqual([carol.id]);
      expect(
        (await db.query("SELECT blocker_id FROM user_blocks").all()).map(
          (r) => r.blocker_id,
        ),
      ).toEqual([carol.id]);
      expect((await (await a("/library")).json()).artworks).toHaveLength(2);
      expect(
        (await db.query("SELECT id FROM users ORDER BY id").all()).map(
          (r) => r.id,
        ),
      ).toEqual([alice.id, carol.id]);
      expect(
        (await a("/account", "DELETE", { confirmation: "DELETE" })).status,
      ).toBe(204);
      expect(await db.query("SELECT * FROM content_reports").all()).toEqual([]);
      expect(await db.query("SELECT * FROM user_blocks").all()).toEqual([]);
      expect((await c("/library")).status).toBe(200);
    } finally {
      db.close();
    }
  });
});
