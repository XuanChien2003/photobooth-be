import mongoose from "mongoose";
import { catalogCache, clearOnWrite } from "../services/read-cache.js";

const packageSchema = new mongoose.Schema(
  {
    name: String,
    description: String,
    price: Number,
    duration: Number,
    shots: Number,
    prints: Number,
    countdownSeconds: { type: Number, default: 10 },
    // Số ảnh khách chọn để ghép khung trên máy chụp (vd. gói 70k chọn 4 tấm).
    selectCount: { type: Number, default: 4 },
    // full: 10 × 15 nguyên tờ · strip: 1 tờ cắt đôi · instax: thẻ Instax mini (máy Instax mini Link 3).
    printSize: { type: String, enum: ["full", "strip", "instax"], default: "full" },
    // Chi nhánh được bán gói này; để trống = mọi chi nhánh (cấu hình chung).
    branches: { type: [String], default: [] },
    active: Boolean,
  },
  { timestamps: true },
);

// /api/catalog is cached in memory; any change here refreshes it.
clearOnWrite(catalogCache, packageSchema);

export default mongoose.model("Package", packageSchema, "packages");
