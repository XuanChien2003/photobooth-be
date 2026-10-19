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
    active: Boolean,
  },
  { timestamps: true },
);

// /api/catalog is cached in memory; any change here refreshes it.
clearOnWrite(catalogCache, packageSchema);

export default mongoose.model("Package", packageSchema, "packages");
