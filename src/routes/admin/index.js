import { Router } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../../config.js";
import { Room } from "../../models/index.js";
import { allow, auth, requireBranch } from "../../middleware/auth.js";
import { fail, id } from "../validation.js";
import { ticketsRouter } from "./tickets.js";
import { printsRouter } from "./prints.js";
import { bookingsRouter } from "./bookings.js";
import { statsRouter } from "./stats.js";
import { settingsRouter } from "./settings.js";
import { resourcesRouter } from "./resources.js";
import { storageRouter } from "./storage.js";
import { shiftsRouter } from "./shifts.js";
import { studioRouter } from "./studio.js";

export const adminRouter = Router();

// Các route cấp mã tự kiểm tra đăng nhập trước khi áp dụng giới hạn cấp mã.
adminRouter.use("/tickets", ticketsRouter);
adminRouter.use(auth);
adminRouter.use("/print-jobs", printsRouter);
adminRouter.use(bookingsRouter);
adminRouter.use("/stats", statsRouter);
adminRouter.use("/storage", storageRouter);
adminRouter.use("/shifts", shiftsRouter);

// Cài máy chụp: chọn loại phòng (Photobooth / Polaroid, kèm chế độ thử đút tiền của photobooth) rồi
// mới cấp liên kết + QR. Không gửi loại phòng thì giữ nguyên như đang lưu.
const deviceSetup = z.object({
  kind: z.enum(["photobooth", "polaroid"]).optional(),
  paymentTest: z.boolean().optional(),
});
adminRouter.post("/rooms/:id/device", allow("rooms:setup"), async (req, res) => {
  const room = await Room.findById(id.parse(req.params.id));
  if (!room) fail(404, "Không tìm thấy phòng.");
  if (!room.active) fail(409, "Phòng chụp đã ngừng hoạt động.");
  requireBranch(req, room.branch);
  const d = deviceSetup.parse(req.body || {});
  if (d.kind) {
    // Chế độ thử (nút giả lập đút tiền) chỉ có ở phòng photobooth (phòng Polaroid không thu tiền).
    const paymentTest = d.kind === "photobooth" && Boolean(d.paymentTest);
    if ((room.kind || "photobooth") !== d.kind || room.paymentTest !== paymentTest)
      await Room.updateOne({ _id: room._id }, { kind: d.kind, paymentTest });
    room.kind = d.kind;
    room.paymentTest = paymentTest;
  }
  res.json({
    kind: room.kind || "photobooth",
    paymentTest: Boolean(room.paymentTest),
    token: jwt.sign({ type: "kiosk", room: String(room._id), jti: crypto.randomUUID() }, config.secret, {
      // Máy chụp nhớ liên kết sau lần mở đầu; 1 năm để tiệm không phải cài lại hằng tháng.
      expiresIn: "365d",
    }),
    name: room.name,
  });
});
adminRouter.use("/settings", settingsRouter);
adminRouter.use(studioRouter);
adminRouter.use(resourcesRouter);
