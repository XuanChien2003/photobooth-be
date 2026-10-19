import mongoose from "mongoose";
import os from "node:os";
import sharp from "sharp";
import { config } from "./config.js";
import { app } from "./app.js";
import { migrateCounterIndexes } from "./services/counter-indexes.js";
import { startMediaCleanup } from "./services/media.js";
import Frame from "./models/Frame.js";
import { removeActivityLogs } from "./services/activity-log-cleanup.js";
import { validateMediaStorage } from "./services/r2.js";
import { backfillImageHashes } from "./services/frame-image.js";
if (!config.mongo || !config.secret || config.secret.length < 32)
  throw new Error("Thiếu MONGO_URI hoặc JWT_SECRET (ít nhất 32 ký tự).");
validateMediaStorage();
// Máy chủ miễn phí chỉ có 512 MB RAM: bộ nhớ đệm của sharp nhỏ hơn mặc định (50 MB, 100 mục).
sharp.cache({ memory: 32, files: 0, items: 32 });
// Gói free chỉ có ~0,1 CPU nhưng thấy nhiều lõi: nhiều luồng xử lý ảnh chỉ tranh nhau thời gian
// CPU ít ỏi (và RAM). Số luồng theo CPU thật được cấp; đặt SHARP_CONCURRENCY để ghi đè.
sharp.concurrency(Number(process.env.SHARP_CONCURRENCY) || Math.max(1, Math.min(4, os.availableParallelism())));
try {
  // Mặc định mongoose mở tới 100 kết nối; một máy chủ nhỏ + Atlas miễn phí chỉ cần vài kết nối.
  await mongoose.connect(config.mongo, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10,
  });
  await removeActivityLogs();
  await migrateCounterIndexes();
  // Bỏ các khung màu cũ: khung giờ chỉ tạo bằng cách import ảnh.
  const { deletedCount } = await Frame.deleteMany({
    $or: [{ image: { $in: [null, ""] } }, { "slots.0": { $exists: false } }],
  });
  if (deletedCount) console.log(`Đã xóa ${deletedCount} khung ảnh cũ.`);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  await backfillImageHashes();
  const server = app.listen(config.port, () =>
    console.log(`API ready: http://localhost:${config.port}`),
  );
  // Proxy phía trước giữ kết nối lâu hơn 5 giây mặc định của Node: tránh cắt đúng lúc nó dùng lại
  // kết nối cũ (lỗi 502 thỉnh thoảng) và đỡ phải bắt tay lại mỗi yêu cầu.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  startMediaCleanup();
  const { startSessionSweeper } = await import("./services/capture.js");
  startSessionSweeper();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () =>
      server.close(async () => {
        await mongoose.disconnect();
        process.exit(0);
      }),
    );
} catch (e) {
  console.error(
    "Không thể kết nối MongoDB:",
    e.name,
    "— kiểm tra URI, IP allowlist và kết nối mạng.",
  );
  process.exit(1);
}
