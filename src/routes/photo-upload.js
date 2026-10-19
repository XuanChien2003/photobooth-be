import express from "express";
import { z } from "zod";
import { fail } from "./validation.js";
import { MAX_BOOTH_PREVIEW_BYTES } from "../services/capture.js";
import { MAX_ORIGINAL_BYTES, storedFile } from "../services/direct-upload.js";

// File uploads avoid the base64 copy. Older kiosks/offline queues still send JSON.
export const photoBody = express.raw({
  type: ["image/jpeg", "image/png", "image/webp"],
  limit: "40mb",
});

const fields = {
  clientKey: z.string().min(8).max(160),
  name: z.string().max(250).optional(),
  mirrored: z.boolean().optional(),
};

// Asking for a direct upload URL: the photo's key and the cleaned original's exact size.
export const directUploadRequest = (capture = false) => z.object({
  clientKey: fields.clientKey,
  size: z.number().int().positive().max(MAX_ORIGINAL_BYTES),
  ...(capture && { captureToken: z.string() }),
});

// The stored original named by a commit, checked against the session and photo key it was
// issued for. A bad token is answered 422 so the booth sends the photo the usual way.
export function storedOriginal(bookingId, d) {
  if (d.stored === undefined) return undefined;
  return storedFile(bookingId, d.clientKey, d.stored) ||
    fail(422, "Ảnh gốc tải thẳng lên kho không khớp phiên chụp. Máy chụp sẽ gửi lại qua máy chủ.");
}

export function readPhotoUpload(req, { capture = false } = {}) {
  const schema = z.object({
    ...fields,
    ...(capture && { captureToken: z.string() }),
  });
  if (Buffer.isBuffer(req.body)) {
    let name;
    try {
      name = req.get("X-Photo-Name") === undefined
        ? undefined
        : decodeURIComponent(req.get("X-Photo-Name"));
    } catch {
      fail(400, "Tên ảnh không hợp lệ.");
    }
    const data = schema.parse({
      clientKey: req.get("X-Photo-Key"),
      name,
      mirrored: req.get("X-Photo-Mirrored") === undefined ? undefined
        : z.enum(["0", "1"]).parse(req.get("X-Photo-Mirrored")) === "1",
      ...(capture && { captureToken: req.get("X-Capture-Token") }),
    });
    if (!req.body.length) fail(400, "Ảnh không có dữ liệu.");
    // The booth already uploaded the camera original straight to storage (direct-upload.js):
    // the body is only its preview, and the token names the stored original.
    const stored = req.get("X-Photo-Stored");
    if (stored !== undefined) {
      if (stored.length > 200 || req.body.length > MAX_BOOTH_PREVIEW_BYTES)
        fail(400, "Ảnh xem trước gửi kèm không hợp lệ.");
      return { ...data, buffer: null, preview: req.body, stored };
    }
    // A booth appends its own upright 1600 px preview after the camera bytes (see
    // usableBoothPreview); the header says how many trailing bytes belong to it.
    const previewLength = req.get("X-Photo-Preview-Length");
    if (previewLength === undefined) return { ...data, buffer: req.body };
    const n = Number(previewLength);
    if (!/^\d+$/.test(previewLength) || n <= 0 || n >= req.body.length || n > MAX_BOOTH_PREVIEW_BYTES)
      fail(400, "Ảnh xem trước gửi kèm không hợp lệ.");
    return {
      ...data,
      buffer: req.body.subarray(0, req.body.length - n),
      preview: req.body.subarray(req.body.length - n),
    };
  }
  const data = schema.extend({
    image: z.string().max(60_000_000)
      .regex(/^data:image\/(jpeg|png|webp);base64,/),
  }).parse(req.body);
  return { ...data, buffer: Buffer.from(data.image.split(",")[1], "base64") };
}
