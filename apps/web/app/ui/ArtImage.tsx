import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image as ImageIcon } from "lucide-react";
import { apiBase, getAuthToken } from "./api";
import type { Artwork } from "@folio/shared";
import {
  loadDrivePreview,
  previewPath,
  subscribeDriveCache,
  driveCacheVersion,
} from "./drive-client";

// Observe the visible area plus the next rows. Offscreen cards never fetch full
// originals; in-flight and recently loaded previews are shared across views.
export function DriveThumbnail({
  path,
  alt,
  eager = false,
}: {
  path: string;
  alt: string;
  eager?: boolean;
}) {
  const cacheVersion = useSyncExternalStore(
    subscribeDriveCache,
    driveCacheVersion,
    () => 0
  );
  const connection = apiBase() + "|" + getAuthToken();
  const container = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false,
      objectURL = "";
    setSrc("");
    setFailed(false);
    async function load() {
      try {
        const blob = await loadDrivePreview(path);
        if (disposed) return;
        objectURL = URL.createObjectURL(blob);
        setSrc(objectURL);
      } catch {
        if (!disposed) setFailed(true);
      }
    }
    let observer: IntersectionObserver | undefined;
    if (eager || !("IntersectionObserver" in window)) void load();
    else if (container.current) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            void load();
          }
        },
        { rootMargin: "500px" }
      );
      observer.observe(container.current);
    }
    return () => {
      disposed = true;
      observer?.disconnect();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [path, eager, cacheVersion, connection]);
  return (
    <span className="preview-frame" ref={container}>
      {src ? (
        <img src={src} alt={alt} decoding="async" />
      ) : (
        <span
          className={
            failed ? "image-placeholder" : "image-placeholder preview-loading"
          }
        >
          <ImageIcon size={20} />
          <span>{failed ? "プレビュー準備中" : "プレビュー読み込み中"}</span>
        </span>
      )}
    </span>
  );
}
export default function ArtImage({
  art,
  alt,
  size = 512,
  eager = false,
}: {
  art: Artwork;
  alt: string;
  size?: 512 | 1024;
  eager?: boolean;
}) {
  return art.source === "drive" ? (
    <DriveThumbnail path={previewPath(art, size)} alt={alt} eager={eager} />
  ) : (
    <img
      src={art.url}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
    />
  );
}
