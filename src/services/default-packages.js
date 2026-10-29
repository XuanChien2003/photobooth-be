import { Package } from "../models/index.js";

// A new shop starts with the two advertised offers. Existing catalogs are
// never rewritten because their prices and entitlements may already be live.
export async function ensureDefaultPackages() {
  if (await Package.exists({})) return false;
  await Package.insertMany([
    {
      name: "Gói 70.000đ · 2 ảnh nhỏ",
      description: "12 lần chụp, 10 giây mỗi lần; một tờ 10×15 cm cắt thành hai dải ảnh.",
      price: 70000, duration: 15, shots: 12, countdownSeconds: 10,
      prints: 1, printSize: "strip", active: true,
    },
    {
      name: "Gói 100.000đ · 2 ảnh lớn",
      description: "16 lần chụp, 10 giây mỗi lần; hai tờ ảnh 10×15 cm nguyên khổ.",
      price: 100000, duration: 20, shots: 16, countdownSeconds: 10,
      prints: 2, printSize: "full", active: true,
    },
  ]);
  return true;
}
