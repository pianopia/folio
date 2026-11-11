import { hash, type User } from "./src/auth";
import type { createApp } from "./src/app";
export const alice: User = {
  id: "google-alice",
  email: "alice@example.com",
  name: "Alice",
};
export const bob: User = {
  id: "google-bob",
  email: "bob@example.com",
  name: "Bob",
};
export async function addUser(
  db: Awaited<ReturnType<typeof createApp>>["db"],
  user: User,
  token: string,
) {
  await db
    .query("INSERT OR IGNORE INTO users(id,email,name) VALUES(?,?,?)")
    .run(user.id, user.email, user.name);
  await db
    .query(
      "INSERT OR REPLACE INTO user_sessions(hash,user_id,expires) VALUES(?,?,?)",
    )
    .run(hash(token), user.id, Date.now() + 86400_000);
}
export function client(
  app: Awaited<ReturnType<typeof createApp>>["app"],
  token: string,
) {
  return (
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.request(`https://folio.example/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
