import mongoose from "mongoose";
import { config } from "../src/config.js";
import {
  ACTIVITY_LOG_COLLECTIONS,
  removeActivityLogs,
} from "../src/services/activity-log-cleanup.js";

const deadline = setTimeout(() => {
  console.error("Dọn nhật ký quá thời gian. Không thực hiện thao tác khác.");
  process.exit(1);
}, 30000);

let stage = "connect";
let result;
try {
  if (!config.mongo) throw new Error("MongoDB configuration missing");
  await mongoose.connect(config.mongo, {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    socketTimeoutMS: 10000,
    autoIndex: false,
    autoCreate: false,
  });
  const db = mongoose.connection.db;
  stage = "cleanup";
  result = await removeActivityLogs(db);
  stage = "verify";
  const remaining = (
    await Promise.all(
      ACTIVITY_LOG_COLLECTIONS.map((name) =>
        db.listCollections({ name }, { nameOnly: true }).toArray(),
      ),
    )
  ).flat();
  console.log(
    JSON.stringify({
      ...result,
      remainingLogCollections: remaining.map((collection) => collection.name),
    }),
  );
  if (remaining.length) process.exitCode = 1;
} catch (error) {
  console.error("Chưa dọn được nhật ký. Kiểm tra kết nối và quyền MongoDB.");
  // Diagnostics exclude the URI, server address and raw error message.
  console.error(
    JSON.stringify({
      stage,
      code: typeof error.code === "number" ? error.code : null,
      ...result,
    }),
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
  clearTimeout(deadline);
}
