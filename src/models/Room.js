import mongoose from "mongoose";
import { catalogCache, clearOnWrite } from "../services/read-cache.js";

const roomSchema = new mongoose.Schema(
  {
    name: String,
    description: String,
    branch: String,
    machineCode: { type: String, default: "" },
    model: { type: String, default: "" },
    importedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    // Chế độ lật ảnh của máy chụp: "device" = theo cài đặt trên máy, "on"/"off" = quản trị đặt từ xa.
    flip: { type: String, enum: ["device", "on", "off"], default: "device" },
    // Lần cuối máy chụp báo còn mở (POST /kiosk/ping): bảng Quản lý máy hiện Online / Offline.
    lastSeenAt: { type: Date, default: null },
    active: Boolean,
  },
  { timestamps: true },
);

// /api/catalog is cached in memory; any change here refreshes it.
clearOnWrite(catalogCache, roomSchema);

export default mongoose.model("Room", roomSchema, "rooms");
