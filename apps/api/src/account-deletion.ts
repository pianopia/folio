import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { deleteCookie } from "hono/cookie";
import { hash, type AuthEnv } from "./auth";
import type { Database } from "./database";
import type { ObjectStorage } from "./uploads";
import type { Artwork } from "@folio/shared";

export async function initializeDeletion(db: Database) {
  await db.client.batch(
    [
      "CREATE TABLE IF NOT EXISTS account_deletions (user_id TEXT PRIMARY KEY, expires INTEGER NOT NULL DEFAULT 0)",
      "DELETE FROM account_deletions WHERE expires>0 AND expires<CAST(strftime('%s','now') AS INTEGER)*1000",
      ...[
        "library_records",
        "drive_credentials",
        "user_sessions",
        "drive_upload_folders",
        "native_drive_tickets",
      ].flatMap((table) => {
        const field = table === "library_records" ? "owner_id" : "user_id";
        return ["INSERT", "UPDATE"].map(
          (operation) =>
            `CREATE TRIGGER IF NOT EXISTS deletion_guard_${table}_${operation} BEFORE ${operation} ON ${table} WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.${field}) ${table === "user_sessions" ? "" : `OR EXISTS(SELECT 1 FROM account_deletions WHERE user_id=NEW.${field} AND (expires=0 OR expires>CAST(strftime('%s','now') AS INTEGER)*1000))`} BEGIN SELECT RAISE(ABORT,'account unavailable'); END`,
        );
      }),
      ...["INSERT", "UPDATE"].map(
        (operation) =>
          `CREATE TRIGGER IF NOT EXISTS deletion_guard_users_${operation} BEFORE ${operation} ON users WHEN EXISTS(SELECT 1 FROM account_deletions WHERE user_id=NEW.id AND (expires=0 OR expires>CAST(strftime('%s','now') AS INTEGER)*1000)) BEGIN SELECT RAISE(ABORT,'account unavailable'); END`,
      ),
      "CREATE TRIGGER IF NOT EXISTS deletion_guard_members BEFORE INSERT ON group_members WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) OR NOT EXISTS(SELECT 1 FROM library_records WHERE kind='group' AND id=NEW.group_id) OR EXISTS(SELECT 1 FROM library_records r JOIN account_deletions d ON d.user_id=r.owner_id WHERE r.kind='group' AND r.id=NEW.group_id AND (d.expires=0 OR d.expires>CAST(strftime('%s','now') AS INTEGER)*1000)) BEGIN SELECT RAISE(ABORT,'account unavailable'); END",
    ],
    "write",
  );
}

export function setupAccountDeletion(
  app: Hono<AuthEnv>,
  db: Database,
  options: {
    objects?: ObjectStorage;
    revokeDrive: (id: string) => Promise<void>;
    revokeApple: (id: string) => Promise<void>;
    clear: (id: string) => void;
  },
) {
  app.delete("/api/account", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body?.confirmation !== "DELETE")
      throw new HTTPException(400, {
        message: "アカウント削除の確認が必要です",
      });
    const id = c.get("user").id;
    // A persistent guard blocks writes from requests already running on any revision.
    // Sessions stay usable for deletion retries until cleanup succeeds.
    await db
      .query(
        "INSERT OR IGNORE INTO account_deletions(user_id,expires) VALUES(?,0)",
      )
      .run(id);
    options.clear(id);
    const rows = await db
      .query("SELECT data FROM library_records WHERE owner_id=? AND kind='art'")
      .all(id);
    const keys = rows
      .map((row) => JSON.parse(String(row.data)) as Artwork)
      .filter(
        (art) =>
          art.source === "storage" &&
          art.storageKey?.startsWith(`users/${hash(id)}/`),
      )
      .flatMap((art) =>
        ["original", "512.webp", "1024.webp"].map(
          (suffix) => `${art.storageKey}/${suffix}`,
        ),
      );
    try {
      if (keys.length && !options.objects) throw Error("storage unavailable");
      for (let i = 0; i < keys.length; i += 6)
        await Promise.all(
          keys.slice(i, i + 6).map((key) => options.objects!.remove(key)),
        );
      await options.revokeApple(id);
      await options.revokeDrive(id);
    } catch {
      throw new HTTPException(502, {
        message:
          "削除を完了できませんでした。設定からアカウント削除を再試行してください",
      });
    }
    await db.transaction(async (tx) => {
      await tx
        .query(
          "DELETE FROM group_members WHERE user_id=? OR group_id IN (SELECT id FROM library_records WHERE kind='group' AND owner_id=?)",
        )
        .run(id, id);
      await tx.query("DELETE FROM library_records WHERE owner_id=?").run(id);
      for (const table of [
        "user_sessions",
        "drive_credentials",
        "drive_upload_folders",
        "native_drive_tickets",
        "oauth_states",
        "device_logins",
        "apple_accounts",
      ])
        await tx.query(`DELETE FROM ${table} WHERE user_id=?`).run(id);
      if (
        await tx
          .query(
            "SELECT id FROM secrets WHERE id='user-isolation-migration' AND value=?",
          )
          .get(id)
      ) {
        await tx.query("DELETE FROM records").run();
        await tx
          .query(
            "UPDATE secrets SET value='deleted' WHERE id='user-isolation-migration'",
          )
          .run();
      }
      await tx.query("DELETE FROM users WHERE id=?").run(id);
      // Outlive Cloud Run's request deadline; old in-flight operations cannot
      // repopulate records even if the same provider signs in again immediately.
      await tx
        .query("UPDATE account_deletions SET expires=? WHERE user_id=?")
        .run(Date.now() + 300_000, id);
    });
    deleteCookie(c, "folio_session", { path: "/api" });
    return c.body(null, 204);
  });
}
