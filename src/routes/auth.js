import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "../config.js";
import { User } from "../models/index.js";
import { auth, setSession } from "../middleware/auth.js";
import { sensitive } from "../middleware/rate-limits.js";
import { fail } from "./validation.js";

export const authRouter = Router();

authRouter.post("/login", sensitive(), async (req, res) => {
  const d = z
    .object({ email: z.email(), password: z.string().min(1).max(128) })
    .parse(req.body);
  const user = await User.findOne({
    email: d.email.toLowerCase(),
    active: true,
  }).select("+password +sessionVersion");
  if (!user || !(await bcrypt.compare(d.password, user.password)))
    fail(401, "Email hoặc mật khẩu không đúng.");
  setSession(res, user);
  res.json({ name: user.name, email: user.email, role: user.role });
});
authRouter.get("/me", auth, (req, res) => {
  // Chỉ thông tin tài khoản — không gửi mức lương về trình duyệt.
  const { _id, name, email, role, active } = req.user;
  res.json({ _id, name, email, role, active });
});
authRouter.post("/logout", (req, res) => {
  res.clearCookie("session", {
    httpOnly: true,
    sameSite: config.production ? "none" : "lax",
    secure: config.production,
  });
  res.json({ ok: true });
});
authRouter.post("/password", auth, async (req, res) => {
  const d = z
    .object({ current: z.string(), password: z.string().min(10).max(128) })
    .parse(req.body);
  const u = await User.findById(req.user._id).select(
    "+password +sessionVersion",
  );
  if (!(await bcrypt.compare(d.current, u.password)))
    fail(400, "Mật khẩu hiện tại không đúng.");
  const updated = await User.findOneAndUpdate(
    { _id: u._id, password: u.password },
    {
      $set: { password: await bcrypt.hash(d.password, 12) },
      $inc: { sessionVersion: 1 },
    },
    { new: true },
  ).select("+sessionVersion");
  if (!updated)
    fail(
      409,
      "Mật khẩu đã được thay đổi ở phiên khác. Vui lòng đăng nhập lại.",
    );
  setSession(res, updated);
  res.json({ ok: true });
});
