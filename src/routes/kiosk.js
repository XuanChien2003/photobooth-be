import { Router } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { Booking, Room, Package, KioskAttempt } from "../models/index.js";
import { appendCapture, finishCapture } from "../services/capture.js";
import { timed } from "../services/image-save-queue.js";
import { directUploadRequest, photoBody, readPhotoUpload, storedOriginal } from "./photo-upload.js";
import { createDirectUpload, directUploadsEnabled } from "../services/direct-upload.js";
import { sensitive } from "../middleware/rate-limits.js";
import { fail, token } from "./validation.js";
import { publicBooking } from "./booking-helpers.js";
import {
  captureBooking,
  touchKiosk,
  touchKioskFast,
  kioskDiag,
} from "./kiosk-session.js";

export const kioskRouter = Router();

async function registerInvalidCode(deviceKey) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + 5 * 60 * 1000);
  const wasLocked = { $gt: ["$lockedUntil", now] };
  const lockExpired = { $and: [
    { $ne: [{ $ifNull: ["$lockedUntil", null] }, null] },
    { $lte: ["$lockedUntil", now] },
  ] };
  const update = [{ $set: {
    failures: { $cond: [wasLocked, "$failures", {
      $cond: [lockExpired, 1, { $add: [{ $ifNull: ["$failures", 0] }, 1] }],
    }] },
    lockedUntil: { $cond: [wasLocked, "$lockedUntil", {
      $cond: [lockExpired, null, {
        $cond: [{ $gte: [{ $ifNull: ["$failures", 0] }, 4] }, lockedUntil, null],
      }],
    }] },
  } }];
  try {
    return await KioskAttempt.findOneAndUpdate({ deviceKey }, update, { upsert: true, new: true });
  } catch (error) {
    // Concurrent first failures may race the unique deviceKey insert.
    if (error.code !== 11000) throw error;
    return KioskAttempt.findOneAndUpdate({ deviceKey }, update, { new: true });
  }
}

kioskRouter.post("/claim", sensitive(), async (req, res) => {
  const d = z
    .object({
      code: z.string().regex(/^\d{6}$/, "Mã vé gồm 6 chữ số."),
      device: z.string({ error: "Kiosk chưa được gán phòng." }),
      // Khổ ảnh và số tờ khách chọn ở các bước trước khi nhập mã (máy chụp cũ không gửi).
      printSize: z.enum(["full", "strip"]).optional(),
      prints: z.number().int().min(1).max(20).optional(),
    })
    .parse(req.body);
  let device;
  try {
    device = jwt.verify(d.device, config.secret);
  } catch {
    fail(403, "Kiosk chưa được gán phòng hoặc liên kết đã hết hạn.");
  }
  if (device.type !== "kiosk") fail(403, "Thiết bị không hợp lệ.");
  const room = await Room.findOne({ _id: device.room, active: true });
  if (!room) fail(403, "Phòng chụp đã ngừng hoạt động.");
  const deviceKey = crypto.createHash("sha256").update(d.device).digest("hex");
  const attempts = await KioskAttempt.findOne({ deviceKey });
  if (attempts?.lockedUntil > new Date()) {
    const seconds = Math.ceil((attempts.lockedUntil.getTime() - Date.now()) / 1000);
    res.set("Retry-After", String(seconds));
    fail(429, `Nhập sai 5 lần. Vui lòng chờ ${Math.ceil(seconds / 60)} phút rồi thử lại.`);
  }
  const validCode = {
    code: d.code,
    paid: true,
    status: "confirmed",
    branch: room.branch,
    $or: [
      { codeExpiresAt: { $gt: new Date() } },
      { codeExpiresAt: { $exists: false }, createdAt: { $gt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
    ],
  };
  const sessionId = token();
  // Một lệnh duy nhất: nhận mã đúng khổ đã mua và ghi số tờ khách chọn thêm (vé cũ không có khổ = khổ to).
  const b = await Booking.findOneAndUpdate(
    {
      ...validCode,
      ...(d.printSize && {
        printSize: d.printSize === "full" ? { $in: ["full", null] } : d.printSize,
      }),
    },
    [{ $set: {
      status: "checked_in",
      room: room._id,
      roomName: { $literal: room.name },
      captureSession: { $literal: sessionId },
      captureSeenAt: "$$NOW",
      ...(d.prints && {
        requestedExtraPrints: {
          $max: [0, { $subtract: [d.prints, { $ifNull: ["$prints", 0] }] }],
        },
      }),
    } }],
    { new: true },
  ).select("+accessToken");
  if (!b && d.printSize) {
    // Mã đúng nhưng khác khổ đã mua: không tính là nhập sai và chưa dùng mã.
    const paid = await Booking.findOne(validCode).select("printSize packageName").lean();
    if (paid) {
      res.status(409).json({
        message: `Mã này thuộc gói ${paid.packageName || ""} (${
          paid.printSize === "strip" ? "khung bé" : "khung to"}). Vui lòng chọn lại khổ ảnh.`,
        printSize: paid.printSize || "full",
      });
      return;
    }
  }
  if (!b) {
    const other = await Booking.findOne({ code: d.code, paid: true });
    if (other && ["checked_in", "completed"].includes(other.status))
      fail(409, "Mã chụp đã được sử dụng. Nhờ nhân viên mở lại đường dẫn ảnh nếu cần.");
    const failed = await registerInvalidCode(deviceKey);
    if (failed.lockedUntil > new Date()) {
      res.set("Retry-After", String(Math.ceil((failed.lockedUntil - Date.now()) / 1000)));
      fail(429, "Nhập sai 5 lần. Kiosk tạm khóa 5 phút.");
    }
    fail(
      400,
      "Mã chụp không đúng, chưa thanh toán hoặc đã hết hạn 2 giờ.",
    );
  }
  await KioskAttempt.deleteOne({ deviceKey });
  res.json({
    booking: publicBooking(b),
    accessToken: b.accessToken,
    captureToken: jwt.sign(
      { type: "capture", booking: String(b._id), sessionId },
      config.secret,
      { expiresIn: "2h" },
    ),
  });
});

// Khách chỉ chụp bằng nút chụp / remote của máy ảnh: ảnh gốc về thư mục X Acquire trên máy
// chụp, máy chụp đọc thư mục rồi gửi lên (không có nút chụp trên màn hình).
kioskRouter.post("/start", async (req, res) => {
  const d = z.object({ captureToken: z.string() }).parse(req.body);
  const { b, payload } = await captureBooking(d.captureToken);
  if (!b.captureStartedAt && b.status === "checked_in") {
    // Older tickets have no snapshot; only those fall back to the current package.
    if (!b.captureDuration) {
      const pack = await Package.findById(b.package);
      b.captureDuration = pack?.duration || 10;
    }
    b.captureStartedAt = new Date();
    b.captureEndsAt = new Date(Date.now() + b.captureDuration * 60000);
    b.captureMode = "folder";
    b.captureSession = payload.sessionId;
    b.captureSeenAt = new Date();
    await b.save();
  } else await touchKiosk(b);
  res.json({ booking: publicBooking(b) });
});
kioskRouter.post("/state", async (req, res) => {
  const captureToken = z.string().parse(req.body.captureToken);
  const diag = kioskDiag.parse(req.body.diag);
  const live = await touchKioskFast(captureToken, diag);
  if (live) return res.json({ booking: publicBooking(live) });
  const { b } = await captureBooking(captureToken);
  await touchKiosk(b, diag);
  res.json({ booking: publicBooking(b) });
});
// The camera original goes straight to storage (direct-upload.js): a URL for one photo.
kioskRouter.post("/photo/upload-url", async (req, res) => {
  const d = directUploadRequest(true).parse(req.body);
  if (!directUploadsEnabled()) fail(404, "Kho ảnh chưa hỗ trợ tải thẳng.");
  const { b } = await captureBooking(d.captureToken, { authOnly: true, photoKey: d.clientKey });
  // Already saved (a lost reply): hand back the session instead of a second upload.
  if (b.photos?.length) return res.json({ saved: true, booking: publicBooking(await Booking.findById(b._id)) });
  if (b.status !== "checked_in" || !b.captureEndsAt || new Date(b.captureEndsAt) <= new Date())
    fail(409, "Phiên chụp đã kết thúc.");
  res.json({ upload: await createDirectUpload(b._id, d.clientKey, d.size) });
});
kioskRouter.post("/photo", photoBody, async (req, res) => {
  const d = readPhotoUpload(req, { capture: true });
  // appendCapture re-reads the booking under its write lock. Authorization
  // needs only the session/status, so avoid fetching all photos twice.
  const { b } = await captureBooking(d.captureToken, { authOnly: true, photoKey: d.clientKey });
  res.json(
    publicBooking(
      await timed(res, "save", appendCapture(b._id, d.buffer, {
        clientKey: d.clientKey,
        mirrored: d.mirrored,
        precheck: b,
        preview: d.preview,
        storedOriginal: storedOriginal(b._id, d),
      })),
    ),
  );
});
kioskRouter.post("/finish", async (req, res) => {
  const { b } = await captureBooking(z.string().parse(req.body.captureToken));
  if (b.status === "completed") return res.json(publicBooking(b));
  res.json(publicBooking(await finishCapture(b._id)));
});
