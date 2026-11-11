import { useEffect, useRef, useState } from "react";
import UploadPreview from "./UploadPreview";
import type { Artwork, Group } from "@folio/shared";
import { apiBase, getAuthToken, request } from "./api";
type Item = {
  id: string;
  file: File;
  preview: string;
  state: "ready" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
};
type Status = {
  destination: "drive" | "storage";
  canUpload: boolean;
  reauthRequired: boolean;
  maxBytes: number;
};
function upload(
  file: File,
  groupId: string,
  collection: string,
  onProgress: (value: number) => void,
) {
  return new Promise<Artwork>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("groupId", groupId);
    form.append("collection", collection);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase()}/api/artworks/upload`);
    xhr.withCredentials = true;
    xhr.timeout = 100000;
    const token = getAuthToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 95));
    };
    xhr.onerror = () =>
      reject(Error("通信に失敗しました。接続を確認してください"));
    xhr.ontimeout = () =>
      reject(
        Error(
          "応答がタイムアウトしました。一覧を確認してから再試行してください",
        ),
      );
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(Error(body.error ?? "アップロードに失敗しました"));
      } catch {
        reject(Error("サーバーの応答を確認できませんでした"));
      }
    };
    xhr.send(form);
  });
}
export default function UploadPanel({
  groups,
  initialGroup,
  onUploaded,
}: {
  groups: Group[];
  initialGroup?: string;
  onUploaded: (art: Artwork) => void;
}) {
  const [items, setItems] = useState<Item[]>([]),
    [groupId, setGroupId] = useState(
      initialGroup && groups.some((g) => g.id === initialGroup)
        ? initialGroup
        : (groups[0]?.id ?? ""),
    );
  const [collection, setCollection] = useState("Uploads"),
    [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dragging, setDragging] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const mounted = useRef(true);
  const previews = useRef<string[]>([]),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    let current = true;
    request<Status>("/uploads/status")
      .then((s) => {
        if (current) setStatus(s);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
      mounted.current = false;
      previews.current.forEach(URL.revokeObjectURL);
    };
  }, []);
  function select(files: FileList | File[]) {
    if (busy) return;
    const incoming = Array.from(files);
    if (!incoming.length) return;
    setError("");
    const existing = items.filter((item) => item.state !== "done");
    const unique = incoming.filter(
      (file, index) =>
        !existing.some(
          (item) =>
            item.file.name === file.name &&
            item.file.size === file.size &&
            item.file.lastModified === file.lastModified,
        ) &&
        incoming.findIndex(
          (other) =>
            other.name === file.name &&
            other.size === file.size &&
            other.lastModified === file.lastModified,
        ) === index,
    );
    if (existing.length + unique.length > 10) {
      setError(
        "一度に選択できる画像は合計10枚までです。不要な画像を外してから追加してください",
      );
      return;
    }
    if (
      unique.some(
        (file) =>
          file.size > 20 * 1024 * 1024 ||
          !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
            file.type,
          ),
      )
    ) {
      setError("JPEG・PNG・WebP・GIFを1枚20MB以下で選択してください");
      return;
    }
    const added: Item[] = unique.map((file) => ({
      id: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
      state: "ready",
      progress: 0,
    }));
    const selected = [...existing, ...added];
    previews.current
      .filter((url) => !selected.some((item) => item.preview === url))
      .forEach(URL.revokeObjectURL);
    previews.current = selected.map((item) => item.preview);
    setPreviewId(null);
    setItems(selected);
  }
  function remove(id: string) {
    if (busy) return;
    const index = items.findIndex((item) => item.id === id);
    const item = items[index];
    if (!item) return;
    const remaining = items.filter((item) => item.id !== id);
    if (previewId === id)
      setPreviewId(
        remaining[Math.min(index, remaining.length - 1)]?.id ?? null,
      );
    URL.revokeObjectURL(item.preview);
    previews.current = previews.current.filter((url) => url !== item.preview);
    setItems(remaining);
  }
  function change(id: string, patch: Partial<Item>) {
    setItems((old) => old.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }
  async function submit() {
    if (!groupId || !collection.trim()) {
      setError("保存するグループとコレクションを選択してください");
      return;
    }
    setPreviewId(null);
    setBusy(true);
    setError("");
    try {
      for (const item of items.filter((i) => i.state !== "done")) {
        change(item.id, { state: "uploading", progress: 0, error: undefined });
        try {
          const art = await upload(item.file, groupId, collection.trim(), (p) =>
            change(item.id, { progress: p }),
          );
          if (!mounted.current) break;
          change(item.id, { state: "done", progress: 100 });
          onUploaded(art);
        } catch (e) {
          change(item.id, { state: "error", error: (e as Error).message });
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="upload-panel" aria-label="画像をアップロード">
      <p className="upload-destination">
        保存先：
        <strong>
          {!status
            ? "確認中…"
            : status.destination === "drive"
              ? "自分のGoogle Drive / Folio uploads"
              : "Folio Cloud Storage（非公開）"}
        </strong>
      </p>
      {status?.reauthRequired && (
        <div className="upload-permission">
          <p>
            Driveへのアップロードには追加の権限が必要です。許可後に画像を選択してください。
          </p>
          <button
            className="button secondary full"
            onClick={async () => {
              try {
                const r = await request<{ url: string }>("/drive/connect");
                window.location.assign(r.url);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            アップロード権限を追加
          </button>
        </div>
      )}
      {status && !status.canUpload && !status.reauthRequired && (
        <p className="error">アップロードの保存先が準備されていません。</p>
      )}
      <label
        className={`upload-dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          select(e.dataTransfer.files);
        }}
      >
        <span className="upload-plus">＋</span>
        <strong>
          {items.some((item) => item.state !== "done")
            ? "画像を追加で選択・ドロップ"
            : "複数の画像を選択・ドロップ"}
        </strong>
        <span>JPEG / PNG / WebP / GIF · 1枚20MBまで · 最大10枚</span>
        <input
          ref={input}
          type="file"
          aria-label="アップロードする画像"
          accept=".jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif"
          multiple
          disabled={busy || !status?.canUpload}
          onChange={(e) => {
            if (e.target.files) select(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      <div className="form-row">
        <label>
          保存するグループ
          <select
            value={groupId}
            disabled={busy}
            onChange={(e) => setGroupId(e.target.value)}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          コレクション
          <input
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            maxLength={120}
            disabled={busy}
          />
        </label>
      </div>
      <p className="field-note">
        共有メンバーがいるグループを選ぶと、アップロードした作品もそのメンバーに表示されます。
      </p>
      {items.length > 0 && (
        <div className="upload-selection-summary">
          <strong>
            {items.every((item) => item.state === "done")
              ? `${items.length}枚をアップロードしました`
              : `${items.filter((item) => item.state !== "done").length}枚を選択中`}
          </strong>
          <span>サムネイルをクリックすると大きく確認できます</span>
          {items.every((item) => item.state === "done") && (
            <span>すべて保存しました</span>
          )}
        </div>
      )}
      <ul className="upload-items">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="upload-thumbnail-button"
              onClick={() => setPreviewId(item.id)}
              aria-label={`${item.file.name}を大きくプレビュー`}
              disabled={busy}
            >
              <img src={item.preview} alt="" />
              <span>拡大</span>
            </button>
            <div>
              <strong>{item.file.name}</strong>
              <span>
                {item.state === "done"
                  ? "保存しました"
                  : item.state === "uploading"
                    ? `${item.progress}%${item.progress >= 95 ? " · 保存中…" : ""}`
                    : `${(item.file.size / 1024 / 1024).toFixed(1)}MB`}
              </span>
              <progress
                max={100}
                value={item.progress}
                aria-label={`${item.file.name}のアップロード進捗`}
              />
              {item.error && (
                <p role="alert" className="error">
                  {item.error}
                </p>
              )}
            </div>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => remove(item.id)}
              aria-label={`${item.file.name}を選択から外す`}
            >
              外す
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        className="button primary full"
        disabled={
          busy ||
          !status?.canUpload ||
          !items.some((i) => i.state !== "done") ||
          !groupId
        }
        onClick={submit}
      >
        {busy
          ? `${items.filter((item) => item.state === "done").length} / ${items.length}枚を保存中…`
          : items.length && items.every((i) => i.state === "done")
            ? "アップロード完了"
            : `選択した${items.filter((i) => i.state !== "done").length}枚をまとめてアップロード`}
      </button>
      {previewId && (
        <UploadPreview
          items={items.map((item) => ({
            id: item.id,
            preview: item.preview,
            name: item.file.name,
            size: item.file.size,
            uploaded: item.state === "done",
          }))}
          selectedId={previewId}
          onSelect={setPreviewId}
          onClose={() => setPreviewId(null)}
          onRemove={busy ? undefined : remove}
        />
      )}
    </section>
  );
}
