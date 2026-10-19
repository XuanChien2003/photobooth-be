import mongoose from "mongoose";

const { Schema } = mongoose;
// Lệnh in khách gửi từ Web App: file khung đã ghép (độ phân giải cao) chờ lễ tân in.
const printJobSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", index: true },
    code: String,
    name: String,
    roomName: String,
    copies: Number,
    frameName: String,
    file: String,
    sheets: [{ file: String, width: Number, height: Number }],
    requestKey: { type: String, unique: true, sparse: true },
    requestFingerprint: { type: String, select: false },
    spoolStatus: { type: String, default: "idle" },
    spoolMessage: String,
    width: Number,
    height: Number,
    status: {
      type: String,
      enum: ["pending", "printed"],
      default: "pending",
    },
    printedAt: Date,
    printedBy: String,
  },
  { timestamps: true },
);

printJobSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model("PrintJob", printJobSchema, "print_jobs");
