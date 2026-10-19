import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { User } from "../models/index.js";
import { userCache } from "../services/read-cache.js";

export function setSession(res, user) {
  const signed = jwt.sign(
    { sub: String(user._id), version: user.sessionVersion || 0 },
    config.secret,
    { expiresIn: config.expires },
  );
  const { exp } = jwt.decode(signed);
  res.cookie("session", signed, {
    httpOnly: true,
    sameSite: config.production ? "none" : "lax",
    secure: config.production,
    maxAge: Math.max(0, exp * 1000 - Date.now()),
  });
}
export async function auth(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.session || "", config.secret);
    // One database round trip saved on every admin request (the database is far away).
    req.user = await userCache.get(String(p.sub), () =>
      User.findById(p.sub).select("+sessionVersion").lean());
    if (
      !req.user?.active ||
      (p.version || 0) !== (req.user.sessionVersion || 0)
    )
      throw Error();
    next();
  } catch {
    res.status(401).json({ message: "Vui lòng đăng nhập." });
  }
}
export const isAdmin = (req) => req.user?.role === "admin";
export const hideMoney = (req, b) =>
  isAdmin(req) ? b : { ...b, total: undefined, discount: undefined };
export const admin = (req, res, next) =>
  req.user.role === "admin"
    ? next()
    : res
        .status(403)
        .json({ message: "Chỉ quản trị viên được thực hiện thao tác này." });
