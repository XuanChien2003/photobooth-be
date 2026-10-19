import { Booking } from "../models/index.js";
import { MEDIA_TTL_MS } from "../services/media.js";

export const quotaMessage = (quota, used) =>
  used < quota
    ? `Vé của bạn còn ${quota - used}/${quota} tờ in. Hãy bỏ bớt tờ, hoặc mua thêm tờ in tại quầy.`
    : `Vé đã dùng hết ${quota} tờ in. Muốn in thêm, bạn mua thêm tờ tại quầy nhé.`;
// Giữ chỗ n tờ in trong một lệnh ghi duy nhất: 2 lần bấm "Gửi in" cùng lúc không vượt số tờ của vé.
export const reserveSheets = (b, n) =>
  Booking.findOneAndUpdate(
    {
      _id: b._id,
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ["$printSheets", 0] }, n] },
          { $ifNull: ["$prints", 1] },
        ],
      },
    },
    { $inc: { printSheets: n } },
    { new: true },
  );
export const releaseSheets = (bookingId, n) =>
  Booking.updateOne({ _id: bookingId }, [
    {
      $set: {
        printSheets: {
          $max: [0, { $subtract: [{ $ifNull: ["$printSheets", 0] }, n] }],
        },
      },
    },
  ]);

export const publicJob = (job, accessToken) => ({
  _id: job._id,
  code: job.code,
  name: job.name,
  roomName: job.roomName,
  copies: job.copies,
  frameName: job.frameName,
  sheetCount: job.sheets?.length || 1,
  spoolStatus: job.spoolStatus,
  spoolMessage: job.spoolMessage,
  width: job.width,
  height: job.height,
  status: job.status,
  createdAt: job.createdAt,
  // Lệnh in lưu 24 giờ kể từ lúc gửi rồi tự xóa cùng file tờ in.
  expiresAt: new Date(new Date(job.createdAt).getTime() + MEDIA_TTL_MS),
  printedAt: job.printedAt,
  printedBy: job.printedBy,
  image: accessToken ? `/api/albums/${accessToken}/prints/${job._id}` : "",
});
