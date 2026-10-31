import crypto from "node:crypto";
import sharp from "sharp";
import { config } from "../config.js";
import { mediaReference, r2Storage } from "./r2.js";
import { isCleanJpegHeader } from "./jpeg-metadata.js";

// Camera originals (~15 MB each) can go from the booth straight to R2 instead of through this
// server: the free plan's limited CPU, memory and outbound bandwidth then only see the small
// booth preview. The booth asks for a short-lived upload URL for one photo, uploads the JPEG it
// already cleaned of private metadata, then commits the photo with only its preview.
export const MAX_ORIGINAL_BYTES = 40 * 1024 * 1024;
const UPLOAD_SECONDS = 15 * 60;
const HEAD_BYTES = 128 * 1024;

export const directUploadsEnabled = () => config.mediaStorageProvider === "r2";

// The commit names the upload by a token this server signed for this session and photo key,
// so nobody can attach some other stored file (or another album's) to a photo.
const sign = (bookingId, clientKey, id) => crypto.createHmac("sha256", config.secret)
  .update(`direct-photo\n${bookingId}\n${clientKey}\n${id}`).digest("base64url");

export async function createDirectUpload(bookingId, clientKey, size) {
  const id = crypto.randomUUID();
  const url = await r2Storage.signedPut(mediaReference(`${id}.jpg`), UPLOAD_SECONDS, "image/jpeg", size);
  return { url, stored: `${id}.${sign(bookingId, clientKey, id)}` };
}

export function storedFile(bookingId, clientKey, token) {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/
    .exec(token || "");
  if (!match) return null;
  const expected = Buffer.from(sign(String(bookingId), clientKey, match[1]));
  return crypto.timingSafeEqual(Buffer.from(match[2]), expected) ? mediaReference(`${match[1]}.jpg`) : null;
}

const unusable = (message = "Ảnh gốc tải thẳng lên kho chưa dùng được. Máy chụp sẽ gửi lại qua máy chủ.") =>
  Object.assign(new Error(message), { status: 422 });

// The timelapse video (up to ~48 MB) goes straight to R2 the same way: the free server (512 MB
// RAM) no longer holds a whole video in memory, and the upload skips the web proxy and Render.
// The booth asks for a URL for one video of an exact type and size, uploads it, then commits it;
// the server only checks the stored file's size and attaches it to the album.
export const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const VIDEO_EXTENSIONS = { "video/mp4": "mp4", "video/webm": "webm" };
const signVideo = (bookingId, name) => crypto.createHmac("sha256", config.secret)
  .update(`direct-video\n${bookingId}\n${name}`).digest("base64url");

export async function createVideoUpload(bookingId, type, size) {
  const name = `${crypto.randomUUID()}.${VIDEO_EXTENSIONS[type]}`;
  const url = await r2Storage.signedPut(mediaReference(name), UPLOAD_SECONDS, type, size);
  return { url, stored: `${name}.${signVideo(String(bookingId), name)}` };
}

// The file a commit names, only if this server issued it for this session.
export function storedVideo(bookingId, token) {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm))\.([A-Za-z0-9_-]{43})$/
    .exec(token || "");
  if (!match) return null;
  const expected = Buffer.from(signVideo(String(bookingId), match[1]));
  if (!crypto.timingSafeEqual(Buffer.from(match[3]), expected)) return null;
  return { file: mediaReference(match[1]), mimeType: match[2] === "mp4" ? "video/mp4" : "video/webm" };
}

// Size of the uploaded video (one HEAD request); not there yet or too large: 422.
export async function storedVideoSize(file) {
  const head = await r2Storage.head(file);
  const size = Number(head?.ContentLength);
  if (!(size > 0) || size > MAX_VIDEO_BYTES)
    throw unusable("Video chưa tải lên kho xong. Máy chụp sẽ gửi lại qua máy chủ.");
  return size;
}

// Reads only the start of the stored original: its size, a clean header and its metadata.
export async function inspectStoredOriginal(file) {
  const result = await r2Storage.get(file, `bytes=0-${HEAD_BYTES - 1}`);
  if (!result) throw unusable("Ảnh gốc chưa tải lên kho xong. Máy chụp sẽ gửi lại.");
  const head = Buffer.from(await result.Body.transformToByteArray());
  const total = Number(/\/(\d+)$/.exec(result.ContentRange || "")?.[1] ?? result.ContentLength);
  if (!(total > 0) || total > MAX_ORIGINAL_BYTES || !isCleanJpegHeader(head)) throw unusable();
  let meta;
  try {
    meta = await sharp(head, { limitInputPixels: 100_000_000 }).metadata();
  } catch {
    throw unusable();
  }
  // Only plain sRGB/greyscale JPEGs are kept byte for byte; anything else is converted by the
  // server path, so the booth sends those through it.
  if (meta.format !== "jpeg" || !["srgb", "b-w"].includes(meta.space) || !meta.width || !meta.height)
    throw unusable();
  return { meta, size: total };
}
