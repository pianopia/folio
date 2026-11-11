import { describe, test, expect } from "bun:test";
import { createApp } from "./src/app";

describe("workspace API", () => {
  test("requires token, enforces origin, validates inputs and persists artwork edits", async () => {
    const { app, db } = await createApp({
      database: ":memory:",
      token: "test-workspace-token",
    });
    const call = (
      path: string,
      method = "GET",
      body?: unknown,
      extra: Record<string, string> = {}
    ) =>
      app.request(`http://localhost/api${path}`, {
        method,
        headers: {
          Authorization: "Bearer test-workspace-token",
          "Content-Type": "application/json",
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect((await app.request("http://localhost/api/health")).status).toBe(200);
    expect((await app.request("http://localhost/api/library")).status).toBe(
      401
    );
    expect(
      (
        await call(
          "/groups",
          "POST",
          { name: "bad" },
          { Origin: "https://evil.example" }
        )
      ).status
    ).toBe(403);
    expect((await call("/groups", "POST", { name: " " })).status).toBe(400);
    expect((await call("/groups", "POST", null)).status).toBe(400);
    const login = await call("/session", "POST");
    expect(login.status).toBe(200);
    const sessionCookie = login.headers.get("set-cookie")!;
    expect(sessionCookie).toContain("HttpOnly");
    expect(
      (
        await app.request("http://localhost/api/library", {
          headers: { Cookie: sessionCookie.split(";")[0] },
        })
      ).status
    ).toBe(200);
    const groupResponse = await call("/groups", "POST", { name: "New studio" });
    expect(groupResponse.status).toBe(201);
    const group = await groupResponse.json();
    expect(
      (
        await call("/artworks", "POST", {
          title: "Bad",
          url: "javascript:alert(1)",
          groupId: group.id,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await call("/artworks", "POST", {
          title: "Bad",
          url: "https://example.com/a.jpg",
        })
      ).status
    ).toBe(404);
    const created = await call("/artworks", "POST", {
      title: "New artwork",
      url: "https://example.com/a.jpg",
      groupId: group.id,
    });
    expect(created.status).toBe(201);
    const a = await created.json();
    const edited = await call(`/artworks/${a.id}`, "PATCH", {
      title: "Renamed",
      favorite: true,
      collection: "Campaign",
      tags: ["orange"],
    });
    expect(edited.status).toBe(200);
    expect(
      (await call(`/artworks/${a.id}`, "PATCH", { favorite: "yes" })).status
    ).toBe(400);
    expect(
      (await call(`/artworks/${a.id}`, "PATCH", { tags: [""] })).status
    ).toBe(400);
    const library = await (await call("/library")).json();
    expect(library.artworks.find((x: any) => x.id === a.id)).toMatchObject({
      title: "Renamed",
      favorite: true,
      collection: "Campaign",
      tags: ["orange"],
    });
    expect((await call(`/artworks/${a.id}`, "DELETE")).status).toBe(204);
    expect(
      (await call(`/artworks/${a.id}`, "PATCH", { title: "Gone" })).status
    ).toBe(404);
    db.close();
  });
  test("does not pretend Drive is connected; rejects a forged callback", async () => {
    const { app, db } = await createApp({ database: ":memory:" });
    const status = await (
      await app.request("http://localhost/api/drive/status")
    ).json();
    expect(status).toEqual({ configured: false, connected: false });
    expect(
      (await app.request("http://localhost/api/drive/connect")).status
    ).toBe(503);
    expect(
      (
        await app.request(
          "http://localhost/api/drive/callback?code=fake&state=forged"
        )
      ).status
    ).toBe(400);
    expect((await app.request("http://localhost/api/drive/files")).status).toBe(
      409
    );
    db.close();
  });
});
