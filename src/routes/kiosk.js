import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { Booking, Room, Package } from "../models/index.js";
import { appendCapture, finishCapture } from "../services/capture.js";
import { timed } from "../services/image-save-queue.js";
import { directUploadRequest, photoBody, readPhotoUpload, storedOriginal } from "./photo-upload.js";
import { createDirectUpload, directUploadsEnabled } from "../services/direct-upload.js";
import { sensitive } from "../middleware/rate-limits.js";
import { fail, today, token } from "./validation.js";
import { publicBooking } from "./booking-helpers.js";
import {
  captureBooking,
  KIOSK_LIVE_MS,
  touchKiosk,
  touchKioskFast,
  kioskDiag,
} from "./kiosk-session.js";

export const kioskRouter = Router();

kioskRouter.post("/claim", sensitive(), async (req, res) => {
  const d = z
    .object({
      code: z.string().regex(/^\d{6}$/, "Mã vé gồm 6 chữ số."),
      device: z.string({ error: "Kiosk chưa được gán phòng." }),
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
  // Mã đã thanh toán được dùng ở bất kỳ phòng nào, bất kỳ giờ nào trong ngày
  // (ngày của vé hoặc ngày lễ tân cấp mã, theo giờ Việt Nam).
  const sameDay = {
    code: d.code,
    paid: true,
    $or: [
      { date: today() },
      { createdAt: { $gte: new Date(`${today()}T00:00:00+07:00`) } },
    ],
  };
  const sessionId = token();
  const b = await Booking.findOneAndUpdate(
    {
      ...sameDay,
      status: { $in: ["confirmed", "checked_in"] },
      // Máy chụp khác vẫn đang dùng mã này thì không cho nhận; máy đó mất tín hiệu
      // (sập nguồn, tải lại trang…) thì máy mới nhận lại và chụp tiếp thời gian còn lại.
      $nor: [
        {
          status: "checked_in",
          room: { $ne: room._id },
          captureSeenAt: { $gte: new Date(Date.now() - KIOSK_LIVE_MS) },
        },
      ],
    },
    {
      status: "checked_in",
      room: room._id,
      roomName: room.name,
      captureSession: sessionId,
      captureSeenAt: new Date(),
    },
    { new: true },
  ).select("+accessToken");
  if (!b) {
    const other = await Booking.findOne(sameDay).select("+accessToken");
    if (other?.status === "checked_in")
      fail(
        409,
        `Mã vé đang được dùng ở ${other.roomName}. Nếu máy đó gặp sự cố, chờ 20 giây rồi nhập lại mã.`,
      );
    // Khách chụp xong nhưng quên quét QR: nhập lại mã để hiện lại QR nhận ảnh.
    if (other?.status === "completed")
      return res.json({
        completed: true,
        booking: publicBooking(other),
        accessToken: other.accessToken,
      });
    fail(
      400,
      "Mã vé không đúng, chưa thanh toán hoặc không còn hiệu lực trong ngày.",
    );
  }
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
