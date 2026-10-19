import mongoose from "mongoose";
import { catalogCache, clearOnWrite } from "../services/read-cache.js";

const frameSchema = new mongoose.Schema(
  {
    name: String,
    themeName: { type: String, default: "" },
    order: { type: Number, default: 0 },
    printSize: { type: String, enum: ["full", "strip"], default: "full" },
    image: String,
    // Mã nội dung ảnh (sha1 rút gọn): đổi khi và chỉ khi đổi ảnh, dùng làm ?v= cho cache trình duyệt.
    imageHash: String,
    slots: [{ _id: false, x: Number, y: Number, w: Number, h: Number }],
    active: Boolean,
  },
  { timestamps: true },
);

// /api/catalog is cached in memory; any change here refreshes it.
clearOnWrite(catalogCache, frameSchema);

export default mongoose.model("Frame", frameSchema, "frames");
