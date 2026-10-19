import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { User } from "./models/index.js";
if (
  !process.env.ADMIN_EMAIL ||
  !process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_PASSWORD.length < 10
)
  throw Error(
    "Cần ADMIN_EMAIL và ADMIN_PASSWORD tối thiểu 10 ký tự trong be/.env.",
  );
try {
  await mongoose.connect(config.mongo, { serverSelectionTimeoutMS: 10000 });
  if (!(await User.exists({ email: process.env.ADMIN_EMAIL })))
    await User.create({
      name: "Quản trị viên",
      email: process.env.ADMIN_EMAIL,
      password: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
      role: "admin",
    });
  console.log(
    "Đã kiểm tra tài khoản quản trị. Nhập dữ liệu cửa hàng trong trang quản trị; không tạo dữ liệu mẫu.",
  );
} catch (e) {
  console.error("Seed thất bại:", e.name);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
