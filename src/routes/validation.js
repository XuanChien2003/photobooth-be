import crypto from "node:crypto";
import { z } from "zod";

export const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
export const token = () => crypto.randomBytes(24).toString("hex");
export const id = z.string().regex(/^[a-f\d]{24}$/i);
export const phone = z
  .string()
  .regex(/^0[35789]\d{8}$/, "Số điện thoại Việt Nam không hợp lệ");
export const text = z.string().trim().min(1).max(200);
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) => !isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v),
    "Ngày không hợp lệ",
  );
export const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(
    new Date(),
  );
// Giá tiền: 0 (miễn phí) hoặc từ 1.000 đ — chặn gõ thiếu số 0 (vd. 20 thay vì 20.000).
export const priceVND = (max) =>
  z
    .number()
    .int()
    .min(0)
    .max(max)
    .refine(
      (v) => v === 0 || v >= 1000,
      "Giá tối thiểu 1.000 đ (để 0 nếu miễn phí) — kiểm tra có gõ thiếu số 0 không.",
    );
