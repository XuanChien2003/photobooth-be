import sharp from "sharp";
import { readMedia } from "./media.js";

// Hàng chờ in hiện nhỏ nhiều tờ cùng lúc (tối đa 240 px cao), mỗi tờ gốc 1181 × 1772 px nặng cả
// trăm KB. Tạo bản xem trước nhỏ một lần rồi giữ lại trong bộ nhớ (chỉ vài MB) để các lần mở hàng
// chờ sau không phải giải mã lại: tải về nhẹ hơn ~10 lần mà không tốn thêm chỗ lưu.
const PREVIEW_EDGE = 512;
const MAX_PREVIEWS = 60;
const previews = new Map();

export function sheetPreview(file) {
  if (previews.has(file)) {
    // Dùng gần đây nhất thì đẩy xuống cuối để bị xóa sau cùng.
    const hit = previews.get(file);
    previews.delete(file);
    previews.set(file, hit);
    return hit;
  }
  const made = readMedia(file)
    .then((data) =>
      data
        ? sharp(data)
            .resize({
              width: PREVIEW_EDGE,
              height: PREVIEW_EDGE,
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: 78 })
            .toBuffer()
        : null,
    )
    .then((preview) => {
      // Tệp chưa có (hoặc đã hết hạn): không nhớ, lần sau hỏi lại.
      if (!preview) previews.delete(file);
      return preview;
    })
    .catch((error) => {
      previews.delete(file);
      throw error;
    });
  previews.set(file, made);
  if (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value);
  return made;
}
