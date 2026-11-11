import { useEffect, useRef } from "react";
export type PreviewItem = {
  id: string;
  preview: string;
  name: string;
  size: number;
  uploaded?: boolean;
};
export default function UploadPreview({
  items,
  selectedId,
  onSelect,
  onClose,
  onRemove,
}: {
  items: PreviewItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onRemove?: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const index = items.findIndex((item) => item.id === selectedId);
  const item = items[index];
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
    };
  }, []);
  function navigate(direction: number) {
    if (items.length > 1)
      onSelect(items[(index + direction + items.length) % items.length].id);
  }
  return (
    <dialog
      ref={dialog}
      className="upload-preview-dialog"
      aria-labelledby="upload-preview-title"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
        if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          navigate(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className="upload-preview-heading">
        <div>
          <span>
            {index + 1} / {items.length}
          </span>
          <h3 id="upload-preview-title">{item?.name}</h3>
        </div>
        <button
          type="button"
          className="button secondary"
          autoFocus
          onClick={onClose}
          aria-label="プレビューを閉じる"
        >
          ×
        </button>
      </div>
      {item && (
        <img
          className="upload-preview-image"
          src={item.preview}
          alt={item.name}
        />
      )}
      <div className="upload-preview-footer">
        <button
          type="button"
          className="button secondary"
          disabled={items.length < 2}
          onClick={() => navigate(-1)}
          aria-label="前の選択画像"
        >
          ←
        </button>
        <span>
          {item ? `${(item.size / 1024 / 1024).toFixed(1)}MB` : ""} ·{" "}
          {item?.uploaded ? "アップロード済み" : "未アップロード"}
        </span>
        <button
          type="button"
          className="button secondary"
          disabled={items.length < 2}
          onClick={() => navigate(1)}
          aria-label="次の選択画像"
        >
          →
        </button>
      </div>
      {item && onRemove && (
        <button
          type="button"
          className="text-button danger"
          onClick={() => onRemove(item.id)}
        >
          この画像を選択から外す
        </button>
      )}
    </dialog>
  );
}
