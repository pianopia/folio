import { test, expect } from "bun:test";
import { createApp } from "./src/app";
import { alice, bob, addUser, client } from "./test-support";
const origin = "https://folio.example";
test("native Drive tickets are single-use, cookie-bound, explicitly approved, fixed to the requesting Folio user and cannot cross Google identities", async () => {
  const names = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "API_ORIGIN",
  ];
  const old = Object.fromEntries(names.map((n) => [n, process.env[n]])),
    original = globalThis.fetch;
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "fixture-client",
    GOOGLE_CLIENT_SECRET: "fixture-secret",
    TOKEN_ENCRYPTION_KEY: "45".repeat(32),
    API_ORIGIN: origin,
  });
  let identity = alice;
  globalThis.fetch = (async () =>
    Response.json({
      id_token: "fixture",
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      scope:
        "openid email profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
    })) as unknown as typeof fetch;
  const { app, db } = await createApp({
    database: ":memory:",
    webOrigin: origin,
    verifyIdentity: async () => identity,
  });
  const a = client(app, "a"),
    b = client(app, "b");
  function cookie(r: Response, name: string) {
    return r.headers
      .getSetCookie()
      .find((c) => c.startsWith(name + "="))!
      .split(";")[0];
  }
  async function start(c: ReturnType<typeof client>) {
    const r = await c("/drive/native/start", "POST");
    expect(r.status).toBe(200);
    const { url } = await r.json();
    const page = await app.request(url);
    expect(page.status).toBe(200);
    const text = await page.text();
    const approval = text.match(/name="approval"\s+value="([^"]+)"/)![1];
    return {
      url,
      page,
      text,
      approval,
      cookie: cookie(page, "folio_native_drive"),
    };
  }
  async function approve(
    s: Awaited<ReturnType<typeof start>>,
    cookies = s.cookie,
  ) {
    return app.request(origin + "/api/drive/native/authorize", {
      method: "POST",
      headers: {
        Cookie: cookies,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ approval: s.approval }),
    });
  }
  try {
    await addUser(db, alice, "a");
    await addUser(db, bob, "b");
    const apple = {
      id: "apple:fixture-user",
      email: "relay@privaterelay.appleid.com",
      name: "Private Apple",
    };
    await addUser(db, apple, "apple");
    expect((await client(app, "")("/drive/native/start", "POST")).status).toBe(
      401,
    );
    const first = await start(a);
    expect(first.text).toContain(alice.email);
    expect(first.text).not.toContain(bob.email);
    expect((await app.request(first.url)).status).toBe(400);
    expect((await approve(first, "")).status).toBe(403);
    const consent = await approve(first);
    expect(consent.status).toBe(302);
    expect((await approve(first)).status).toBe(400);
    const google = new URL(consent.headers.get("location")!);
    expect(google.hostname).toBe("accounts.google.com");
    expect(google.searchParams.get("scope")).toContain("drive.file");
    const state = google.searchParams.get("state");
    const callback = origin + `/api/drive/callback?state=${state}&code=fixture`;
    expect((await app.request(callback)).status).toBe(400);
    identity = bob;
    expect(
      (
        await app.request(callback, {
          headers: { Cookie: cookie(consent, "folio_oauth") },
        })
      ).status,
    ).toBe(403);
    expect(
      await db
        .query("SELECT value FROM drive_credentials WHERE user_id=?")
        .get(alice.id),
    ).toBeUndefined();
    const appleTicket = await start(client(app, "apple"));
    expect(appleTicket.text).toContain(apple.email);
    const appleConsent = await approve(appleTicket);
    const appleAuth = new URL(appleConsent.headers.get("location")!);
    expect(appleAuth.searchParams.has("login_hint")).toBe(false);
    const result = await app.request(
      origin +
        `/api/drive/callback?state=${appleAuth.searchParams.get("state")}&code=fixture`,
      { headers: { Cookie: cookie(appleConsent, "folio_oauth") } },
    );
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe("folio://drive");
    expect(
      await db
        .query("SELECT value FROM drive_credentials WHERE user_id=?")
        .get(apple.id),
    ).toBeTruthy();
    expect(
      await db
        .query("SELECT value FROM drive_credentials WHERE user_id=?")
        .get(bob.id),
    ).toBeUndefined();
    const late = await start(a);
    await db
      .query("INSERT INTO account_deletions(user_id,expires) VALUES(?,0)")
      .run(alice.id);
    expect((await approve(late)).status).toBe(400);
    identity = alice;
    const retryDevice = await (
      await client(app, "")("/auth/device/start", "POST")
    ).json();
    const retryLogin = await app.request(
      origin + `/api/auth/login?device=${retryDevice.userCode}&native=1`,
    );
    const retryGoogle = new URL(retryLogin.headers.get("location")!);
    const retryCallback = await app.request(
      origin +
        `/api/drive/callback?state=${retryGoogle.searchParams.get("state")}&code=fixture`,
      { headers: { Cookie: cookie(retryLogin, "folio_oauth") } },
    );
    expect(retryCallback.status).toBe(302);
    const retryCookie = cookie(retryCallback, "folio_session");
    const retryApproval = await app.request(
      origin + "/api/auth/device/approve",
      {
        method: "POST",
        headers: { Cookie: retryCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: retryDevice.userCode }),
      },
    );
    expect(retryApproval.status).toBe(200);
    const retryToken = await (
      await client(app, "")("/auth/device/token", "POST", {
        deviceCode: retryDevice.deviceCode,
      })
    ).json();
    const retryClient = client(app, retryToken.token);
    expect((await (await retryClient("/auth/me")).json()).deletionPending).toBe(
      true,
    );
    expect((await retryClient("/library")).status).toBe(403);
    identity = bob;
    const device = await (await b("/auth/device/start", "POST")).json();
    const login = await app.request(
      origin + `/api/auth/login?device=${device.userCode}&native=1`,
    );
    const loginUrl = new URL(login.headers.get("location")!);
    const signed = await app.request(
      origin +
        `/api/drive/callback?state=${loginUrl.searchParams.get("state")}&code=fixture`,
      { headers: { Cookie: cookie(login, "folio_oauth") } },
    );
    expect(signed.status).toBe(302);
    expect(signed.headers.get("location")).toBe(
      `${origin}/?device=${device.userCode}&native=1`,
    );
  } finally {
    db.close();
    globalThis.fetch = original;
    for (const n of names) {
      if (old[n] === undefined) delete process.env[n];
      else process.env[n] = old[n];
    }
  }
});
