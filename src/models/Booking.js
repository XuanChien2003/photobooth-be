import mongoose from "mongoose";

const { Schema } = mongoose;
const bookingSchema = new Schema(
  {
    code: { type: String, unique: true },
    name: String,
    phone: String,
    room: { type: Schema.Types.ObjectId, ref: "Room" },
    package: { type: Schema.Types.ObjectId, ref: "Package" },
    roomName: String,
    packageName: String,
    shots: Number,
    prints: Number,
    date: String,
    time: String,
    source: { type: String, enum: ["counter", "scheduled"] },
    issuedBy: { type: Schema.Types.ObjectId, ref: "User" },
    total: Number,
    discount: Number,
    coupon: String,
    status: {
      type: String,
      enum: ["pending", "confirmed", "checked_in", "completed", "cancelled"],
      default: "pending",
    },
    paymentMethod: String,
    paid: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    accessToken: { type: String, unique: true, select: false },
    captureSession: { type: String, select: false },
    captureStartedAt: Date,
    captureEndsAt: Date,
    // folder: ảnh gốc máy ảnh (X Acquire) do máy chụp đọc từ thư mục — cách chụp duy nhất hiện nay.
    // camera / tether: chế độ cũ đã bỏ (chỉ còn trong vé cũ).
    captureMode: { type: String, enum: ["camera", "folder", "tether"] },
    // Snapshot at sale: later package edits must not change a paid ticket's time.
    captureDuration: Number,
    // Máy chụp báo "còn sống" vài giây một lần; máy khác chỉ nhận lại mã khi máy cũ im lặng.
    captureSeenAt: Date,
    // Tình trạng máy chụp gửi kèm khi báo "còn sống" (thư mục ảnh, số ảnh thấy được, lỗi đọc…)
    // để quản trị biết vì sao ảnh máy ảnh không về. Không trả cho khách.
    captureDiag: { type: Schema.Types.Mixed, select: false },
    nextPhotoNumber: { type: Number, default: 0 },
    requestKey: { type: String, unique: true, sparse: true, select: false },
    requestFingerprint: { type: String, select: false },
    photos: [
      {
        file: String,
        originalFile: String,
        thumbnailFile: String,
        previewFile: String,
        // Nguồn in 3000 px (đã xoay, lật như ảnh xem trước) — nhẹ hơn ảnh gốc 26 MP nhiều lần.
        printFile: String,
        originalName: String,
        kind: String,
        favorite: Boolean,
        deleted: Boolean,
        number: Number,
        clientKey: String,
        mirrored: Boolean,
        // Lets the uploader reuse its local JPEG only when no pixel conversion occurred.
        sourcePreserved: Boolean,
      },
    ],
    video: { file: String, mimeType: String, size: Number },
    printed: { type: Boolean, default: false },
    // prints: số tờ 10 × 15 cm được in (theo gói + mua thêm); printSheets: số tờ khách đã gửi in.
    printSheets: { type: Number, default: 0 },
    extraPrints: { type: Number, default: 0 },
    extraPrintKeys: { type: [String], select: false },
    mediaExpiresAt: Date,
    mediaDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

bookingSchema.index({ room: 1, date: 1 });
bookingSchema.index({ createdAt: -1 });
bookingSchema.index({ date: 1, createdAt: -1 });
bookingSchema.index({ status: 1, createdAt: -1 });
bookingSchema.index({ mediaExpiresAt: 1 });
// Dọn ảnh hết hạn 15 phút/lần tìm vé có ảnh cũ (ObjectId ảnh mang thời điểm chụp).
bookingSchema.index({ "photos._id": 1 });

export default mongoose.model("Booking", bookingSchema, "bookings");
