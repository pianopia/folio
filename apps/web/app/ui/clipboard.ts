import type { Artwork } from "@folio/shared";
import { apiBase, getAuthToken } from "./api";

async function pngForArtwork(art: Artwork): Promise<Blob> {
  const isDrive = art.source === "drive";
  const token = isDrive ? getAuthToken() : "";
  const response = await fetch(isDrive ? `${apiBase()}${art.url}` : art.url, {
    credentials: isDrive ? "include" : "omit",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      "画像を取得できませんでした。Driveの接続や画像の公開設定を確認してください。"
    );
  const blob = await response.blob();
  // Clipboard implementations interoperate on PNG, including JPEG/WebP sources.
  const objectURL = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectURL;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height)
      throw new Error("画像を変換できませんでした。");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (png) =>
          png
            ? resolve(png)
            : reject(new Error("画像をPNGに変換できませんでした。")),
        "image/png"
      )
    );
  } finally {
    URL.revokeObjectURL(objectURL);
  }
}

export function copyArtworkImage(art: Artwork): Promise<void> {
  if (
    !window.isSecureContext ||
    !navigator.clipboard?.write ||
    typeof ClipboardItem === "undefined"
  ) {
    return Promise.reject(
      new Error(
        "このブラウザは画像コピーに対応していません。HTTPSでSafari・Chrome・Edgeなどから開いてください。"
      )
    );
  }
  // Start write during the click itself: Safari needs the user activation before
  // fetching/decoding finishes. The ClipboardItem awaits the PNG promise.
  return navigator.clipboard.write([
    new ClipboardItem({ "image/png": pngForArtwork(art) }),
  ]);
}
