import mongoose from "mongoose";

const kioskAttemptSchema = new mongoose.Schema(
  {
    deviceKey: { type: String, required: true, unique: true },
    failures: { type: Number, default: 0 },
    lockedUntil: Date,
  },
  { timestamps: true },
);

kioskAttemptSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 86400 });

export default mongoose.model("KioskAttempt", kioskAttemptSchema, "kiosk_attempts");
