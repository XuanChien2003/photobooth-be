import mongoose from "mongoose";
import { z } from "zod";
import { formatZodError } from "../services/messages.js";

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof z.ZodError)
    return res.status(400).json({
      message: formatZodError(err),
    });
  if (err.code === 11000)
    return res.status(409).json({
      message: err.keyPattern?.email
        ? "Email này đã có tài khoản. Vui lòng dùng email khác."
        : err.keyPattern?.code
          ? "Mã vé vừa bị trùng. Vui lòng bấm tạo mã lại."
          : "Dữ liệu đã tồn tại.",
    });
  if (err.type === "entity.too.large")
    return res
      .status(413)
      .json({ message: "Ảnh quá lớn. Vui lòng thử lại với ảnh nhỏ hơn." });
  if (err.type === "entity.parse.failed")
    return res.status(400).json({ message: "Dữ liệu JSON không hợp lệ." });
  if (err instanceof mongoose.Error.CastError)
    return res.status(400).json({ message: "Mã dữ liệu không hợp lệ." });
  if (!err.status) console.error("Request failed:", err.name);
  res.status(err.status || 500).json({
    message: err.status
      ? err.message
      : "Không thể xử lý yêu cầu. Vui lòng thử lại.",
  });
}
