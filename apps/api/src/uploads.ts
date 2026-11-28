import sharp, { type Metadata } from "sharp";
import { Storage } from "@google-cloud/storage";
import { HTTPException } from "hono/http-exception";
import { Readable } from "node:stream";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64_000_000;
export const MAX_NON_JPEG_PIXELS = 16_000_000;
export const DIRECT_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
};
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
sharp.cache(false);
sharp.concurrency(1);
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
  createResumableUpload?(key: string, size: number, contentType: string, origin?: string): Promise<string>;
  stat?(key: string): Promise<{ size: number; contentType?: string }>;
  openRead?(key: string): NodeJS.ReadableStream;
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
    async createResumableUpload(key, size, contentType, origin) {
      const [url] = await bucket.file(key).createResumableUpload({
        origin,
        metadata: { contentType, contentLength: size, cacheControl: "no-store" },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
      return url;
    },
    async stat(key) {
      const [metadata] = await bucket.file(key).getMetadata();
      return { size: Number(metadata.size), contentType: metadata.contentType };
    },
    openRead(key) {
      return bucket.file(key).createReadStream({ validation: false });
    },
    async remove(key) {
      await bucket.file(key).delete({ ignoreNotFound: true });
    },
  };
}

/**
 * Validate/thumbnail a direct-upload original without buffering the original.
 * JPEG is allowed to 64 MP because libvips can shrink JPEGs during decode before
 * creating the tiny previews. PNG/WebP/GIF stay at 16 MP: their full raster can
 * require ~64 MiB at 16 MP (RGBA), while a 64 MP raster alone is ~256 MiB;
 * decoder/encoder overhead at 32-64 MP could exhaust the service's 512 MiB limit.
 * Finalization runs one at a time and the two small previews are generated in parallel.
 */
export async function prepareDirectPreviews(
  stream: () => NodeJS.ReadableStream | Promise<NodeJS.ReadableStream>,
  declaredType: string,
) {
  const expected = DIRECT_IMAGE_TYPES[declaredType];
  if (!expected) throw new HTTPException(415, { message: "JPEG・PNG・WebP・GIFを選択してください" });
  const pixelLimit = expected === "jpeg" ? MAX_IMAGE_PIXELS : MAX_NON_JPEG_PIXELS;
  let source: NodeJS.ReadableStream | undefined;
  let destroyInput: (() => void) | undefined;
  let tasks: Promise<{ result: [Metadata, Buffer, Buffer] } | { error: unknown }> | undefined;
  try {
    const input = sharp({ limitInputPixels: pixelLimit, sequentialRead: true, failOn: "warning" });
    destroyInput = () => input.destroy();
    const metadata = input.metadata();
    const smallPreview = input.clone().rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true, fastShrinkOnLoad: true }).webp({ quality: 82 }).toBuffer();
    const largePreview = input.clone().rotate().resize(1024, 1024, { fit: "inside", withoutEnlargement: true, fastShrinkOnLoad: true }).webp({ quality: 85 }).toBuffer();
    // Attach rejection handling before opening/awaiting the source so failures cannot
    // become unhandled while a slow storage stream is being created.
    tasks = Promise.all([metadata, smallPreview, largePreview]).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    source = await stream();
    source.on("error", (error) => input.destroy(error as Error));
    source.pipe(input);
    const settled = await tasks;
    if ("error" in settled) throw settled.error;
    const [info, small, large] = settled.result;
    if (info.format !== expected || !info.width || !info.height || info.width * info.height > pixelLimit) throw Error("unsupported or too many pixels");
    return { width: info.width, height: info.height, contentType: declaredType, previews: { 512: small, 1024: large } };
  } catch {
    source?.unpipe();
    const destroyable = source as (NodeJS.ReadableStream & { destroy?: () => void }) | undefined;
    destroyable?.destroy?.();
    destroyInput?.();
    await tasks;
    throw new HTTPException(415, { message: `画像を読み込めません。JPEGは最大6400万画素、PNG・WebP・GIFは最大1600万画素です。` });
  }
}

export function readableFromWeb(stream: ReadableStream<Uint8Array>) {
  return Readable.fromWeb(stream as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
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
