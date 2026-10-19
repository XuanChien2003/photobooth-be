import { Router } from "express";
import { z } from "zod";
import { getMonthRevenue, getStudioStats } from "../../services/stats.js";
import { admin, isAdmin } from "../../middleware/auth.js";
import { today } from "../validation.js";

export const statsRouter = Router();

statsRouter.get("/", async (req, res) => {
  const days = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(
      new Date(Date.now() - (6 - i) * 86400000),
    ),
  );
  const stats = await getStudioStats(today(), days);
  // Lễ tân: chỉ số lượt khách / lệnh in, không có doanh thu.
  if (!isAdmin(req)) {
    delete stats.revenue;
    delete stats.todayRevenue;
    delete stats.byDate;
  }
  res.json(stats);
});
// Xem lại doanh thu từng ngày của tháng bất kỳ (mặc định tháng hiện tại).
statsRouter.get("/revenue", admin, async (req, res) => {
  const month = z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Tháng không hợp lệ.")
    .parse(req.query.month ?? today().slice(0, 7));
  res.json(await getMonthRevenue(month));
});
