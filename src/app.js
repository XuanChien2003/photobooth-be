import express from "express";
import path from "node:path";
import { config } from "./config.js";
import { configureSecurity } from "./middleware/security.js";
import { errorHandler } from "./middleware/errors.js";
import { publicRouter } from "./routes/public.js";
import { albumsRouter } from "./routes/albums.js";
import { kioskRouter } from "./routes/kiosk.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin/index.js";

export const app = express();
configureSecurity(app);

app.use("/api", publicRouter);
app.use("/api/albums", albumsRouter);
app.use("/api/kiosk", kioskRouter);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);

app.use("/api", (req, res) =>
  res.status(404).json({ message: "API không tồn tại." }),
);
app.use((req, res, next) =>
  config.frontendDist
    ? express.static(config.frontendDist)(req, res, next)
    : next(),
);
app.get("/{*path}", (req, res) =>
  config.frontendDist
    ? res.sendFile(path.join(config.frontendDist, "index.html"))
    : res
        .status(404)
        .json({ message: "Backend API. Frontend chạy riêng tại CLIENT_URL." }),
);
app.use(errorHandler);
