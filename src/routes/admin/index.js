import { Router } from "express";
import jwt from "jsonwebtoken";
import { config } from "../../config.js";
import { Room } from "../../models/index.js";
import { auth } from "../../middleware/auth.js";
import { fail, id } from "../validation.js";
import { ticketsRouter } from "./tickets.js";
import { printsRouter } from "./prints.js";
import { bookingsRouter } from "./bookings.js";
import { statsRouter } from "./stats.js";
import { settingsRouter } from "./settings.js";
import { resourcesRouter } from "./resources.js";
import { storageRouter } from "./storage.js";

export const adminRouter = Router();

// Các route cấp mã tự kiểm tra đăng nhập trước khi áp dụng giới hạn cấp mã.
adminRouter.use("/tickets", ticketsRouter);
adminRouter.use(auth);
adminRouter.use("/print-jobs", printsRouter);
adminRouter.use(bookingsRouter);
adminRouter.use("/stats", statsRouter);
adminRouter.use("/storage", storageRouter);

adminRouter.post("/rooms/:id/device", async (req, res) => {
  const room = await Room.findById(id.parse(req.params.id));
  if (!room) fail(404, "Không tìm thấy phòng.");
  if (!room.active) fail(409, "Phòng chụp đã ngừng hoạt động.");
  res.json({
    token: jwt.sign({ type: "kiosk", room: String(room._id) }, config.secret, {
      // Máy chụp nhớ liên kết sau lần mở đầu; 1 năm để tiệm không phải cài lại hằng tháng.
      expiresIn: "365d",
    }),
    name: room.name,
  });
});
adminRouter.use("/settings", settingsRouter);
adminRouter.use(resourcesRouter);
