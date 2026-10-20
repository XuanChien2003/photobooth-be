import mongoose from "mongoose";

const { Schema } = mongoose;
// Ca trực của lễ tân tại một chi nhánh: mở ca (tiền đầu ca) → đóng ca (đếm tiền cuối ca, đối chiếu
// với số vé đã thu trong ca). Mỗi chi nhánh chỉ có một ca đang mở.
const shiftSchema = new Schema(
  {
    branch: { type: String, required: true },
    open: { type: Boolean, default: true },
    openedBy: { type: Schema.Types.ObjectId, ref: "User" },
    openedByName: String,
    openedAt: { type: Date, default: Date.now },
    openingCash: { type: Number, default: 0 },
    closedBy: { type: Schema.Types.ObjectId, ref: "User" },
    closedByName: String,
    closedAt: Date,
    closingCash: Number,
    note: String,
    summary: {
      tickets: Number,
      extraSheets: Number,
      cash: Number,
      transfer: Number,
      total: Number,
    },
  },
  { timestamps: true },
);

shiftSchema.index({ branch: 1 }, { unique: true, partialFilterExpression: { open: true } });
shiftSchema.index({ branch: 1, openedAt: -1 });

export default mongoose.model("Shift", shiftSchema, "shifts");
