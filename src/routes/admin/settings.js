import { Router } from "express";
import { z } from "zod";
import { Setting } from "../../models/index.js";
import { admin } from "../../middleware/auth.js";
import { text, priceVND } from "../validation.js";

export const settingsRouter = Router();

settingsRouter.get("/", admin, async (req, res) =>
  res.json((await Setting.findOne({ key: "studio" }))?.value || {}),
);

// Only the extra-sheet price, set from the "Bán thêm tờ in" dialog (admins only); the rest of the
// studio settings are left exactly as they are.
settingsRouter.put("/extra-print-price", admin, async (req, res) => {
  const { extraPrintPrice } = z
    .object({ extraPrintPrice: priceVND(10_000_000) })
    .parse(req.body);
  const saved = await Setting.findOneAndUpdate(
    { key: "studio" },
    { $set: { "value.extraPrintPrice": extraPrintPrice } },
    { upsert: true, new: true },
  );
  res.json(saved.value);
});

// Màn hình chờ của máy chụp (Tap to start): tiêu đề, dòng phụ và ảnh nền tùy chọn.
settingsRouter.put("/kiosk", admin, async (req, res) => {
  const kiosk = z
    .object({
      idleTitle: z.string().trim().max(60).default(""),
      idleSubtitle: z.string().trim().max(120).default(""),
      idleImage: z
        .string()
        .max(4_200_000, "Ảnh nền quá lớn. Vui lòng chọn ảnh dưới 3 MB.")
        .refine(
          (v) => v === "" || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v),
          "Ảnh nền phải là ảnh PNG, JPG hoặc WebP.",
        )
        .default(""),
    })
    .parse(req.body);
  const saved = await Setting.findOneAndUpdate(
    { key: "studio" },
    { $set: { "value.kiosk": kiosk } },
    { upsert: true, new: true },
  );
  res.json(saved.value);
});

settingsRouter.put("/", admin, async (req, res) => {
  const value = z
    .object({
      name: text,
      address: text,
      phone: z
        .string()
        .trim()
        .regex(/^[+\d][\d .-]{6,18}$/, "Số điện thoại không hợp lệ."),
      bank: z.string().trim().max(100),
      bankAccount: z
        .string()
        .trim()
        .regex(/^$|^[\d ]{6,30}$/, "Số tài khoản chỉ gồm chữ số (6–30 số)."),
      bankOwner: z.string().trim().max(100),
      bankQrImage: z
        .string()
        .max(2_100_000, "Ảnh QR quá lớn. Vui lòng chọn ảnh dưới 1,5 MB.")
        .refine(
          (v) =>
            v === "" ||
            /^https?:\/\//.test(v) ||
            /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(v),
          "Ảnh QR phải là URL hoặc ảnh base64 hợp lệ",
        )
        .optional()
        .default(""),
      // Giá bán thêm 1 tờ in 15 × 10 cm tại quầy (0 = chưa bán lẻ).
      extraPrintPrice: priceVND(10_000_000).optional(),
    })
    // Thông tin chuyển khoản: nhập thì nhập đủ cả 3 ô.
    .refine(
      (v) =>
        [v.bank, v.bankAccount, v.bankOwner].every(Boolean) ||
        ![v.bank, v.bankAccount, v.bankOwner].some(Boolean),
      "Vui lòng nhập đủ tên ngân hàng, số tài khoản và chủ tài khoản.",
    )
    .parse(req.body);
  // Ghi từng mục: không xóa mất cài đặt lưu ở chỗ khác (giá in thêm, màn hình chờ kiosk).
  const saved = await Setting.findOneAndUpdate(
    { key: "studio" },
    { $set: Object.fromEntries(Object.entries(value).map(([key, v]) => [`value.${key}`, v])) },
    { upsert: true, new: true },
  );
  res.json(saved.value);
});
