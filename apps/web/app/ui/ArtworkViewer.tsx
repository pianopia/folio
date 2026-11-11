import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Info,
  LoaderCircle,
  X,
} from "lucide-react";
import type { Artwork } from "@folio/shared";
import ArtImage from "./ArtImage";
export default function ArtworkViewer({
  art,
  index,
  count,
  onNavigate,
  onClose,
  onCopy,
  copying = false,
  feedback,
  children,
}: {
  art: Artwork;
  index: number;
  count: number;
  onNavigate: (direction: number) => void;
  onClose: () => void;
  onCopy: () => void;
  copying?: boolean;
  feedback?: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    close = useRef<HTMLButtonElement>(null);
  const [infoFor, setInfoFor] = useState<string | null>(null);
  const showInfo = infoFor === art.id;
  useEffect(() => {
    const node = dialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node?.showModal();
    close.current?.focus();
    return () => {
      node?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  function navigate(direction: number) {
    if (count < 2) return;
    setInfoFor(null);
    onNavigate(direction);
  }
  return (
    <dialog
      ref={dialog}
      className="artwork-viewer"
      aria-label="Artwork details"
      onCancel={onClose}
      onKeyDown={(event) => {
        if (
          (event.target as HTMLElement).closest(
            'input,select,textarea,[contenteditable="true"]',
          )
        )
          return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          navigate(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className="artwork-viewer-image">
        <ArtImage art={art} alt={art.title} size={1024} eager />
      </div>
      <div className="artwork-viewer-topbar">
        <span className="artwork-viewer-counter" aria-label="表示中の作品">
          {index + 1} / {count}
        </span>
        <div className="artwork-viewer-tools">
          <button
            type="button"
            className={showInfo ? "viewer-icon active" : "viewer-icon"}
            aria-label="作品の詳細情報"
            aria-expanded={showInfo}
            aria-controls="artwork-info-panel"
            title="作品の詳細情報"
            onClick={() => setInfoFor(showInfo ? null : art.id)}
          >
            <Info size={21} />
          </button>
          <button
            type="button"
            className="viewer-icon"
            aria-label="画像をコピー"
            title="画像をコピー"
            disabled={copying}
            onClick={onCopy}
          >
            {copying ? (
              <LoaderCircle className="copy-spinner" size={21} />
            ) : (
              <Copy size={21} />
            )}
          </button>
          <button
            ref={close}
            type="button"
            className="viewer-icon"
            aria-label="閉じる"
            title="閉じる（Esc）"
            onClick={onClose}
          >
            <X size={24} />
          </button>
        </div>
      </div>
      <button
        type="button"
        className="viewer-icon artwork-viewer-prev"
        aria-label="前の作品"
        title="前の作品（←）"
        disabled={count < 2}
        onClick={() => navigate(-1)}
      >
        <ChevronLeft size={32} />
      </button>
      <button
        type="button"
        className="viewer-icon artwork-viewer-next"
        aria-label="次の作品"
        title="次の作品（→）"
        disabled={count < 2}
        onClick={() => navigate(1)}
      >
        <ChevronRight size={32} />
      </button>
      {feedback && (
        <p role="status" className="artwork-viewer-feedback">
          {feedback}
        </p>
      )}
      {showInfo && (
        <section
          id="artwork-info-panel"
          className="artwork-viewer-info"
          aria-label="作品の詳細"
        >
          <div className="artwork-info-heading">
            <h2>作品の詳細</h2>
            <button
              type="button"
              className="viewer-icon"
              aria-label="詳細情報を閉じる"
              onClick={() => setInfoFor(null)}
            >
              <X size={20} />
            </button>
          </div>
          {children}
        </section>
      )}
    </dialog>
  );
}
