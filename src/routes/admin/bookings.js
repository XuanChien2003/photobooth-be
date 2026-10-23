import { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { Booking, PrintJob, Room, Setting } from "../../models/index.js";
import { allow, can, hideMoney, requireBranch, staffBranch } from "../../middleware/auth.js";
import { dispatchPrint } from "../../services/dnp.js";
import { MEDIA_TTL_MS, photoExpiry } from "../../services/media.js";
import { printEvents } from "../../services/print-events.js";
import { fail, id, date } from "../validation.js";
import { KIOSK_LIVE_MS } from "../kiosk-session.js";
import { publicJob } from "../print-helpers.js";

export const bookingsRouter = Router();

bookingsRouter.get("/bookings", async (req, res) => {
  const q = {};
  const assigned = staffBranch(req);
  if (assigned) q.branch = assigned;
  if (req.query.code)
    q.code = z
      .string()
      .regex(/^\d{6}$/, "Mã vé gồm 6 chữ số.")
      .parse(req.query.code);
  if (req.query.date) q.date = date.parse(req.query.date);
  if (req.query.from || req.query.to) {
    q.date = {};
    if (req.query.from) q.date.$gte = date.parse(req.query.from);
    if (req.query.to) q.date.$lte = date.parse(req.query.to);
  }
  if (req.query.status)
    q.status = z
      .enum(["pending", "confirmed", "checked_in", "completed", "cancelled"])
      .parse(req.query.status);
  if (req.query.room)
    q.roomName = z.string().trim().min(1).max(200).parse(req.query.room);
  if (req.query.paymentMethod)
    q.paymentMethod = z.enum(["cash", "transfer"]).parse(req.query.paymentMethod);
  // Danh sách tự làm mới 20 giây/lần ở nhiều màn hình: không kèm mảng ảnh (giao diện không dùng)
  // và chẩn đoán máy chụp; tra đúng một mã vé (Swagger) mới trả đủ để xem máy chụp đang thấy gì.
  const list = await Booking.find(q)
    .select(q.code ? "+accessToken +captureDiag" : "+accessToken -photos")
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  const ids = list.map((booking) => booking._id);
  // Ảnh đại diện của đơn: ảnh đã ghép khung (lệnh in gần nhất), chưa có thì tấm đầu tiên còn hạn.
  // Hai truy vấn chạy song song nên danh sách không chậm thêm một lượt đi về.
  const [jobs, covers] = list.length
    ? await Promise.all([
        PrintJob.find({
          booking: { $in: ids },
          createdAt: { $gt: new Date(Date.now() - MEDIA_TTL_MS) },
        })
          .sort({ createdAt: -1 })
          .lean(),
        Booking.aggregate([
          { $match: { _id: { $in: ids }, mediaDeleted: { $ne: true } } },
          { $project: { photos: { $slice: [{ $filter: {
            input: { $ifNull: ["$photos", []] },
            as: "p",
            cond: { $and: [{ $eq: ["$$p.kind", "original"] }, { $ne: ["$$p.deleted", true] }] },
          } }, 5] } } },
          { $project: { "photos._id": 1 } },
        ]),
      ])
    : [[], []];
  const now = Date.now();
  const cover = new Map(covers.map((b) => [
    String(b._id),
    b.photos.find((p) => photoExpiry(p).getTime() > now)?._id,
  ]));
  const latest = new Map();
  for (const job of jobs) {
    const key = String(job.booking);
    if (!latest.has(key)) latest.set(key, job);
  }
  res.json(
    list.map((booking) => {
      const job = latest.get(String(booking._id));
      const visible = hideMoney(req, booking);
      const photo = cover.get(String(booking._id));
      return {
        ...visible,
        latestPrint: job ? publicJob(job, booking.accessToken) : null,
        coverPhoto: photo && booking.accessToken
          ? `/api/albums/${booking.accessToken}/photos/${photo}?size=thumbnail`
          : null,
      };
    }),
  );
});
bookingsRouter.patch("/bookings/:id", async (req, res) => {
  const d = z
    .object({
      status: z
        .enum(["confirmed", "cancelled"])
        .optional(),
      printed: z.boolean().optional(),
      paymentReceived: z.boolean().optional(),
    })
    .parse(req.body);
  const b = await Booking.findById(id.parse(req.params.id));
  if (!b) fail(404, "Không tìm thấy vé.");
  requireBranch(req, b.branch);
  if (d.status === "cancelled" && !can(req, "orders:cancel"))
    fail(403, "Chỉ chủ cửa hàng hoặc nhân viên được cấp quyền hủy đơn mới hủy được mã chụp.");
  const allowed = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["cancelled"],
    checked_in: [],
    completed: [],
    cancelled: [],
  };
  if (d.status && !allowed[b.status].includes(d.status))
    fail(409, "Không thể chuyển trạng thái này.");
  if (d.status === "confirmed" && !d.paymentReceived)
    fail(400, "Vui lòng xác nhận đã nhận đủ tiền của khách.");
  if (d.status === "confirmed" && !b.code)
    fail(409, "Vui lòng kích hoạt mã tại quầy sau khi nhận tiền.");
  if (d.printed !== undefined && b.status !== "completed")
    fail(400, "Phiên chụp chưa hoàn tất.");
  const { paymentReceived, ...changes } = d;
  if (d.status === "confirmed") {
    changes.paid = true;
    changes.paidAt = new Date();
    changes.codeExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  }
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
bookingsRouter.post("/bookings/:id/prints", allow("print:operate"), async (req, res) => {
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
  const target = await Booking.findById(bookingId).select("branch").lean();
  if (!target) fail(404, "Không tìm thấy vé.");
  requireBranch(req, target.branch);
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
          requestedExtraPrints: {
            $max: [0, { $subtract: [{ $ifNull: ["$requestedExtraPrints", 0] }, d.sheets] }],
          },
          total: { $add: [{ $ifNull: ["$total", 0] }, amount] },
          extraSales: {
            $concatArrays: [
              { $ifNull: ["$extraSales", []] },
              [{ sheets: d.sheets, amount, paymentMethod: d.paymentMethod, at: "$$NOW" }],
            ],
          },
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

// In lại đúng file khách đã gửi mà không bắt khách ghép khung lần nữa. Đây là thao tác
// vận hành (kẹt giấy, muốn thêm bản giống hệt), nên không trừ thêm hạn mức tờ in của album.
bookingsRouter.post("/bookings/:id/reprint", allow("print:operate"), async (req, res) => {
  const d = z
    .object({
      jobId: id,
      copies: z.number().int().min(1).max(20),
    })
    .parse(req.body);
  const booking = await Booking.findById(id.parse(req.params.id)).select(
    "+accessToken branch code name roomName",
  );
  if (!booking) fail(404, "Không tìm thấy đơn hàng.");
  requireBranch(req, booking.branch);
  const source = await PrintJob.findOne({
    _id: d.jobId,
    booking: booking._id,
    createdAt: { $gt: new Date(Date.now() - MEDIA_TTL_MS) },
  });
  if (!source) fail(404, "File in không còn hoặc đã hết hạn lưu trữ.");
  const job = await PrintJob.create({
    booking: booking._id,
    code: booking.code,
    name: booking.name,
    roomName: booking.roomName,
    branch: booking.branch,
    copies: d.copies,
    frameName: source.frameName,
    printSize: source.printSize || "full",
    file: source.file,
    sheets: source.sheets,
    width: source.width,
    height: source.height,
    spoolStatus:
      config.dnpPrinter || config.printAgentToken ? "queued" : "idle",
  });
  dispatchPrint(job);
  const output = publicJob(job, booking.accessToken);
  printEvents.emit("print", { ...output, branch: booking.branch });
  res.status(201).json(output);
});
// Bảng phòng cho lễ tân: phòng nào trống, phòng nào đang chụp và còn bao lâu.
bookingsRouter.get("/rooms/live", async (req, res) => {
  const now = Date.now();
  const assigned = staffBranch(req);
  const [rooms, sessions] = await Promise.all([
    Room.find({ active: true, ...(assigned && { branch: assigned }) }).sort({ name: 1 }).select("name branch").lean(),
    Booking.find({
      status: "checked_in",
      ...(assigned && { branch: assigned }),
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
