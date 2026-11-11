import sharp from "sharp";
import { Storage } from "@google-cloud/storage";
import { HTTPException } from "hono/http-exception";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
sharp.cache(false);
sharp.concurrency(2);
export type PreparedImage = {
  bytes: Buffer;
  contentType: string;
  filename: string;
  width: number;
  height: number;
  previews: Record<512 | 1024, Buffer>;
};
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.size || file.size > MAX_UPLOAD_BYTES)
    throw new HTTPException(413, {
      message: "画像は1枚20MB以下にしてください",
    });
  const bytes = Buffer.from(await file.arrayBuffer());
  const pipeline = sharp(bytes, {
    limitInputPixels: 32_000_000,
    failOn: "warning",
  });
  try {
    const info = await pipeline.metadata();
    const formats: Record<string, string> = {
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
    };
    const contentType = formats[info.format ?? ""];
    if (!contentType || !info.width || !info.height) throw Error();
    const small = await pipeline
      .clone()
      .rotate()
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const large = await pipeline
      .clone()
      .rotate()
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    return {
      bytes,
      contentType,
      filename:
        file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 200) || "image",
      width: info.width,
      height: info.height,
      previews: { 512: small, 1024: large },
    };
  } catch {
    throw new HTTPException(415, {
      message: "JPEG・PNG・WebP・GIFの画像を選択してください（最大3200万画素）",
    });
  }
}
export interface ObjectStorage {
  save(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  read(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}
export function cloudStorage(
  bucketName = process.env.UPLOAD_BUCKET,
): ObjectStorage | undefined {
  if (!bucketName) return;
  const bucket = new Storage().bucket(bucketName);
  return {
    async save(key, bytes, contentType) {
      await bucket
        .file(key)
        .save(Buffer.from(bytes), {
          resumable: false,
          validation: "crc32c",
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { contentType, cacheControl: "no-store" },
        });
    },
    async read(key) {
      return (await bucket.file(key).download())[0];
    },
    async remove(key) {
      await bucket.file(key).delete({ ignoreNotFound: true });
    },
  };
}
export async function uploadDriveImage(
  access: string,
  folderId: string,
  image: PreparedImage,
) {
  const boundary = `folio_${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: image.filename, parents: [folderId] })}\r\n`,
    `--${boundary}\r\nContent-Type: ${image.contentType}\r\n\r\n`,
    new Uint8Array(image.bytes),
    `\r\n--${boundary}--\r\n`,
  ]);
  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,thumbnailLink,thumbnailVersion",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!response.ok)
    throw new HTTPException(response.status === 403 ? 403 : 502, {
      message:
        response.status === 403
          ? "Driveへのアップロードが許可されませんでした。追加権限・空き容量を確認してください"
          : "Driveへのアップロードに失敗しました。再試行してください",
    });
  const file = (await response.json()) as {
    id: string;
    name: string;
    mimeType: string;
    thumbnailLink?: string;
    thumbnailVersion?: string;
  };
  if (!/^[a-zA-Z0-9_-]+$/.test(file.id)) throw new HTTPException(502);
  return file;
}
