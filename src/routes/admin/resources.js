import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User, Room, Package, Frame } from "../../models/index.js";
import { admin, isAdmin } from "../../middleware/auth.js";
import { fail, id, text, priceVND } from "../validation.js";
import { moveFrame, withFrameCatalogLock } from "../../services/frame-order.js";
import { frameListItem, hashImage } from "../../services/frame-image.js";

export const resourcesRouter = Router();

// Danh sách khung không kèm ảnh base64 (mỗi lần tải lại cả trăm KB tới vài MB): chỉ trả địa chỉ
// ảnh để cache; mở sửa khung thì lấy đủ ảnh của đúng khung đó ở đây.
resourcesRouter.get("/frames/:id", admin, async (req, res) => {
  const frame = await Frame.findById(id.parse(req.params.id));
  if (!frame) fail(404, "Không tìm thấy dữ liệu.");
  res.json(frame);
});
resourcesRouter.post("/frames/:id/move", admin, async (req, res) => {
  const d = z
    .object({
      direction: z.enum(["up", "down"]),
      expectedIds: z.array(id).min(1).max(1000),
    })
    .parse(req.body);
  res.json(
    await withFrameCatalogLock(() =>
      moveFrame(id.parse(req.params.id), d.direction, d.expectedIds),
    ),
  );
});

const active = z.boolean();
const resources = {
  rooms: [
    Room,
    z.object({
      name: text,
      description: z.string().max(1000),
      branch: text,
      active,
    }),
  ],
  packages: [
    Package,
    z.object({
      name: text,
      description: z.string().max(1000),
      price: priceVND(100_000_000),
      duration: z.number().int().min(1).max(30),
      prints: z.number().int().min(0).max(20),
      active,
    }),
  ],
  frames: [
    Frame,
    // Khung chỉ tạo bằng cách import ảnh (PNG/JPG) kèm vị trí các ô đặt ảnh, tỉ lệ 0–1.
    z.object({
      name: text,
      themeName: z.string().trim().max(100).default(""),
      order: z.number().int().min(0).max(999).default(0),
      printSize: z.enum(["full", "strip"]).default("full"),
      image: z
        .string({ error: "Vui lòng import ảnh khung." })
        .max(3_000_000, "Ảnh khung quá lớn.")
        .regex(
          /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
          "Vui lòng import ảnh khung (PNG/JPG).",
        ),
      slots: z
        .array(
          z.object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            w: z.number().gt(0).max(1),
            h: z.number().gt(0).max(1),
          }),
        )
        .min(
          1,
          "Không tìm thấy ô đặt ảnh (vùng trắng/trong suốt) trong ảnh khung.",
        )
        .max(40, "Mỗi khung hỗ trợ tối đa 40 ô đặt ảnh."),
      active,
    }),
  ],
  users: [
    User,
    z.object({
      name: text,
      email: z.email().transform((v) => v.toLowerCase()),
      password: z.string().min(10).max(128).optional(),
      role: z.enum(["admin", "staff"]),
      active,
    }),
  ],
};
for (const [route, [Model, schema]] of Object.entries(resources)) {
  // adminRouter đã kiểm tra phiên: lễ tân chỉ xem phòng đang hoạt động để mở kiosk.
  resourcesRouter.get(
    `/${route}`,
    ...(route === "rooms" ? [] : [admin]),
    async (req, res) => {
      const query = Model.find(
        route === "rooms" && !isAdmin(req) ? { active: true } : {},
      ).sort({ createdAt: -1 });
      res.json(
        route === "frames"
          ? (await query.select("-image").lean()).map(frameListItem)
          : await query,
      );
    },
  );
  const save = async (req, res) => {
    const d = schema.parse(req.body);
    if (route === "users") {
      if (!req.params.id && !d.password)
        fail(400, "Vui lòng nhập mật khẩu (ít nhất 10 ký tự).");
      // Quản trị viên không tự sửa / tự ngừng tài khoản đang đăng nhập (tránh tự khóa mình);
      // đổi mật khẩu dùng “Đổi mật khẩu”, đổi tên / email nhờ quản trị viên khác.
      if (req.params.id === String(req.user._id))
        fail(
          403,
          "Không thể tự sửa tài khoản đang đăng nhập. Đổi mật khẩu ở mục “Đổi mật khẩu”; đổi tên / email nhờ quản trị viên khác.",
        );
      if (d.password) d.password = await bcrypt.hash(d.password, 12);
    }
    // Phòng / gói đang dùng không được trùng tên (không phân biệt hoa thường): dễ nhầm ở quầy
    // và bảng phòng.
    if ((route === "rooms" || route === "packages") && d.active) {
      const clash = await Model.findOne({
        ...(req.params.id && { _id: { $ne: id.parse(req.params.id) } }),
        active: true,
        name: new RegExp(
          `^${d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        ),
      }).lean();
      if (clash)
        fail(
          409,
          `Đã có ${route === "rooms" ? "phòng" : "gói chụp"} tên “${clash.name}”. Vui lòng đặt tên khác.`,
        );
    }
    if (route === "frames") d.imageHash = hashImage(d.image);
    const changes = { $set: d };
    if (route === "users" && d.password) changes.$inc = { sessionVersion: 1 };
    const write = () =>
      req.params.id
        ? Model.findByIdAndUpdate(id.parse(req.params.id), changes, {
            new: true,
          })
        : Model.create(d);
    const result =
      route === "frames" ? await withFrameCatalogLock(write) : await write();
    if (!result) fail(404, "Không tìm thấy dữ liệu.");
    const out = result.toObject();
    delete out.password;
    res.json(out);
  };
  resourcesRouter.post(`/${route}`, admin, save);
  resourcesRouter.put(`/${route}/:id`, admin, save);
  resourcesRouter.delete(`/${route}/:id`, admin, async (req, res) => {
    if (route === "users" && String(req.user._id) === req.params.id)
      fail(403, "Không thể tự ngừng hoạt động tài khoản đang đăng nhập.");
    if (route === "frames") {
      // Khung không gắn với vé nào nên xóa hẳn.
      const removed = await withFrameCatalogLock(() =>
        Frame.findByIdAndDelete(id.parse(req.params.id)),
      );
      if (!removed) fail(404, "Không tìm thấy dữ liệu.");
      return res.json({ ok: true });
    }
    const result = await Model.findByIdAndUpdate(
      id.parse(req.params.id),
      { active: false },
      { new: true },
    );
    if (!result) fail(404, "Không tìm thấy dữ liệu.");
    res.json({ ok: true });
  });
}
