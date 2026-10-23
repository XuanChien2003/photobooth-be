import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User, Room, Package, Frame, Sticker } from "../../models/index.js";
import { admin, isAdmin, staffBranch, STAFF_PERMISSIONS } from "../../middleware/auth.js";
import { fail, id, text, priceVND } from "../validation.js";
import { moveFrame, withFrameCatalogLock } from "../../services/frame-order.js";
import { frameListItem, hashImage, stickerListItem } from "../../services/frame-image.js";

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
      machineCode: z.string().trim().max(100).default(""),
      model: z.string().trim().max(100).default(""),
      importedAt: z.string().date().or(z.literal("")).nullable().default(null),
      expiresAt: z.string().date().or(z.literal("")).nullable().default(null),
      flip: z.enum(["device", "on", "off"]).default("device"),
      payment: z.enum(["counter", "cash"]).default("counter"),
      paymentTest: z.boolean().default(false),
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
      shots: z.number().int().min(1).max(40).default(12),
      countdownSeconds: z.number().int().min(1).max(30).default(10),
      selectCount: z.number().int().min(1).max(12).default(4),
      printSize: z.enum(["full", "strip"]).default("full"),
      prints: z.number().int().min(0).max(20),
      branches: z
        .array(z.string().trim().min(1).max(200))
        .max(50)
        .default([])
        .transform((items) => [...new Set(items)]),
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
  stickers: [
    Sticker,
    z.object({
      name: text,
      order: z.number().int().min(0).max(999).default(0),
      image: z
        .string({ error: "Vui lòng chọn ảnh nhãn dán." })
        .max(700_000, "Ảnh nhãn dán quá lớn (tối đa khoảng 500 KB).")
        .regex(
          /^data:image\/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
          "Nhãn dán cần là ảnh PNG hoặc WebP (nên có nền trong suốt).",
        ),
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
      branch: z.string().trim().max(200).default(""),
      permissions: z
        .array(z.enum(STAFF_PERMISSIONS))
        .max(STAFF_PERMISSIONS.length)
        .optional()
        .transform((items) => items && [...new Set(items)]),
      active,
    }).refine((user) => user.role !== "staff" || Boolean(user.branch), {
      message: "Nhân viên cần được gán chi nhánh.", path: ["branch"],
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
        route === "rooms" && !isAdmin(req) ? { active: true, branch: staffBranch(req) } : {},
      ).sort({ createdAt: -1 });
      res.json(
        route === "frames"
          ? (await query.select("-image").lean()).map(frameListItem)
          : route === "stickers"
            ? (await query.select("-image").lean()).map(stickerListItem)
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
      // Không gửi phân quyền thì giữ nguyên quyền đang lưu.
      if (d.permissions === undefined) delete d.permissions;
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
    if (route === "frames" || route === "stickers") d.imageHash = hashImage(d.image);
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
    if (route === "stickers") {
      // Sticker đã dán được in thẳng vào ảnh nên xóa hẳn không ảnh hưởng vé cũ.
      if (!(await Sticker.findByIdAndDelete(id.parse(req.params.id))))
        fail(404, "Không tìm thấy dữ liệu.");
      return res.json({ ok: true });
    }
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
