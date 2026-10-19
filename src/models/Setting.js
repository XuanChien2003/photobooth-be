import mongoose from "mongoose";
import { catalogCache, clearOnWrite } from "../services/read-cache.js";

const settingSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true },
);

// /api/catalog is cached in memory; any change here refreshes it.
clearOnWrite(catalogCache, settingSchema);

export default mongoose.model("Setting", settingSchema, "settings");
