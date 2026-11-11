import { test, expect } from "bun:test";
import { createApp } from "./src/app";

test("OAuth validates state, stores encrypted tokens, serves authenticated previews, and revokes access", async () => {
  const keys = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "API_ORIGIN",
  ] as const;
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]])
  );
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture-secret",
    TOKEN_ENCRYPTION_KEY: "c".repeat(64),
    API_ORIGIN: "https://folio.example",
  });
  let imageRequests = 0,
    revoked = false;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      const body = init?.body as URLSearchParams;
      expect(body.get("redirect_uri")).toBe(
        "https://folio.example/api/drive/callback"
      );
      expect(body.get("grant_type")).toBe("authorization_code");
      return Response.json({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
      });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?"))
      return Response.json({
        files: [
          {
            id: "fixture-image",
            name: "Artwork.png",
            mimeType: "image/png",
            thumbnailLink:
              "https://lh3.googleusercontent.com/drive-storage/fixture=s220",
            thumbnailVersion: "1",
          },
        ],
      });
    if (url.startsWith("https://lh3.googleusercontent.com/")) {
      imageRequests++;
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer fixture-access"
      );
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png" },
      });
    }
    if (url === "https://oauth2.googleapis.com/revoke") {
      revoked = true;
      return new Response(null, { status: 200 });
    }
    throw Error("Unexpected OAuth provider call");
  }) as typeof fetch;
  let db: Awaited<ReturnType<typeof createApp>>["db"] | undefined;
  try {
    const created = await createApp({
      database: ":memory:",
      token: "workspace-fixture",
      webOrigin: "https://folio.example",
    });
    db = created.db;
    const call = (path: string, method = "GET", cookie = "") =>
      created.app.request(`https://folio.example/api${path}`, {
        method,
        headers: { Authorization: "Bearer workspace-fixture", Cookie: cookie },
      });
    expect(await (await call("/drive/status")).json()).toEqual({
      configured: true,
      connected: false,
    });
    const connect = await call("/drive/connect");
    const auth = new URL((await connect.json()).url);
    const state = auth.searchParams.get("state")!;
    expect(auth.hostname).toBe("accounts.google.com");
    expect(auth.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/drive.readonly"
    );
    expect(connect.headers.get("set-cookie")).toContain("HttpOnly");
    expect(
      (
        await call(
          "/drive/callback?state=wrong&code=fixture",
          "GET",
          `drive_state=${state}`
        )
      ).status
    ).toBe(400);
    const callback = await call(
      `/drive/callback?state=${state}&code=fixture`,
      "GET",
      `drive_state=${state}`
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      "https://folio.example/?drive=connected"
    );
    const encrypted = String(
      (await db.query("SELECT value FROM secrets WHERE id='google'").get())
        ?.value
    );
    expect(encrypted).not.toContain("fixture-access");
    expect(encrypted).not.toContain("fixture-refresh");
    expect(await (await call("/drive/status")).json()).toEqual({
      configured: true,
      connected: true,
    });
    const files = await (await call("/drive/files")).json();
    expect(files.files[0].thumbnailUrl).toContain(
      "/api/drive/thumbnail/fixture-image"
    );
    expect(files.files[0].thumbnailLink).toBeUndefined();
    expect((await call("/drive/thumbnail/fixture-image")).status).toBe(200);
    expect((await call("/drive/thumbnail/fixture-image")).status).toBe(200);
    expect(imageRequests).toBe(1);
    expect((await call("/drive", "DELETE")).status).toBe(200);
    expect(revoked).toBe(true);
    expect(
      await db.query("SELECT value FROM secrets WHERE id='google'").get()
    ).toBeUndefined();
    expect((await call("/drive/files")).status).toBe(409);
  } finally {
    db?.close();
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
