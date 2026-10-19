import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { Booking, Room, Package } from "../../models/index.js";
import { auth } from "../../middleware/auth.js";
import { bookingLimit } from "../../middleware/rate-limits.js";
import { fail, id, phone, token, today } from "../validation.js";
import { publicBooking } from "../booking-helpers.js";

export const ticketsRouter = Router();

ticketsRouter.post("/quote", auth, async (req, res) => {
  const d = z.object({ package: id }).parse(req.body);
  const pack = await Package.findOne({ _id: d.package, active: true });
  if (!pack) fail(400, "Gói chụp không còn hoạt động.");
  res.json({ total: pack.price, discount: 0 });
});
ticketsRouter.post("/", auth, bookingLimit, async (req, res) => {
  const d = z
    .object({
      name: z.string().trim().max(100).default(""),
      phone: z.union([phone, z.literal("")]).default(""),
      // Mã dùng ở phòng nào cũng được; lễ tân chỉ gợi ý phòng đang trống (không bắt buộc).
      room: z.union([id, z.literal("")]).default(""),
      package: id,
      paymentMethod: z.enum(["cash", "transfer"]),
      requestKey: z.uuid(),
      paymentReceived: z.literal(true, {
        error: "Vui lòng xác nhận đã nhận đủ tiền của khách.",
      }),
      expectedTotal: z.number().int().nonnegative().optional(),
    })
    .parse(req.body);
  const requestFingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify({ ...d, issuedBy: String(req.user._id) }))
    .digest("hex");
  const replay = async () => {
    if (!d.requestKey) return null;
    const existing = await Booking.findOne({ requestKey: d.requestKey }).select(
      "+accessToken +requestFingerprint",
    );
    if (existing && existing.requestFingerprint !== requestFingerprint)
      fail(409, "Thông tin tạo mã đã thay đổi. Vui lòng kiểm tra lại.");
    return existing;
  };
  const previous = await replay();
  if (previous)
    return res.json({
      ...publicBooking(previous),
      accessToken: previous.accessToken,
    });
  const [room, pack] = await Promise.all([
    d.room ? Room.findOne({ _id: d.room, active: true }) : null,
    Package.findOne({ _id: d.package, active: true }),
  ]);
  if ((d.room && !room) || !pack)
    fail(400, "Phòng hoặc gói chụp không còn hoạt động.");
  if (d.expectedTotal !== undefined && d.expectedTotal !== pack.price)
    fail(
      409,
      "Giá gói vừa thay đổi. Vui lòng kiểm tra lại số tiền trước khi tạo mã.",
    );
  const accessToken = token();
  let b;
  for (let i = 0; i < 5; i++) {
    try {
      b = await Booking.create({
        ...d,
        name: d.name || "Khách tại quầy",
        date: today(),
        time: "",
        status: "confirmed",
        paid: true,
        source: "counter",
        issuedBy: req.user._id,
        code: String(crypto.randomInt(100000, 1000000)),
        accessToken,
        requestFingerprint,
        room: room?._id,
        roomName: room?.name || "",
        packageName: pack.name,
        captureDuration: pack.duration,
        prints: pack.prints,
        total: pack.price,
        discount: 0,
      });
      break;
    } catch (e) {
      if (e.code === 11000) {
        const existing = await replay();
        if (existing)
          return res.json({
            ...publicBooking(existing),
            accessToken: existing.accessToken,
          });
      }
      if (e.code === 11000 && e.keyPattern?.code) continue;
      throw e;
    }
  }
  if (!b) fail(503, "Không thể tạo mã vé. Vui lòng thử lại.");
  res.status(201).json({ ...publicBooking(b), accessToken });
});
