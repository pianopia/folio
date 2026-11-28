import { describe, expect, test } from "bun:test";
import { BurstQueue, uploadBurstItem, type BurstItem, type BurstResult } from "./burstQueue";

function harness(upload: (item: BurstItem) => Promise<BurstResult>, initiallyOnline = true, seed: string | null = null) {
  let raw: string | null = seed, now = 10_000, online = initiallyOnline, userId = "user-1";
  const existing = new Set<string>(), uploads: string[] = [], removed: string[] = [], sleeps: number[] = [];
  const queue = new BurstQueue({
    storage: { get: async () => raw, set: async (v) => { raw = v; } },
    files: { exists: async (uri) => existing.has(uri), remove: async (uri) => { existing.delete(uri); removed.push(uri); } },
    upload: async (item) => { uploads.push(item.id); return upload(item); },
    now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, online: () => online, userId: () => userId, random: () => 0.5,
  });
  const add = async (id: string, extra: Partial<BurstItem> = {}) => {
    const uri = `file://${id}`; existing.add(uri);
    return queue.enqueue({ id, userId, uri, filename: `${id}.jpg`, groupId: "g", size: 100, createdAt: now, ...extra });
  };
  return { queue, add, uploads, existing, removed, sleeps, addExisting: (uri: string) => existing.add(uri), setOnline: (v: boolean) => { online = v; }, setUserId: (v: string) => { userId = v; }, raw: () => raw, advance: (ms: number) => { now += ms; } };
}
const ok: BurstResult = { ok: true };
const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

describe("BurstQueue", () => {
  test("restores metadata and uploads FIFO sequentially, deleting successful files", async () => {
    let active = 0, maxActive = 0;
    const h = harness(async () => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return ok; });
    await h.add("1"); await h.add("2"); await tick();
    expect(h.uploads).toEqual(["1", "2"]); expect(maxActive).toBe(1); expect(h.removed).toEqual(["file://1", "file://2"]);
    const h2 = harness(async () => ok, true, h.raw());
    const restored = await h2.queue.restore(); expect(restored.map((x) => x.id)).toEqual(["1", "2"]);
    expect(restored.every((x) => x.status === "完了")).toBe(true);
  });
  test("retries 429, 5xx and network errors with bounded exponential backoff", async () => {
    const h = harness(async (item) => item.attempts === 0 ? { ok: false, status: 429, message: "busy" } : item.attempts === 1 ? { ok: false, status: 503, message: "server" } : item.attempts === 2 ? { ok: false, message: "network", retryable: true } : ok);
    await h.add("retry"); await tick();
    expect(h.uploads.length).toBe(4); expect(h.sleeps).toEqual([2200, 4400, 8800]); expect(h.queue.getItems()[0]?.status).toBe("完了");
  });
  test("permanent 4xx fails, while retry and discard work", async () => {
    const h = harness(async () => ({ ok: false, status: 403, message: "権限がありません" }));
    await h.add("bad"); await tick(); expect(h.queue.getItems()[0]?.status).toBe("失敗");
    await h.queue.retry("bad"); await tick(); expect(h.uploads.length).toBe(2);
    await h.queue.discard("bad"); expect(h.queue.getItems()).toHaveLength(0); expect(h.existing.size).toBe(0);
  });
  test("marks missing persisted files failed after restart", async () => {
    const h = harness(async () => ok); await h.add("gone");
    const restarted = harness(async () => ok, true, h.raw());
    const restored = await restarted.queue.restore();
    expect(restored[0]?.status).toBe("失敗"); expect(restored[0]?.lastError).toContain("見つかりません");
  });
  test("offline queue pauses and resumes when connectivity returns", async () => {
    const h = harness(async () => ok, false); await h.add("offline"); await tick(); expect(h.uploads).toEqual([]);
    h.setOnline(true); h.queue.resume(); await tick(); expect(h.uploads).toEqual(["offline"]);
  });
  test("only uploads items for the active account", async () => {
    const h = harness(async () => ok, false);
    await h.add("account-a");
    h.setUserId("user-2"); h.setOnline(true); h.queue.resume(); await tick();
    expect(h.uploads).toEqual([]);
    h.setUserId("user-1"); h.queue.resume(); await tick();
    expect(h.uploads).toEqual(["account-a"]);
  });
  test("concurrent restore calls are idempotent and subscribers unsubscribe cleanly", async () => {
    const source = harness(async () => ok, false); await source.add("once");
    const h = harness(async () => ok, true, source.raw());
    h.addExisting("file://once");
    let notifications = 0;
    const unsubscribe = h.queue.subscribe(() => { notifications++; });
    await Promise.all([h.queue.restore(), h.queue.restore()]);
    h.queue.resume(); h.queue.resume(); await tick();
    expect(h.uploads).toEqual(["once"]);
    const beforeUnsubscribe = notifications;
    unsubscribe(); await h.queue.discard("once");
    expect(notifications).toBe(beforeUnsubscribe);
  });
  test("oversize and over-pixel files are recorded as failures without upload", async () => {
    const h = harness(async () => ok);
    await h.add("large", { size: 101 * 1024 * 1024 }); await h.add("pixels", { width: 9000, height: 8000 });
    await tick(); expect(h.uploads).toEqual([]); expect(h.queue.getItems().map((x) => x.status)).toEqual(["失敗", "失敗"]);
  });
  test("direct upload persists session phases and retries a lost complete response without another PUT", async () => {
    const item = { id: "big", size: 21 * 1024 * 1024, uploadPhase: undefined } as BurstItem;
    const patches: Partial<BurstItem>[] = []; let puts = 0, completes = 0;
    const transport = {
      legacy: async () => ok,
      init: async () => ({ uploadId: "u1", uploadUrl: "https://session" }),
      put: async () => { puts++; return ok; },
      complete: async () => { completes++; return completes === 1 ? { ok: false as const, status: 503, message: "temporary" } : ok; },
    };
    const first = await uploadBurstItem(item, async (p) => { patches.push(p); }, transport);
    expect(first).toMatchObject({ ok: false, status: 503 });
    const persisted = { ...item, ...Object.assign({}, ...patches) };
    expect(persisted.uploadPhase).toBe("complete");
    const second = await uploadBurstItem(persisted, async (p) => { Object.assign(persisted, p); }, transport);
    expect(second).toEqual(ok); expect(puts).toBe(1); expect(completes).toBe(2);
  });
  test("expired direct session starts a new session and re-uploads", async () => {
    const item = { id: "big", size: 21 * 1024 * 1024, uploadId: "old", uploadUrl: "old-url", uploadPhase: "put" } as BurstItem;
    let inits = 0, puts = 0;
    const result = await uploadBurstItem(item, async (patch) => { Object.assign(item, patch); }, {
      legacy: async () => ok,
      init: async () => ({ uploadId: `new-${++inits}`, uploadUrl: "new-url" }),
      put: async (current) => { puts++; return current.uploadUrl === "old-url" ? { ok: false, status: 410, message: "expired" } : ok; },
      complete: async (current) => current.uploadUrl === "old-url" ? { ok: false, status: 410, message: "expired" } : ok,
    });
    expect(result).toEqual(ok); expect(inits).toBe(1); expect(puts).toBe(1); expect(item.uploadId).toBe("new-1");
  });
  test("restored PUT phase checks completion before sending bytes again", async () => {
    const item = { id: "big", size: 21 * 1024 * 1024, uploadId: "u1", uploadUrl: "url", uploadPhase: "put" } as BurstItem;
    let puts = 0, completes = 0;
    const result = await uploadBurstItem(item, async () => {}, {
      legacy: async () => ok, init: async () => ({ uploadId: "new", uploadUrl: "new" }),
      put: async () => { puts++; return ok; }, complete: async () => { completes++; return ok; },
    });
    expect(result).toEqual(ok); expect(completes).toBe(1); expect(puts).toBe(0);
  });
  test("images up to 20MB stay on legacy multipart upload", async () => {
    let legacy = 0, direct = 0;
    const result = await uploadBurstItem({ id: "small", size: 20 * 1024 * 1024 } as BurstItem, async () => {}, {
      legacy: async () => { legacy++; return ok; },
      init: async () => { direct++; return { uploadId: "x", uploadUrl: "x" }; },
      put: async () => ok, complete: async () => ok,
    });
    expect(result).toEqual(ok); expect(legacy).toBe(1); expect(direct).toBe(0);
  });
});
