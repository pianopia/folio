/** Dependency-injected, persistent single-file upload queue. No React Native imports. */
export type BurstStatus = "待機" | "送信中" | "完了" | "失敗";
export type BurstItem = {
  id: string; userId: string; groupId: string; uri: string; filename: string; size: number;
  createdAt: number; status: BurstStatus; attempts: number;
  nextAttemptAt: number; lastError: string | null; width?: number; height?: number;
};
export type BurstResult = { ok: true } | { ok: false; status?: number; message: string; retryable?: boolean };
export type BurstDeps = {
  storage: { get(): Promise<string | null>; set(value: string): Promise<void> };
  files: { exists(uri: string): Promise<boolean>; remove(uri: string): Promise<void> };
  upload(item: BurstItem): Promise<BurstResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
  online(): boolean;
  userId(): string;
  random?(): number;
};
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
const RETAIN_DONE_MS = 24 * 60 * 60_000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 32_000_000;

export class BurstQueue {
  private items: BurstItem[] = [];
  private running = false;
  private restored = false;
  private restorePromise: Promise<BurstItem[]> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private subscribers = new Set<(items: BurstItem[]) => void>();
  constructor(private deps: BurstDeps) {}
  getItems() { return this.items.map((item) => ({ ...item })); }
  subscribe(listener: (items: BurstItem[]) => void) {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }
  private async persist() {
    const snapshot = JSON.stringify(this.items);
    this.writeChain = this.writeChain.catch(() => {}).then(() => this.deps.storage.set(snapshot));
    await this.writeChain;
    const items = this.getItems();
    for (const subscriber of this.subscribers) subscriber(items);
  }
  async restore() {
    if (this.restored) return this.getItems();
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = this.performRestore();
    try { return await this.restorePromise; }
    finally { this.restorePromise = null; }
  }
  private async performRestore() {
    const raw = await this.deps.storage.get();
    try { this.items = raw ? JSON.parse(raw) as BurstItem[] : []; } catch { this.items = []; }
    const now = this.deps.now();
    this.items = this.items.filter((x) => x.status !== "完了" || now - x.createdAt < RETAIN_DONE_MS);
    for (const item of this.items) {
      if (!item.userId && item.status !== "完了") {
        item.userId = "";
        item.status = "失敗";
        item.lastError = "保存時のアカウントを確認できません。安全のため再試行できません。不要なら破棄してください。";
        continue;
      }
      if (item.status === "送信中") item.status = "待機";
      if (item.status !== "完了" && !(await this.deps.files.exists(item.uri))) {
        item.status = "失敗"; item.lastError = "保存した写真が見つかりません。撮り直してください。";
      }
    }
    this.restored = true;
    await this.persist();
    return this.getItems();
  }
  async enqueue(item: Omit<BurstItem, "status" | "attempts" | "nextAttemptAt" | "lastError">) {
    if (!this.restored) await this.restore();
    const record: BurstItem = { ...item, status: "待機", attempts: 0, nextAttemptAt: this.deps.now(), lastError: null };
    if (record.size > MAX_BYTES) { record.status = "失敗"; record.lastError = "画像は1枚20MB以下にしてください。撮り直してください。"; }
    else if (record.width && record.height && record.width * record.height > MAX_PIXELS) {
      record.status = "失敗"; record.lastError = "写真が3200万画素を超えています。撮影サイズを変更してください。";
    }
    this.items.push(record); await this.persist();
    if (record.status === "待機") void this.process();
    return { ...record };
  }
  async retry(id: string) {
    const item = this.items.find((x) => x.id === id);
    if (!item || item.status !== "失敗" || !item.userId || item.userId !== this.deps.userId()) return;
    if (!(await this.deps.files.exists(item.uri))) { item.lastError = "保存した写真が見つかりません。撮り直してください。"; await this.persist(); return; }
    item.status = "待機"; item.attempts = 0; item.nextAttemptAt = this.deps.now(); item.lastError = null;
    await this.persist(); void this.process();
  }
  async discard(id: string) {
    const item = this.items.find((x) => x.id === id);
    if (!item || item.status === "送信中") return;
    await this.deps.files.remove(item.uri).catch(() => {});
    this.items = this.items.filter((x) => x.id !== id); await this.persist();
  }
  resume() { if (this.restored && this.deps.online()) void this.process(); }
  private async process() {
    if (this.running || !this.deps.online() || !this.restored) return;
    this.running = true;
    try {
      while (this.deps.online()) {
        const currentUserId = this.deps.userId();
        if (!currentUserId) break;
        const item = this.items.find((x) => x.status === "待機" && x.userId === currentUserId);
        if (!item) break;
        const wait = item.nextAttemptAt - this.deps.now();
        if (wait > 0) { await this.deps.sleep(wait); if (!this.deps.online()) break; }
        item.status = "送信中"; await this.persist();
        let result: BurstResult;
        try { result = await this.deps.upload({ ...item }); }
        catch (e) { result = { ok: false, message: (e as Error).message || "通信に失敗しました", retryable: true }; }
        if (result.ok) {
          item.status = "完了"; item.lastError = null;
          await this.deps.files.remove(item.uri).catch(() => {});
          await this.persist(); continue;
        }
        item.attempts++;
        const retryable = result.retryable || result.status === 429 || (result.status != null && result.status >= 500);
        item.lastError = result.message;
        if (!retryable) { item.status = "失敗"; await this.persist(); continue; }
        item.status = "待機";
        const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(item.attempts - 1, 8));
        const random = this.deps.random?.() ?? Math.random();
        item.nextAttemptAt = this.deps.now() + Math.round(backoff * (1 + random * 0.2));
        await this.persist();
      }
    } finally { this.running = false; }
  }
}
