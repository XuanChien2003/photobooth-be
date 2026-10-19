import mongoose from "mongoose";
import { Booking } from "../models/index.js";
import { MEDIA_TTL_MS, photoExpiry } from "./media.js";
import { fail } from "../routes/validation.js";

export async function saveAlbumFavorites(booking, ids) {
  const now = new Date();
  const photos = booking.photos.filter(
    (photo) =>
      photo.kind === "original" && !photo.deleted && photoExpiry(photo) > now,
  );
  // Favorites filter the album independently of the frame selected later.
  const available = new Set(photos.map((photo) => String(photo._id)));
  if (ids.some((photo) => !available.has(photo)))
    fail(400, "Ảnh được chọn không còn trong album hoặc đã hết hạn lưu trữ.");

  const wanted = ids.map((photo) => new mongoose.Types.ObjectId(photo));
  const firstAlive = mongoose.Types.ObjectId.createFromTime(
    Math.floor((now.getTime() - MEDIA_TTL_MS) / 1000) + 1,
  );
  const updated = await Booking.findOneAndUpdate(
    {
      _id: booking._id,
      status: "completed",
      ...(wanted.length && {
        $and: wanted.map((photo) => ({
          photos: {
            $elemMatch: {
              _id: { $eq: photo, $gte: firstAlive },
              kind: "original",
              deleted: { $ne: true },
            },
          },
        })),
      }),
    },
    [
      {
        $set: {
          photos: {
            $map: {
              input: "$photos",
              as: "photo",
              in: {
                $mergeObjects: [
                  "$$photo",
                  { favorite: { $in: ["$$photo._id", wanted] } },
                ],
              },
            },
          },
        },
      },
    ],
    { new: true },
  );
  if (!updated) fail(409, "Album vừa thay đổi. Vui lòng tải lại để chọn ảnh.");
  return updated;
}
