import type { Database } from "./database";

export async function initializeContentSafety(db: Database) {
  await db.client.batch(
    [
      "CREATE TABLE IF NOT EXISTS content_reports (id TEXT PRIMARY KEY, artwork_id TEXT NOT NULL, artwork_owner_id TEXT NOT NULL, reporter_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS user_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(blocker_id,blocked_id))",
      ...[
        ["content_reports", "reporter_id", "artwork_owner_id"],
        ["user_blocks", "blocker_id", "blocked_id"],
      ].flatMap(([table, ...fields]) => [
        ...["INSERT", "UPDATE"].map(
          (operation) =>
            `CREATE TRIGGER IF NOT EXISTS deletion_guard_${table}_${operation} BEFORE ${operation} ON ${table} WHEN ${fields
              .map(
                (field) =>
                  `NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.${field}) OR EXISTS(SELECT 1 FROM account_deletions WHERE user_id=NEW.${field} AND (expires=0 OR expires>CAST(strftime('%s','now') AS INTEGER)*1000))`,
              )
              .join(
                " OR ",
              )} BEGIN SELECT RAISE(ABORT,'account unavailable'); END`,
        ),
        `CREATE TRIGGER IF NOT EXISTS cleanup_${table} AFTER DELETE ON users BEGIN DELETE FROM ${table} WHERE ${fields
          .map((field) => `${field}=OLD.id`)
          .join(" OR ")}; END`,
      ]),
    ],
    "write",
  );
}
