import mongoose from "mongoose";
import { catalogCache, clearOnWrite } from "../services/read-cache.js";

// Màn hình chờ của máy chụp (Thiết lập → Màn hình chờ). Một cấu hình chung (isDefault) cho mọi
// máy, thêm cấu hình riêng gắn với từng máy (rooms). Ảnh lưu base64 và phát lần lượt.
const screenSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    isDefault: { type: Boolean, default: false },
    rooms: [{ type: mongoose.Schema.Types.ObjectId, ref: "Room" }],
    title: { type: String, default: "" },
    subtitle: { type: String, default: "" },
    // Số giây mỗi ảnh khi có nhiều ảnh.
    interval: { type: Number, default: 6 },
    images: [{ data: String, hash: String }],
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

screenSchema.index({ isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });

// /api/catalog is cached in memory; any change here refreshes it.
clearOnWrite(catalogCache, screenSchema);

export default mongoose.model("Screen", screenSchema, "screens");
