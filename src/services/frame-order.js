import { Frame } from "../models/index.js";
import { fail } from "../routes/validation.js";
import { frameListItem } from "./frame-image.js";

// Serialize catalog writes in this process, including edits and deletions.
let tail = Promise.resolve();
export function withFrameCatalogLock(action) {
  const result = tail.then(action);
  tail = result.catch(() => {});
  return result;
}

export async function moveFrame(frameId, direction, expectedIds) {
  const frame = await Frame.findById(frameId).lean();
  if (!frame) fail(404, "Khung đã bị xóa. Vui lòng làm mới danh sách.");
  const group = await Frame.find({
    $expr: {
      $eq: [
        { $trim: { input: { $ifNull: ["$themeName", ""] } } },
        frame.themeName?.trim() || "",
      ],
    },
  })
    .sort({ order: 1, _id: 1 })
    .lean();
  const ids = group.map((item) => String(item._id));
  if (ids.join() !== expectedIds.join())
    fail(
      409,
      "Danh sách khung vừa thay đổi. Đã làm mới danh sách; hãy chọn lại vị trí.",
    );
  const index = ids.indexOf(String(frameId));
  const next = index + (direction === "up" ? -1 : 1);
  if (next < 0 || next >= ids.length) fail(400, "Khung đã ở đầu hoặc cuối bộ.");
  [group[index], group[next]] = [group[next], group[index]];
  // One database command also resolves legacy duplicate/zero order values.
  await Frame.updateMany({ _id: { $in: group.map((item) => item._id) } }, [
    {
      $set: {
        order: {
          $add: [{ $indexOfArray: [group.map((item) => item._id), "$_id"] }, 1],
        },
        updatedAt: "$$NOW",
      },
    },
  ]);
  return (await Frame.find().select("-image").sort({ createdAt: -1 }).lean()).map(
    frameListItem,
  );
}
