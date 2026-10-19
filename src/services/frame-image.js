import crypto from "node:crypto";
import Frame from "../models/Frame.js";
import { catalogCache } from "./read-cache.js";

// Ảnh khung lưu trong DB dạng data URL (base64, có khung nặng ~0,5 MB) nên danh sách trả về địa chỉ
// ảnh riêng thay vì nhúng ảnh. Địa chỉ gắn ?v= theo nội dung ảnh: đổi tên / đổi thứ tự khung thì v
// giữ nguyên và trình duyệt vẫn dùng bản đã lưu, chỉ đổi ảnh mới phải tải lại.
export const hashImage = (image) =>
  crypto.createHash("sha1").update(String(image)).digest("hex").slice(0, 12);
// Khung cũ chưa có imageHash: tạm dùng thời điểm sửa gần nhất.
export const imageVersion = (frame) =>
  frame.imageHash || +(frame.updatedAt || frame.createdAt || 0);
export const frameImageUrl = (frame) =>
  `/api/frames/${frame._id}/image?v=${imageVersion(frame)}`;
// Khung dạng nhẹ (không kèm ảnh) cho danh sách; `frame` lấy bằng .select("-image").lean().
export const frameListItem = (frame) => ({
  ...frame,
  image: frameImageUrl(frame),
});

// Khung tạo trước khi có imageHash: tính một lần lúc khởi động để đổi tên / thứ tự khung không làm
// khách tải lại ảnh. Ghi thẳng vào collection nên không đổi updatedAt.
export async function backfillImageHashes() {
  const frames = await Frame.find({
    imageHash: { $exists: false },
    image: { $type: "string" },
  })
    .select("image")
    .lean();
  if (frames.length) catalogCache.clear();
  if (frames.length)
    await Frame.collection.bulkWrite(
      frames.map((frame) => ({
        updateOne: {
          filter: { _id: frame._id },
          update: { $set: { imageHash: hashImage(frame.image) } },
        },
      })),
    );
  return frames.length;
}
