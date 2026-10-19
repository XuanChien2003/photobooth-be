import { Router } from "express";
import { z } from "zod";
import { Booking, Room, Setting } from "../../models/index.js";
import { hideMoney } from "../../middleware/auth.js";
import { fail, id, date } from "../validation.js";
import { KIOSK_LIVE_MS } from "../kiosk-session.js";

export const bookingsRouter = Router();

bookingsRouter.get("/bookings", async (req, res) => {
  const q = {};
  if (req.query.code)
    q.code = z
      .string()
      .regex(/^\d{6}$/, "Mã vé gồm 6 chữ số.")
      .parse(req.query.code);
  if (req.query.date) q.date = date.parse(req.query.date);
  if (req.query.status)
    q.status = z
      .enum(["pending", "confirmed", "checked_in", "completed", "cancelled"])
      .parse(req.query.status);
  // Danh sách tự làm mới 20 giây/lần ở nhiều màn hình: không kèm mảng ảnh (giao diện không dùng)
  // và chẩn đoán máy chụp; tra đúng một mã vé (Swagger) mới trả đủ để xem máy chụp đang thấy gì.
  const list = await Booking.find(q)
    .select(q.code ? "+accessToken +captureDiag" : "+accessToken -photos")
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  res.json(list.map((b) => hideMoney(req, b)));
});
bookingsRouter.patch("/bookings/:id", async (req, res) => {
  const d = z
    .object({
      status: z
        .enum(["confirmed", "checked_in", "completed", "cancelled"])
        .optional(),
      printed: z.boolean().optional(),
    })
    .parse(req.body);
  const b = await Booking.findById(id.parse(req.params.id));
  if (!b) fail(404, "Không tìm thấy vé.");
  const allowed = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["checked_in", "cancelled"],
    checked_in: ["completed"],
    completed: [],
    cancelled: [],
  };
  if (d.status && !allowed[b.status].includes(d.status))
    fail(409, "Không thể chuyển trạng thái này.");
  if (d.printed !== undefined && b.status !== "completed")
    fail(400, "Phiên chụp chưa hoàn tất.");
  const changes = { ...d };
  if (d.status === "confirmed") changes.paid = true;
  if (d.status === "cancelled") {
    changes.active = false;
    changes.paid = false;
  }
  const updated = await Booking.findOneAndUpdate(
    { _id: b._id, status: b.status },
    changes,
    { new: true },
  );
  if (!updated) fail(409, "Vé đã được cập nhật. Vui lòng tải lại.");
  res.json(hideMoney(req, updated.toObject()));
});
// Bán thêm tờ in tại quầy: cộng số tờ cho vé và cộng tiền vào doanh thu của vé.
bookingsRouter.post("/bookings/:id/prints", async (req, res) => {
  const d = z
    .object({
      sheets: z.number().int().min(1).max(20),
      paymentMethod: z.enum(["cash", "transfer"]),
      paymentReceived: z.literal(true, {
        error: "Vui lòng xác nhận đã nhận đủ tiền của khách.",
      }),
      expectedTotal: z.number().int().nonnegative(),
      requestKey: z.uuid(),
    })
    .parse(req.body);
  const bookingId = id.parse(req.params.id);
  const settings = (await Setting.findOne({ key: "studio" }).lean())?.value;
  const amount = d.sheets * (Number(settings?.extraPrintPrice) || 0);
  if (d.expectedTotal !== amount)
    fail(409, "Giá in thêm vừa thay đổi. Vui lòng kiểm tra lại số tiền.");
  const updated = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      paid: true,
      status: { $in: ["confirmed", "checked_in", "completed"] },
      mediaDeleted: { $ne: true },
      extraPrintKeys: { $ne: d.requestKey },
    },
    [
      {
        $set: {
          prints: { $add: [{ $ifNull: ["$prints", 1] }, d.sheets] },
          extraPrints: { $add: [{ $ifNull: ["$extraPrints", 0] }, d.sheets] },
          total: { $add: [{ $ifNull: ["$total", 0] }, amount] },
          extraPrintKeys: {
            $concatArrays: [
              { $ifNull: ["$extraPrintKeys", []] },
              [d.requestKey],
            ],
          },
        },
      },
    ],
    { new: true },
  );
  if (!updated) {
    // Bấm lại sau khi mất phản hồi: trả kết quả cũ, không cộng tiền lần nữa.
    const replay = await Booking.findOne({
      _id: bookingId,
      extraPrintKeys: d.requestKey,
    });
    if (replay)
      return res.json(
        hideMoney(req, { ...replay.toObject(), extraPrintKeys: undefined }),
      );
    fail(
      409,
      "Vé đã hủy, chưa thanh toán hoặc ảnh đã hết hạn — không bán thêm tờ in được.",
    );
  }
  res.json(
    hideMoney(req, { ...updated.toObject(), extraPrintKeys: undefined }),
  );
});
// Bảng phòng cho lễ tân: phòng nào trống, phòng nào đang chụp và còn bao lâu.
bookingsRouter.get("/rooms/live", async (req, res) => {
  const now = Date.now();
  const [rooms, sessions] = await Promise.all([
    Room.find({ active: true }).sort({ name: 1 }).select("name branch").lean(),
    Booking.find({
      status: "checked_in",
      room: { $ne: null },
      $or: [
        { captureEndsAt: { $gt: new Date(now) } },
        {
          captureStartedAt: { $exists: false },
          captureSeenAt: { $gte: new Date(now - 10 * 60000) },
        },
      ],
    })
      .select("code name room captureEndsAt captureSeenAt")
      .lean(),
  ]);
  res.json({
    now,
    rooms: rooms.map((room) => {
      const s = sessions.find((x) => String(x.room) === String(room._id));
      return {
        _id: room._id,
        name: room.name,
        branch: room.branch,
        status: !s ? "free" : s.captureEndsAt ? "shooting" : "starting",
        code: s?.code,
        customer: s?.name,
        endsAt: s?.captureEndsAt,
        online: Boolean(
          s?.captureSeenAt &&
          now - new Date(s.captureSeenAt).getTime() < KIOSK_LIVE_MS,
        ),
      };
    }),
  });
});
