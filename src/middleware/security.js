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
  app.use("/api/kiosk/photo", express.json({ limit: "64mb" }));
  app.use("/api/albums", express.json({ limit: "64mb" }));
  app.use(express.json({ limit: "16mb" }));
  app.use(cookieParser());
  app.use("/api", apiLimit);
}
