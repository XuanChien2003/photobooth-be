import mongoose from "mongoose";
import { catalogCache, clearOnWrite } from "../services/read-cache.js";

const roomSchema = new mongoose.Schema(
  {
    name: String,
    description: String,
    branch: String,
    active: Boolean,
  },
  { timestamps: true },
);

// /api/catalog is cached in memory; any change here refreshes it.
clearOnWrite(catalogCache, roomSchema);

export default mongoose.model("Room", roomSchema, "rooms");
