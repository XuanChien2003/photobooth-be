import mongoose from "mongoose";
import { clearOnWrite, userCache } from "../services/read-cache.js";

const userSchema = new mongoose.Schema(
  {
    name: String,
    email: { type: String, unique: true },
    password: { type: String, select: false },
    role: { type: String, enum: ["admin", "staff"] },
    active: { type: Boolean, default: true },
    sessionVersion: { type: Number, default: 0, select: false },
  },
  { timestamps: true },
);

// Admin session checks are cached briefly; any change to a user (role, deactivation, password /
// sessionVersion) takes effect on the very next request.
clearOnWrite(userCache, userSchema);

export default mongoose.model("User", userSchema, "users");
