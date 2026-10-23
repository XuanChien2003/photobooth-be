import { Router } from "express";
import crypto from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { z } from "zod";
import { config } from "../config.js";
import { Booking, Room, Package, KioskAttempt } from "../models/index.js";
import { appendCapture, finishCapture } from "../services/capture.js";
import { timed } from "../services/image-save-queue.js";
import { directUploadRequest, photoBody, readPhotoUpload, storedOriginal } from "./photo-upload.js";
import { createDirectUpload, directUploadsEnabled } from "../services/direct-upload.js";
import { sensitive } from "../middleware/rate-limits.js";
import { deleteMedia, saveMedia } from "../services/media.js";
import { mediaReference } from "../services/r2.js";
import { fail, today, token } from "./validation.js";
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

// Máy chụp đang mở báo về mỗi phút (kể cả lúc chưa có khách): Quản lý máy hiện Online / Offline
// và máy nhận chế độ lật ảnh quản trị đặt từ xa.
kioskRouter.post("/ping", async (req, res) => {
  const d = z.object({ device: z.string().max(2000) }).parse(req.body);
  let device;
  try {
    device = jwt.verify(d.device, config.secret);
  } catch {
    fail(403, "Máy chụp chưa được gán phòng hoặc liên kết đã hết hạn.");
  }
  if (device.type !== "kiosk" || !mongoose.isObjectIdOrHexString(String(device.room)))
    fail(403, "Thiết bị không hợp lệ.");
  // Ghi thẳng collection: báo "còn mở" không làm mới bộ nhớ đệm danh mục.
  const room = await Room.collection.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(String(device.room)), active: true },
    { $set: { lastSeenAt: new Date() } },
    { returnDocument: "after", projection: { name: 1, branch: 1, flip: 1, payment: 1, paymentTest: 1 } },
  );
  if (!room) fail(403, "Phòng chụp đã ngừng hoạt động.");
  res.json({ room: {
    _id: room._id, name: room.name, branch: room.branch, flip: room.flip || "device",
    payment: room.payment || "counter", paymentTest: Boolean(room.paymentTest),
  } });
});

async function deviceRoom(token) {
  let device;
  try {
    device = jwt.verify(token, config.secret);
  } catch {
    fail(403, "Máy chụp chưa được gán phòng hoặc liên kết đã hết hạn.");
  }
  if (device.type !== "kiosk") fail(403, "Thiết bị không hợp lệ.");
  const room = await Room.findOne({ _id: device.room, active: true });
  if (!room) fail(403, "Phòng chụp đã ngừng hoạt động.");
  return room;
}

// Khách tự mua lượt chụp tại máy: chọn gói, đút tiền vào máy nhận tiền (máy chụp gửi từng tờ đã
// nhận) rồi vào chụp luôn — không cần mã ở quầy. Chế độ thử (paymentTest) cho bỏ qua bước trả tiền
// để thử máy khi chưa lắp máy nhận tiền: vé thử không tính doanh thu.
kioskRouter.post("/sale", sensitive(), async (req, res) => {
  const d = z.object({
    device: z.string().max(2000),
    package: z.string().regex(/^[a-f\d]{24}$/i),
    requestKey: z.uuid(),
    skip: z.boolean().default(false),
    bills: z.array(z.object({
      amount: z.number().int().min(1000).max(10_000_000),
      at: z.string().datetime().optional(),
    })).max(100).default([]),
  }).parse(req.body);
  const room = await deviceRoom(d.device);
  // Gửi lại sau khi mất phản hồi: trả đúng lượt chụp đã tạo, không thu tiền lần nữa.
  const existing = await Booking.findOne({ requestKey: d.requestKey }).select("+accessToken +captureSession");
  if (existing) {
    if (String(existing.room) !== String(room._id)) fail(409, "Mã giao dịch đã dùng ở máy khác.");
    if (!existing.captureSession) fail(409, "Lượt chụp này đã kết thúc.");
    return res.json(saleSession(existing, room, existing.captureSession));
  }
  if (d.skip ? !room.paymentTest : room.payment !== "cash")
    fail(403, d.skip
      ? "Máy chụp chưa bật chế độ thử (bỏ qua trả tiền). Bật ở Quản trị → Quản lý máy."
      : "Máy chụp này chưa bật thanh toán tại máy. Bật ở Quản trị → Quản lý máy.");
  const pack = await Package.findOne({ _id: d.package, active: true });
  if (!pack) fail(400, "Gói chụp không còn hoạt động.");
  if (pack.branches?.length && !pack.branches.includes(room.branch))
    fail(400, `Gói “${pack.name}” không áp dụng tại chi nhánh ${room.branch}.`);
  const received = d.bills.reduce((sum, bill) => sum + bill.amount, 0);
  if (!d.skip && received < pack.price)
    fail(400, `Chưa đủ tiền: đã nhận ${received.toLocaleString("vi-VN")} đ, gói ${pack.price.toLocaleString("vi-VN")} đ.`);
  const sessionId = token();
  const now = new Date();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const b = await Booking.create({
        code: String(crypto.randomInt(100000, 1000000)),
        accessToken: token(),
        name: d.skip ? "Thử máy (bỏ qua trả tiền)" : "Khách tự phục vụ",
        branch: room.branch,
        room: room._id,
        roomName: room.name,
        package: pack._id,
        packageName: pack.name,
        shots: pack.shots,
        countdownSeconds: pack.countdownSeconds || 10,
        selectCount: pack.selectCount || 4,
        printSize: pack.printSize || "full",
        captureDuration: pack.duration,
        prints: pack.prints,
        total: d.skip ? 0 : pack.price,
        discount: 0,
        source: "kiosk",
        date: today(),
        time: "",
        // Vé thử: không tính là đã thu tiền (không vào doanh thu / đối soát).
        paid: !d.skip,
        ...(!d.skip && { paidAt: now }),
        paymentMethod: d.skip ? "test" : "cash",
        cashReceived: received,
        cashBills: d.bills.map((bill) => ({ amount: bill.amount, at: bill.at ? new Date(bill.at) : now })),
        status: "checked_in",
        captureSession: sessionId,
        captureSeenAt: now,
        requestKey: d.requestKey,
      });
      return res.status(201).json(saleSession(b, room, sessionId));
    } catch (error) {
      if (error.code === 11000 && error.keyPattern?.code) continue;
      if (error.code === 11000 && error.keyPattern?.requestKey) {
        const replay = await Booking.findOne({ requestKey: d.requestKey }).select("+accessToken +captureSession");
        if (replay) return res.json(saleSession(replay, room, replay.captureSession));
      }
      throw error;
    }
  }
  fail(503, "Không tạo được lượt chụp. Vui lòng thử lại.");
});
const saleSession = (b, room, sessionId) => ({
  flip: room.flip || "device",
  booking: publicBooking(b),
  accessToken: b.accessToken,
  captureToken: jwt.sign(
    { type: "capture", booking: String(b._id), sessionId },
    config.secret,
    { expiresIn: "2h" },
  ),
});

kioskRouter.post("/claim", sensitive(), async (req, res) => {
  const d = z
    .object({
      code: z.string().regex(/^\d{6}$/, "Mã vé gồm 6 chữ số."),
      device: z.string({ error: "Máy chụp chưa được gán phòng." }),
    })
    .parse(req.body);
  let device;
  try {
    device = jwt.verify(d.device, config.secret);
  } catch {
    fail(403, "Máy chụp chưa được gán phòng hoặc liên kết đã hết hạn.");
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
  // Claim the paid ticket atomically. The ticket alone determines the package and print quota.
  const b = await Booking.findOneAndUpdate(
    validCode,
    [{ $set: {
      status: "checked_in",
      room: room._id,
      roomName: { $literal: room.name },
      captureSession: { $literal: sessionId },
      captureSeenAt: "$$NOW",
    } }],
    { new: true },
  ).select("+accessToken");
  if (!b) {
    const other = await Booking.findOne({ code: d.code, paid: true });
    if (other && ["checked_in", "completed"].includes(other.status))
      fail(409, "Mã chụp đã được sử dụng. Nhờ nhân viên mở lại đường dẫn ảnh nếu cần.");
    const failed = await registerInvalidCode(deviceKey);
    if (failed.lockedUntil > new Date()) {
      res.set("Retry-After", String(Math.ceil((failed.lockedUntil - Date.now()) / 1000)));
      fail(429, "Nhập sai 5 lần. Máy chụp tạm khóa 5 phút.");
    }
    fail(
      400,
      "Mã chụp không đúng, chưa thanh toán hoặc đã hết hạn 2 giờ.",
    );
  }
  await KioskAttempt.deleteOne({ deviceKey });
  res.json({
    flip: room.flip || "device",
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
// Video tua nhanh của lượt chụp (máy chụp ghép từ hình trực tiếp, đã lật gương): gửi một lần
// sau khi chụp xong, gửi lại thì thay video cũ.
const videoBody = express.raw({ type: ["video/webm", "video/mp4"], limit: "60mb" });
kioskRouter.post("/video", videoBody, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, "Video trống.");
  const { b } = await captureBooking(z.string().parse(req.get("X-Capture-Token")));
  const mimeType = req.is("video/mp4") ? "video/mp4" : "video/webm";
  const file = mediaReference(`${crypto.randomUUID()}.${mimeType === "video/mp4" ? "mp4" : "webm"}`);
  await saveMedia(file, req.body, mimeType);
  const old = await Booking.findOneAndUpdate(
    { _id: b._id },
    { $set: { video: { file, mimeType, size: req.body.length } } },
  ).select("video");
  if (old?.video?.file && old.video.file !== file) await deleteMedia([old.video.file]).catch(() => {});
  res.status(201).json({ ok: true, size: req.body.length });
});
kioskRouter.post("/finish", async (req, res) => {
  const { b } = await captureBooking(z.string().parse(req.body.captureToken));
  if (b.status === "completed") return res.json(publicBooking(b));
  res.json(publicBooking(await finishCapture(b._id)));
});
