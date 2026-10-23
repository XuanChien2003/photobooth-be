import crypto from "node:crypto";
import sharp from "sharp";
import Frame from "../models/Frame.js";
import Sticker from "../models/Sticker.js";
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
export const frameThumbUrl = (frame) => `${frameImageUrl(frame)}&size=thumb`;
// Khung dạng nhẹ (không kèm ảnh) cho danh sách; `frame` lấy bằng .select(FRAME_LIST_FIELDS).lean().
export const FRAME_LIST_FIELDS = "-image -thumb";
export const frameListItem = ({ thumb, ...frame }) => ({
  ...frame,
  image: frameImageUrl(frame),
  thumb: frameThumbUrl(frame),
});

// Ảnh xem nhanh (WebP, giữ nền trong suốt) cho danh sách / bộ chọn: khung cạnh dài 720 px (đủ nét
// cho ô xem trên điện thoại màn hình dày điểm ảnh), thường 30–80 KB thay vì 0,5–10 MB ảnh gốc;
// nhãn dán 200 px (nút chọn ~60 px) vài KB thay vì tới 500 KB. Ghép ảnh và in luôn dùng ảnh gốc.
const THUMB_EDGE = { Frame: 720, Sticker: 200 };
async function makeThumb(dataUrl, edge) {
  const text = String(dataUrl || "");
  const comma = text.indexOf(",");
  if (!text.startsWith("data:image/") || comma < 0) return null;
  const out = await sharp(Buffer.from(text.slice(comma + 1), "base64"), { limitInputPixels: 40_000_000 })
    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 86, alphaQuality: 90, effort: 4 })
    .toBuffer();
  return `data:image/webp;base64,${out.toString("base64")}`;
}
export const makeFrameThumb = (dataUrl) => makeThumb(dataUrl, THUMB_EDGE.Frame);
export const makeStickerThumb = (dataUrl) => makeThumb(dataUrl, THUMB_EDGE.Sticker);
// Khung / nhãn dán cũ chưa có ảnh xem nhanh: tạo một lần rồi lưu. Ghi thẳng vào collection (không
// đổi updatedAt) và chỉ khi ảnh chưa bị đổi trong lúc tạo.
const making = new Map();
function ensureThumb(Model, docId) {
  const key = `${Model.modelName}:${docId}`;
  if (!making.has(key)) {
    const job = (async () => {
      const doc = await Model.findById(docId).select("image imageHash thumb").lean();
      if (!doc?.image) return null;
      if (doc.thumb) return doc.thumb;
      const thumb = await makeThumb(doc.image, THUMB_EDGE[Model.modelName]);
      if (thumb)
        await Model.collection.updateOne(
          { _id: doc._id, imageHash: doc.imageHash ?? null },
          { $set: { thumb } },
        );
      return thumb;
    })().finally(() => making.delete(key));
    making.set(key, job);
  }
  return making.get(key);
}
export const ensureFrameThumb = (frameId) => ensureThumb(Frame, frameId);
export const ensureStickerThumb = (stickerId) => ensureThumb(Sticker, stickerId);
// Lúc khởi động: lần lượt tạo ảnh xem nhanh cho khung / nhãn dán cũ (chạy nền, từng ảnh một vì
// máy chủ miễn phí ít CPU / RAM).
export async function backfillThumbs() {
  let count = 0;
  for (const Model of [Frame, Sticker]) {
    const docs = await Model.find({ thumb: { $exists: false }, image: { $type: "string" } })
      .select("_id")
      .lean();
    for (const doc of docs) await ensureThumb(Model, doc._id).catch(() => null);
    count += docs.length;
  }
  return count;
}

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

export const stickerImageUrl = (sticker) =>
  `/api/stickers/${sticker._id}/image?v=${imageVersion(sticker)}`;
export const STICKER_LIST_FIELDS = FRAME_LIST_FIELDS;
// Sticker dạng nhẹ (không kèm ảnh base64) cho danh sách và /catalog.
export const stickerListItem = ({ thumb, ...sticker }) => ({
  ...sticker,
  image: stickerImageUrl(sticker),
  thumb: `${stickerImageUrl(sticker)}&size=thumb`,
});
