import mongoose from "mongoose";
import { catalogCache, clearOnWrite } from "../services/read-cache.js";

// Sticker ảnh (PNG nền trong suốt) do chủ cửa hàng tải lên; khách dán lên khung ở bước trang trí.
const stickerSchema = new mongoose.Schema(
  {
    name: String,
    image: String,
    // Mã nội dung ảnh, dùng làm ?v= để trình duyệt giữ ảnh đã tải.
    imageHash: String,
    order: { type: Number, default: 0 },
    active: Boolean,
  },
  { timestamps: true },
);

// /api/catalog is cached in memory; any change here refreshes it.
clearOnWrite(catalogCache, stickerSchema);

export default mongoose.model("Sticker", stickerSchema, "stickers");
