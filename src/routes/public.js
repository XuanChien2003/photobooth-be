import { Router } from "express";
import mongoose from "mongoose";
import swaggerUi from "swagger-ui-express";
import { config } from "../config.js";
import { openapi } from "../openapi.js";
import { Room, Package, Frame, Setting } from "../models/index.js";
import { captureStatus } from "../services/capture.js";
import { id } from "./validation.js";
import { frameListItem, hashImage } from "../services/frame-image.js";
import { catalogCache } from "../services/read-cache.js";

export const publicRouter = Router();

// Thử API trên trình duyệt: /api/docs (Swagger UI), tài liệu gốc ở /api/openapi.json.
if (config.apiDocs) {
  publicRouter.get("/openapi.json", (req, res) => res.json(openapi));
  publicRouter.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(openapi, {
      customSiteTitle: "NXC Photobooth API",
      swaggerOptions: {
        docExpansion: "none",
        filter: true,
        tryItOutEnabled: true,
        displayRequestDuration: true,
        persistAuthorization: true,
      },
    }),
  );
}
publicRouter.get("/health", async (req, res) => {
  // ?db=1: also time one database round trip (Server-Timing: db) to see how far it is.
  if (req.query.db === "1" && mongoose.connection.readyState === 1) {
    const started = performance.now();
    await mongoose.connection.db.admin().ping().catch(() => {});
    res.set("Server-Timing", `db;dur=${(performance.now() - started).toFixed(0)}`);
  }
  res
    .set("X-Photo-Upload", "binary-v1")
    .set("X-Photo-Quality", "original-jpeg-lossless-print-v1")
    .set("X-Photo-Pipeline", "original-preview-overlap-v1")
    .set("X-Photo-Delivery", "private-r2-direct-v1")
    .set("X-Photo-Queue", "bounded-parallel-v1")
    .set("X-Photo-Preview", "1600-v1")
    // Trình duyệt dò lại máy chủ bằng địa chỉ này khi mất kết nối: không được trả bản lưu sẵn.
    .set("Cache-Control", "no-store")
    .set(mongoose.connection.readyState === 1 ? {} : { "Retry-After": "5" })
    .status(mongoose.connection.readyState === 1 ? 200 : 503)
    .json({ ok: mongoose.connection.readyState === 1 });
});
// Ảnh khung và mã QR lưu trong DB dạng data URL (base64). Nhét thẳng vào /catalog thì mỗi lần mở
// trang phải tải gần 1 MB; tách thành địa chỉ ảnh riêng. Đổi ảnh thì đổi `v` nên trình duyệt giữ
// bản cũ vĩnh viễn, không phải tải lại.
const DATA_IMAGE_HEAD = /^data:(image\/(?:png|jpe?g|gif|webp));base64$/;
function sendDataImage(req, res, dataUrl) {
  const text = typeof dataUrl === "string" ? dataUrl : "";
  const comma = text.indexOf(",");
  const head = comma > 0 && DATA_IMAGE_HEAD.exec(text.slice(0, comma));
  if (!head) return false;
  res
    .set(
      "Cache-Control",
      req.query.v ? "public, max-age=31536000, immutable" : "no-cache",
    )
    .type(head[1] === "image/jpg" ? "image/jpeg" : head[1])
    .send(Buffer.from(text.slice(comma + 1), "base64"));
  return true;
}
// Cả khung đang tắt cũng có ảnh (trang quản trị xem danh sách khung đã tắt).
publicRouter.get("/frames/:id/image", async (req, res) => {
  const frame = await Frame.findById(id.parse(req.params.id))
    .select("image")
    .lean();
  if (!sendDataImage(req, res, frame?.image))
    res.status(404).json({ message: "Không tìm thấy ảnh khung." });
});
publicRouter.get("/studio/qr", async (req, res) => {
  const setting = await Setting.findOne({ key: "studio" }).lean();
  if (!sendDataImage(req, res, setting?.value?.bankQrImage))
    res.status(404).json({ message: "Chưa có ảnh QR chuyển khoản." });
});
publicRouter.get("/catalog", async (req, res) => {
  // Every page load asks for the catalog; it changes only when an admin edits it (cache cleared).
  res.json(await catalogCache.get("catalog", buildCatalog));
});
async function buildCatalog() {
  const [rooms, packages, frames, setting] = await Promise.all([
    Room.find({ active: true }).lean(),
    Package.find({ active: true }).sort({ price: 1 }).lean(),
    Frame.find({ active: true, "slots.0": { $exists: true } })
      .select("-image")
      .lean(),
    Setting.findOne({ key: "studio" }).lean(),
  ]);
  const settings = { ...setting?.value };
  if (settings.bankQrImage?.startsWith("data:"))
    settings.bankQrImage = `/api/studio/qr?v=${hashImage(settings.bankQrImage)}`;
  return {
    rooms,
    packages,
    frames: frames.map(frameListItem),
    settings,
    devices: captureStatus(),
  };
}
