import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "../config.js";
import { apiLimit } from "./rate-limits.js";

export function configureSecurity(app) {
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  const allowedOrigins = (config.origin || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const isAllowedOrigin = (origin) => {
    if (!origin) return true;
    const clean = origin.replace(/\/$/, "");
    return (
      allowedOrigins.includes(clean) ||
      clean === `http://localhost:${config.port}`
    );
  };
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
          return callback(null, origin || true);
        }
        return callback(null, false);
      },
      credentials: true,
    }),
  );
  // Trang Swagger (/api/docs) nằm cùng địa chỉ với máy chủ: yêu cầu cùng nguồn luôn hợp lệ.
  const sameOrigin = (req) =>
    req.headers.origin?.replace(/\/$/, "") ===
    `${req.protocol}://${req.get("host")}`;
  app.use((req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      !isAllowedOrigin(req.headers.origin) &&
      !sameOrigin(req)
    )
      return res.status(403).json({ message: "Nguồn yêu cầu không hợp lệ." });
    next();
  });
  // Giới hạn tần suất trước khi đọc body: yêu cầu bị chặn không tốn công tải và phân tích body.
  app.use("/api", apiLimit);
  // inflate: false — không máy nào gửi body nén; không giải nén thì cũng không dính lỗi giải nén
  // của body-parser (GHSA-27r3-jxmh-p828).
  app.use("/api/kiosk/photo", express.json({ limit: "64mb", inflate: false }));
  app.use("/api/albums", express.json({ limit: "64mb", inflate: false }));
  // Body JSON thường dưới 1 MB. Quản trị gửi ảnh khung / màn hình chờ / QR dạng base64 (tới 16 MB):
  // body đó chỉ được đọc sau khi đã kiểm tra đăng nhập (routes/admin/index.js), để yêu cầu chưa đăng
  // nhập không bắt máy chủ (512 MB RAM) đọc hàng chục MB.
  const json = express.json({ limit: "1mb", inflate: false });
  app.use((req, res, next) => (ADMIN_AFTER_LOGIN.test(req.path) ? next() : json(req, res, next)));
  app.use(cookieParser());
}
// Route quản trị đọc body sau bước đăng nhập (trừ /tickets: tự kiểm tra đăng nhập trong route).
const ADMIN_AFTER_LOGIN = /^\/api\/admin\/(?!tickets(\/|$))/;
