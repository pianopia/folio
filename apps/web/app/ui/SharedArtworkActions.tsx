import { useState } from "react";
import type { Artwork } from "@folio/shared";
import { request } from "./api";

export default function SharedArtworkActions({
  art,
  onBlocked,
  notify,
}: {
  art: Artwork;
  onBlocked: (ownerId: string) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function submit(block: boolean) {
    let reason = "";
    if (block) {
      if (
        !window.confirm(
          "このユーザーをブロックしますか？このユーザーの共有作品が非表示になります。設定から解除できます。",
        )
      )
        return;
    } else {
      const input = window.prompt("通報理由を入力してください（1000文字以内）");
      if (input === null) return;
      reason = input.trim();
      if (!reason || reason.length > 1000) {
        notify("通報理由は1〜1000文字で入力してください");
        return;
      }
      if (!window.confirm("入力した理由でこの作品を通報しますか？")) return;
    }
    setBusy(true);
    try {
      await request(
        block
          ? `/users/${encodeURIComponent(art.ownerId!)}/block`
          : `/artworks/${encodeURIComponent(art.id)}/reports`,
        {
          method: "POST",
          ...(block ? {} : { body: JSON.stringify({ reason }) }),
        },
      );
      if (block) await onBlocked(art.ownerId!);
      notify(
        block ? "ブロックしました" : "通報を受け付けました。内容を確認します。",
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="viewer-icon"
        style={{ width: "auto", padding: "0 12px", fontSize: 13 }}
        disabled={busy}
        onClick={() => void submit(false)}
      >
        通報
      </button>
      <button
        type="button"
        className="viewer-icon"
        style={{ width: "auto", padding: "0 12px", fontSize: 13 }}
        disabled={busy}
        onClick={() => void submit(true)}
      >
        ブロック
      </button>
    </>
  );
}
