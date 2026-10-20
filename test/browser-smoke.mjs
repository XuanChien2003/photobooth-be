// Kiểm tra nhanh toàn bộ luồng nội bộ của tiệm trên trình duyệt thật (bản build Photo_FE/dist):
// lễ tân cấp mã → máy chụp trong phòng → khách quét QR mở album trên điện thoại → gửi in
// → lễ tân in 15 × 10 cm (DNP DS-RX1). Chạy: (cd ../Photo_FE && npm run build) && npm run test:browser
import "./environment.js";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { config, root } from "../src/config.js";
import { MEDIA_TTL_MS, saveMedia, readMedia } from "../src/services/media.js";
import {
  User,
  Room,
  Package,
  Frame,
  Setting,
  Booking,
  PrintJob,
} from "../src/models/index.js";

const memory = await MongoMemoryServer.create();
await mongoose.connect(memory.getUri());
await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
config.secret = "browser-test-secret-not-for-production-123456789";
// Không bao giờ in thật / điều khiển máy ảnh thật khi chạy test trên máy ở tiệm.
config.dnpPrinter = "";
config.mediaStorageLimitMB = 512;
const cloudflare = process.argv.includes("--cloudflare");
const browserOrigin = "http://localhost:8082";
// With --cloudflare, CLIENT_URL deliberately names some other site: the Worker must validate
// and translate the browser's origin for every mutation without Render listing it.
config.origin = cloudflare ? "https://another-frontend.example" : browserOrigin;
config.frontendDist = path.resolve(root, "../Photo_FE/dist");
const storageTestDirectory = await fs.mkdtemp(
  path.join(tmpdir(), "nxc-browser-uploads-"),
);
config.uploadDir = storageTestDirectory;
await fs.access(path.join(config.frontendDist, "index.html")).catch(() => {
  throw new Error("Chưa có bản build: chạy `npm run build` trong Photo_FE.");
});
const { app } = await import("../src/app.js");
config.origin = browserOrigin;
await Room.create({ name: "Phòng 01", branch: "Tiệm", active: true });
await Package.create({
  name: "Chụp nhanh",
  price: 70000,
  duration: 10,
  prints: 1,
  active: true,
});
// Khung 10 × 15 dọc, hai ô để thử thiếu ảnh yêu thích trước khi tự động ghép.
const frame = await sharp({
  create: { width: 600, height: 900, channels: 3, background: "#f6c9d6" },
})
  .composite([
    {
      input: {
        create: { width: 480, height: 540, channels: 3, background: "#fff" },
      },
      left: 60,
      top: 90,
    },
  ])
  .png()
  .toBuffer();
await Frame.create({
  name: "Khung hồng",
  themeName: "Hồng",
  image: `data:image/png;base64,${frame.toString("base64")}`,
  slots: [
    { x: 0.1, y: 0.1, w: 0.8, h: 0.6 },
    { x: 0.1, y: 0.75, w: 0.8, h: 0.15 },
  ],
  active: true,
});
await Setting.create({
  key: "studio",
  value: {
    name: "NXC Photobooth",
    address: "Tiệm",
    phone: "0912345678",
    bank: "",
    bankAccount: "",
    bankOwner: "",
    bankQrImage:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJxkAAAAASUVORK5CYII=",
  },
});
const password = await bcrypt.hash("BrowserTest!123", 10);
await User.create([
  { name: "Quản trị", email: "admin@test.local", password, role: "admin" },
  { name: "Lễ tân", email: "counter@test.local", password, role: "staff" },
]);
const server = await new Promise((resolve) => {
  const s = app.listen(cloudflare ? 8083 : 8082, () => resolve(s));
});
let proxyServer;
let browser;
let originalStorageCommand;
const errors = [];
const watch = (page) => page.on("pageerror", (e) => errors.push(e.message));
const noOverflow = async (page) =>
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    `Tràn ngang tại ${page.url()}`,
  );
const signIn = async (page, email) => {
  await page.goto(config.origin + "/admin");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill("BrowserTest!123");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await page.locator(".admin-shell").waitFor();
  if (cloudflare) {
    await page.reload();
    await page.locator(".admin-shell").waitFor();
    assert.equal(await page.getByLabel("Email", { exact: true }).count(), 0,
      "Same-origin authentication cookie survives a Cloudflare page reload");
  }
};
try {
  if (cloudflare) {
    const { startCloudflareProxyServer } = await import(
      "../../Photo_FE/test/cloudflare-proxy-server.mjs"
    );
    proxyServer = await startCloudflareProxyServer({
      apiOrigin: "http://localhost:8083",
      frontendDist: config.frontendDist,
      port: 8082,
    });
    // A direct request from the new frontend origin is rejected by the unchanged
    // backend; the browser flow below can pass only through Worker translation.
    const rejected = await fetch("http://localhost:8083/api/auth/login", {
      method: "POST",
      headers: { Origin: browserOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.local", password: "BrowserTest!123" }),
    });
    assert.equal(rejected.status, 403, "Backend still rejects the unconfigured frontend origin");
  }
  browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    permissions: ["camera"],
  });

  // ── Web nội bộ: không có trang chủ / tra cứu công khai ──
  const page = await context.newPage();
  watch(page);
  await page.goto(config.origin + "/");
  await page.waitForURL("**/admin");
  await page.getByText("quét mã QR trên màn hình máy").waitFor();
  for (const route of ["/gallery", "/booking"]) {
    await page.goto(config.origin + route);
    await page
      .getByRole("heading", { name: "Không tìm thấy trang." })
      .waitFor();
    assert.equal(await page.locator("a").count(), 0, `${route}: không có link`);
  }
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["/admin", "/kiosk", "/khong-co"]) {
      await page.goto(config.origin + route);
      await page.locator("h1:visible, h2:visible").first().waitFor();
      await noOverflow(page);
    }
  }
  assert.equal(
    (await fetch(`${config.origin}/robots.txt`).then((r) => r.text())).trim(),
    "User-agent: *\nDisallow: /",
  );

  // ── Quản trị: cài máy chụp cho phòng ──
  const admin = await context.newPage();
  watch(admin);
  await admin.goto(config.origin + "/admin");
  await admin.getByLabel("Mật khẩu", { exact: true }).fill("x");
  await admin
    .getByRole("button", { name: "Hiện mật khẩu", exact: true })
    .click();
  assert.equal(
    await admin.getByLabel("Mật khẩu", { exact: true }).getAttribute("type"),
    "text",
  );
  await signIn(admin, "admin@test.local");
  await admin
    .getByRole("button", { name: "Phòng & chi nhánh", exact: true })
    .click();
  await admin.getByRole("button", { name: /^Cài máy chụp cho / }).click();
  const kioskUrl = await admin
    .getByRole("link", { name: "Mở máy chụp", exact: true })
    .getAttribute("href");
  await admin
    .getByRole("dialog", { name: "Cài máy chụp" })
    .getByRole("button", { name: "Đóng" })
    .click();

  // ── Lễ tân (điện thoại): tổng quan → tạo mã; mất phản hồi vẫn không trùng vé ──
  const counterContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const counter = await counterContext.newPage();
  watch(counter);
  await signIn(counter, "counter@test.local");
  await counter.getByText("1/1 phòng đang trống").waitFor();
  await counter.getByRole("button", { name: "Tạo mã chụp" }).click();
  await counter.locator("select[name=paymentMethod]").selectOption("transfer");
  await counter.getByAltText("Mã QR chuyển khoản").waitFor();
  assert.equal(
    await counter
      .getByRole("dialog")
      .locator('input[type="date"], input[type="time"]')
      .count(),
    0,
    "Không có ô chọn ngày giờ: mã dùng trong ngày",
  );
  await counter.getByText("Thông tin khách (không bắt buộc)").click();
  await counter.getByLabel("Tên khách", { exact: true }).fill("Khách thử");
  await counter.locator("input[name=received]").check();
  let loseTicketResponse = true;
  await counter.route("**/api/admin/tickets", async (route) => {
    const response = await route.fetch();
    if (loseTicketResponse) {
      loseTicketResponse = false;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  const create = counter.getByRole("button", {
    name: "Xác nhận thanh toán & tạo mã",
  });
  await create.click();
  await counter
    .getByRole("alert")
    .filter({ hasText: /kết nối được máy chủ/ })
    .first()
    .waitFor();
  await create.click();
  await counter.getByRole("heading", { name: "Mã chụp đã sẵn sàng" }).waitFor();
  await noOverflow(counter);
  const booking = await Booking.findOne({ name: "Khách thử" }).select(
    "+accessToken",
  );
  assert.equal(await Booking.countDocuments({ name: "Khách thử" }), 1);
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.paid, true);
  assert.equal(
    await counter.getByLabel("Mã chụp của khách").innerText(),
    booking.code,
  );
  assert.equal(
    await counter.getByRole("dialog").locator("svg[role=img], canvas").count(),
    0,
    "Phiếu ở quầy không có QR album: khách quét QR ở máy chụp",
  );
  await counter.getByRole("button", { name: "Xong", exact: true }).click();

  // ── Máy chụp trong phòng: khách chỉ chụp bằng máy ảnh, ảnh về thư mục X Acquire ──
  const kiosk = await context.newPage();
  watch(kiosk);
  // Hộp chọn thư mục giả lập: thư mục X Acquire nằm trong bộ nhớ riêng của trình duyệt (OPFS).
  await kiosk.addInitScript(() => {
    window.showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("X Acquire", {
        create: true,
      });
  });
  // Máy ảnh chụp: X Acquire ghi một tệp JPEG mới vào thư mục.
  const shoot = async (name) => {
    const bytes = [
      ...(await sharp({
        create: { width: 1500, height: 1000, channels: 3, background: "#7a9" },
      })
        .jpeg()
        .toBuffer()),
    ];
    await kiosk.evaluate(
      async ([name, bytes]) => {
        const dir = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("X Acquire", { create: true });
        const w = await (
          await dir.getFileHandle(name, { create: true })
        ).createWritable();
        await w.write(new Uint8Array(bytes));
        await w.close();
      },
      [name, bytes],
    );
  };
  await kiosk.goto(kioskUrl);
  assert.equal(
    await kiosk.getByRole("button", { name: "Chụp ảnh" }).count(),
    0,
    "Không có nút chụp trên màn hình: chỉ chụp bằng máy ảnh",
  );
  await kiosk.getByText("Cài đặt máy chụp (nhân viên)").click();
  await kiosk.getByRole("button", { name: /Chọn thư mục ảnh/ }).click();
  await kiosk
    .getByText(/Đã chọn thư mục ảnh “X Acquire”/)
    .first()
    .waitFor();
  await kiosk
    .getByRole("textbox", { name: "Mã vé", exact: true })
    .fill(booking.code);
  await kiosk.getByRole("button", { name: "Bắt đầu chụp" }).click();
  await kiosk.getByRole("timer", { name: "Thời gian còn lại" }).waitFor();
  await kiosk.locator(".self-viewfinder").waitFor();
  assert.equal(
    await kiosk.getByText("Bấm nút chụp trên máy ảnh / remote").count(),
    0,
    "Đã bỏ hướng dẫn đè lên hình camera",
  );
  assert.equal(
    await kiosk.getByRole("button", { name: "Chụp ảnh" }).count(),
    0,
    "Màn chụp không có nút chụp",
  );
  await kiosk.waitForTimeout(1000);
  for (const [i, n] of ["#01", "#02"].entries()) {
    await shoot(`DSCF000${i + 1}.JPG`);
    await kiosk
      .locator(".booth-shot figcaption", { hasText: n })
      .waitFor({ timeout: 20000 });
  }
  await kiosk.getByRole("button", { name: "Hoàn thành chụp" }).click();
  await kiosk.getByRole("button", { name: "Kết thúc & nhận ảnh" }).click();
  await kiosk.getByRole("heading", { name: "Quét mã để nhận 2 ảnh" }).waitFor();
  assert.equal((await Booking.findById(booking._id)).status, "completed");

  // ── Khách quét QR: album trên điện thoại (không có link sang trang nào khác) ──
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const phone = await phoneContext.newPage();
  watch(phone);
  await phone.goto(`${config.origin}/album/${booking.accessToken}`);
  await phone.getByRole("heading", { name: "Thư viện ảnh" }).waitFor();
  assert.equal(await phone.locator(".site-header a").count(), 0);
  await noOverflow(phone);

  // Khách thêm nhiều ảnh đã chỉnh trên điện thoại bằng ô Thêm ảnh trong thư viện.
  const uploadInput = phone.getByLabel("Chọn ảnh từ điện thoại", {
    exact: true,
  });
  assert.equal(
    await uploadInput.getAttribute("accept"),
    "image/jpeg,image/png,image/webp",
  );
  assert.equal(await uploadInput.getAttribute("multiple"), "");
  const phonePhotos = [
    {
      name: "phone-edited.jpg",
      mimeType: "image/jpeg",
      buffer: await sharp({
        create: {
          width: 900,
          height: 1200,
          channels: 3,
          background: "#ec433a",
        },
      })
        .jpeg()
        .toBuffer(),
    },
    {
      name: "phone-edited.png",
      mimeType: "image/png",
      buffer: await sharp({
        create: {
          width: 1200,
          height: 900,
          channels: 3,
          background: "#36a6d6",
        },
      })
        .png()
        .toBuffer(),
    },
  ];
  const uploadResponses = [];
  const uploadKeys = [];
  const uploadRoute = `**/api/albums/${booking.accessToken}/photos`;
  await phone.route(uploadRoute, async (route) => {
    const request = route.request();
    // Hai ảnh gửi song song: JPEG còn làm ảnh xem trước nên có thể tới sau PNG. Nhận ra theo tên.
    const original = phonePhotos.find((p) => p.name === decodeURIComponent(request.headers()["x-photo-name"]));
    assert.equal(request.headers()["content-type"], original.mimeType);
    const previewLength = Number(request.headers()["x-photo-preview-length"] || 0);
    const body = request.postDataBuffer();
    assert.deepEqual(body.subarray(0, body.length - previewLength), original.buffer, "Ảnh điện thoại gửi nguyên byte, không base64");
    assert.equal(previewLength > 0, original.mimeType === "image/jpeg", "JPEG kèm ảnh xem trước điện thoại tự làm");
    uploadKeys.push(request.headers()["x-photo-key"]);
    const response = await route.fetch();
    uploadResponses.push({
      status: response.status(),
      album: await response.json(),
    });
    await route.fulfill({ response });
  });
  const chooseFiles = phone.waitForEvent("filechooser");
  await phone
    .getByRole("button", { name: "Thêm ảnh từ điện thoại", exact: true })
    .click();
  await (await chooseFiles).setFiles(phonePhotos);
  await phone
    .getByRole("button", { name: "Xem & chỉnh ảnh 04", exact: true })
    .waitFor();
  await phone
    .getByRole("button", { name: "Thêm ảnh từ điện thoại", exact: true })
    .waitFor({ state: "visible" });
  await phone.waitForFunction(
    () => !document.querySelector(".studio-upload-tile").disabled,
  );
  await phone.unroute(uploadRoute);
  assert.deepEqual(
    uploadResponses.map((r) => r.status),
    [201, 201],
  );
  assert.deepEqual(
    uploadResponses.map((r) => r.album.photos.length),
    [3, 4],
  );
  assert.equal(new Set(uploadKeys).size, 2, "Mỗi ảnh có khóa tải riêng");
  const uploadedAlbum = await Booking.findById(booking._id);
  assert.equal(
    uploadedAlbum.photos.length,
    4,
    "Hai ảnh chụp + hai ảnh điện thoại, không trùng",
  );
  assert.equal(new Set(uploadedAlbum.photos.map((p) => String(p._id))).size, 4);
  assert.deepEqual(
    uploadedAlbum.photos.map((p) => p.number),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    uploadedAlbum.photos.slice(2).map((p) => p.originalName).sort(),
    phonePhotos.map((p) => p.name).sort(),
  );
  const uploadedPhoto = uploadedAlbum.photos[2];
  await phone.reload();
  await phone
    .getByRole("button", { name: "Xem & chỉnh ảnh 04", exact: true })
    .waitFor();
  assert.equal(
    await phone.locator(".studio-grid figure").count(),
    4,
    "Ảnh tải lên còn sau khi tải lại trang",
  );
  await noOverflow(phone);
  if (process.env.UI_SCREENSHOTS) {
    await fs.mkdir(process.env.UI_SCREENSHOTS, { recursive: true });
    await phone.screenshot({
      path: path.join(process.env.UI_SCREENSHOTS, "album-upload-mobile.png"),
      fullPage: true,
    });
  }

  // Ảnh điện thoại dùng được trong trình sửa, ảnh yêu thích và khung gửi in.
  await phone
    .getByRole("button", { name: "Xem & chỉnh ảnh 03", exact: true })
    .click();
  const editor = phone.getByRole("dialog", {
    name: "Xem & chỉnh ảnh",
    exact: true,
  });
  await editor.getByRole("button", { name: "Đen trắng", exact: true }).click();
  await editor.getByRole("button", { name: "Xong", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await phone.reload();
  await phone
    .getByRole("button", { name: "Xem & chỉnh ảnh 03", exact: true })
    .waitFor();
  assert.equal(
    await phone
      .getByRole("button", { name: "Xem & chỉnh ảnh 03", exact: true })
      .locator("img")
      .evaluate((img) => img.style.filter),
    "grayscale(1)",
    "Chỉnh sửa ảnh điện thoại còn sau khi tải lại trang",
  );
  await phone.getByRole("button", { name: "Thả tim ảnh 03" }).click();
  await phone.getByRole("button", { name: "Bỏ tim ảnh 03" }).waitFor();
  assert.equal(
    (await Booking.findById(booking._id)).photos.id(uploadedPhoto._id).favorite,
    true,
  );
  await phone.getByRole("button", { name: /Chọn chủ đề/ }).click();
  await phone.getByRole("button", { name: /Hồng/ }).click();
  await phone
    .locator(".studio-actions")
    .getByRole("button", { name: /Ghép ảnh/ })
    .click();
  const shortage = phone.getByRole("dialog", {
    name: "Chưa đủ ảnh yêu thích",
    exact: true,
  });
  await shortage.getByText("Còn thiếu 1 ảnh yêu thích (1/2).", { exact: true }).waitFor();
  assert.equal(await phone.locator(".frame-canvas canvas").count(), 0,
    "Thiếu ảnh phải xác nhận trước, không tự ghép ngầm");
  await noOverflow(phone);
  await shortage.getByRole("button", { name: "Tự động ghép", exact: true }).click();
  await shortage.waitFor({ state: "hidden" });
  await phone.locator(".frame-canvas canvas").waitFor();
  await phone.waitForFunction(({ token, photo }) => {
    const state = JSON.parse(localStorage.getItem(`photo-flow-v5-${token}`) || "null");
    return Object.values(state?.layouts || {})[0]?.[0]?.photo === photo;
  }, { token: booking.accessToken, photo: String(uploadedPhoto._id) });
  const composedPhotos = await phone.evaluate((token) => {
    const state = JSON.parse(localStorage.getItem(`photo-flow-v5-${token}`));
    return Object.values(state.layouts)[0].map((slot) => slot.photo);
  }, booking.accessToken);
  assert.equal(
    composedPhotos[0],
    String(uploadedPhoto._id),
    "Tự động ghép ưu tiên ảnh yêu thích khách tải lên",
  );
  assert.equal(composedPhotos.length, 2, "Tự động ghép lấp đủ hai ô");
  assert.ok(composedPhotos.every(Boolean), "Không để ô trống khi khách đã xác nhận tự động ghép");
  assert.notEqual(composedPhotos[0], composedPhotos[1],
    "Thư viện còn ảnh thì bổ sung ảnh khác trước khi lặp ảnh yêu thích");
  assert.equal((await Booking.findById(booking._id)).photos.filter((photo) => photo.favorite).length, 1,
    "Tự động ghép bổ sung ô ảnh, không tự thả tim ảnh còn lại");
  await phone
    .locator(".studio-actions")
    .getByRole("button", { name: /Xem kết quả/ })
    .click();
  const send = phone.getByRole("button", { name: "Gửi in (1 khung → 1 tờ)" });
  await send.waitFor({ timeout: 30000 });
  await send.click();
  await phone
    .getByRole("region", { name: "Kết quả gửi in", exact: true })
    .waitFor();
  await phone
    .getByRole("heading", { name: "Ảnh đã được gửi tới quầy", exact: true })
    .waitFor();
  await phone
    .getByRole("button", { name: "Xem và tải ảnh", exact: true })
    .click();
  await phone.getByRole("button", { name: "Đã dùng hết tờ in" }).waitFor();
  const phonePrint = await PrintJob.findOne({ code: booking.code });
  const printImage = await fetch(
    `${config.origin}/api/albums/${booking.accessToken}/prints/${phonePrint._id}`,
  ).then((r) => r.arrayBuffer());
  const [red, green, blue] = await sharp(Buffer.from(printImage))
    .extract({ left: 590, top: 700, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.ok(
    Math.max(red, green, blue) - Math.min(red, green, blue) <= 2,
    "Bộ lọc đen trắng có trong file in",
  );
  assert.ok(
    red > 60 && red < 180,
    "Ô ảnh chứa ảnh điện thoại đã sửa, không phải nền trống",
  );

  // ── Lễ tân in 15 × 10 cm trên DNP DS-RX1 ──
  await admin.getByRole("button", { name: /Hàng chờ in/ }).click();
  const printPopup = admin.waitForEvent("popup");
  await admin
    .getByRole("button", { name: /In 15×10/ })
    .first()
    .click();
  const printPage = await printPopup;
  watch(printPage);
  await printPage.getByText("Ảnh đã sẵn sàng.", { exact: false }).waitFor();
  await printPage.emulateMedia({ media: "print" });
  assert.equal(await printPage.locator(".toolbar").isVisible(), false);
  const pdf = (
    await printPage.pdf({ preferCSSPageSize: true, printBackground: true })
  ).toString("latin1");
  const boxes = [
    ...pdf.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g),
  ];
  assert.equal(boxes.length, 1, "Bản in đúng 1 trang");
  assert.ok(
    Math.abs((Number(boxes[0][1]) / 72) * 25.4 - 152.4) < 0.5,
    "DNP DS-RX1 PR (4x6): rộng 6 inch (152,4 mm)",
  );
  assert.ok(
    Math.abs((Number(boxes[0][2]) / 72) * 25.4 - 101.6) < 0.5,
    "DNP DS-RX1 PR (4x6): cao 4 inch (101,6 mm)",
  );
  assert.equal(
    (await PrintJob.findOne({ code: booking.code })).status,
    "pending",
    "Mở hộp thoại in không tự đánh dấu đã in",
  );
  await printPage.close();
  await admin
    .locator(".print-card")
    .getByRole("button", { name: /Đã in/ })
    .click();
  await admin
    .getByText(/Đã đánh dấu in xong/)
    .first()
    .waitFor();
  assert.equal((await Booking.findById(booking._id)).printed, true);
  await phone
    .getByText(/Lễ tân đã in xong/)
    .first()
    .waitFor({ timeout: 15000 });

  // ── Trợ lí dung lượng: số liệu thật, giới hạn và chỉ dọn ảnh đã hết hạn ──
  await admin.getByText("Trợ lí Minh Dâm", { exact: true }).click();
  await admin
    .getByRole("heading", { name: "Trợ lí Minh Dâm", exact: true })
    .waitFor();
  await admin
    .getByText("Chưa đo được dung lượng toàn cluster", { exact: false })
    .first()
    .waitFor();
  const storageBefore = await admin.request.get(
    config.origin + "/api/admin/storage",
  );
  assert.equal(storageBefore.status(), 200);
  const stored = await storageBefore.json();
  assert.equal(
    stored.quota.limitMB,
    512,
    "Giới hạn studio được xác nhận là 512 MB",
  );
  assert.equal(
    stored.cluster.available,
    false,
    "MongoDB tạm không hỗ trợ atlasSize",
  );
  assert.equal(stored.quota.remainingBytes, null);
  assert.ok(stored.media.files >= 9 && stored.media.bytes > 0);
  assert.ok(
    stored.database.available &&
      stored.database.usedBytes >= stored.media.bytes,
  );
  // MongoDB tạm không có lệnh riêng của Atlas. Mô phỏng phản hồi của lệnh đó
  // bằng dbStats thật cộng dung lượng một database khác trong cluster.
  const storageDB = mongoose.connection.db;
  originalStorageCommand = storageDB.command;
  storageDB.command = async function (command, ...options) {
    if (!command.atlasSize)
      return originalStorageCommand.call(this, command, ...options);
    const stats = await originalStorageCommand.call(this, {
      dbStats: 1,
      scale: 1,
    });
    const dataSize = stats.dataSize + 2 * 1048576;
    return {
      ok: 1,
      atlasSize: dataSize + stats.indexSize,
      totals: { dataSize, indexSize: stats.indexSize, numDatabases: 2 },
    };
  };
  const [liveStorage] = await Promise.all([
    admin.waitForResponse(
      (response) =>
        response.url().endsWith("/api/admin/storage") &&
        response.request().method() === "GET",
    ),
    admin.getByRole("button", { name: "Làm mới", exact: true }).click(),
  ]);
  const live = await liveStorage.json();
  assert.equal(live.cluster.available, true);
  assert.equal(live.cluster.databaseCount, 2);
  assert.ok(live.cluster.usedBytes > live.database.usedBytes);
  assert.equal(live.quota.scope, "cluster");
  assert.equal(
    live.quota.remainingBytes,
    Math.max(0, 512 * 1048576 - live.cluster.usedBytes),
  );
  await admin
    .getByRole("progressbar", {
      name: "Phần trăm dung lượng đã dùng",
      exact: true,
    })
    .waitFor();
  for (const width of [390, 1366]) {
    await admin.setViewportSize({ width, height: 900 });
    await noOverflow(admin);
    if (process.env.UI_SCREENSHOTS) {
      await fs.mkdir(process.env.UI_SCREENSHOTS, { recursive: true });
      await admin.screenshot({
        path: path.join(process.env.UI_SCREENSHOTS, `storage-${width}.png`),
        fullPage: true,
      });
    }
  }

  // Giao diện không còn ô chỉnh giới hạn; API vẫn nhận mức giới hạn cho quản trị.
  const savedLimit = await admin.request.put(
    config.origin + "/api/admin/storage/limit",
    { data: { limitMB: 128 } },
  );
  assert.equal(savedLimit.status(), 200);
  const configured = await savedLimit.json();
  assert.equal(configured.quota.limitMB, 128);
  assert.equal(
    configured.quota.remainingBytes,
    Math.max(0, 128 * 1048576 - configured.cluster.usedBytes),
  );

  const expiredAt = new Date(Date.now() - MEDIA_TTL_MS - 60_000);
  const oldPhotoId = mongoose.Types.ObjectId.createFromTime(
    Math.floor(expiredAt.getTime() / 1000),
  );
  await saveMedia(
    "storage-expired-photo.jpg",
    Buffer.from("old-photo"),
    "image/jpeg",
  );
  await saveMedia(
    "storage-expired-photo.original",
    Buffer.from("old-original"),
    "application/octet-stream",
  );
  await saveMedia(
    "storage-expired-print.jpg",
    Buffer.from("old-print"),
    "image/jpeg",
  );
  await Booking.updateOne(
    { _id: booking._id },
    {
      $push: {
        photos: {
          _id: oldPhotoId,
          file: "storage-expired-photo.jpg",
          originalFile: "storage-expired-photo.original",
          kind: "original",
        },
      },
    },
  );
  await PrintJob.create({
    code: "111111",
    status: "printed",
    file: "storage-expired-print.jpg",
    sheets: [{ file: "storage-expired-print.jpg" }],
    createdAt: expiredAt,
  });
  await admin.getByRole("button", { name: "Làm mới", exact: true }).click();
  const cleanupButton = admin.getByRole("button", {
    name: "Dọn ảnh đã hết hạn",
    exact: true,
  });
  await cleanupButton.waitFor();
  await admin.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) =>
        button.textContent.includes("Dọn ảnh đã hết hạn") && !button.disabled,
    ),
  );
  admin.once("dialog", (dialog) => dialog.accept());
  const [cleanupResponse] = await Promise.all([
    admin.waitForResponse(
      (response) =>
        response.url().endsWith("/api/admin/storage/cleanup-expired") &&
        response.request().method() === "POST",
    ),
    cleanupButton.click(),
  ]);
  assert.equal(cleanupResponse.status(), 200);
  const result = await cleanupResponse.json();
  assert.ok(
    result.freedBytes >= 30,
    "Dọn đúng các tệp hết hạn và đo byte giảm thực tế",
  );
  assert.equal(result.summary.expired.files, 0);
  assert.equal(await readMedia("storage-expired-photo.jpg"), null);
  assert.equal(await readMedia("storage-expired-photo.original"), null);
  assert.equal(await readMedia("storage-expired-print.jpg"), null);
  assert.ok(await readMedia(phonePrint.file), "Giữ nguyên tờ in mới của khách");
  const keptAlbum = await Booking.findById(booking._id);
  assert.equal(keptAlbum.photos.length, 4, "Giữ nguyên bốn ảnh còn hạn");
  assert.ok(await PrintJob.findById(phonePrint._id));

  // ── Quản trị trên điện thoại: menu gọn, bảng vé dạng thẻ ──
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin
    .getByRole("button", { name: "Menu quản lý", exact: true })
    .click();
  await admin
    .getByRole("button", { name: "Mã chụp & khách tại quầy", exact: true })
    .click();
  await admin.locator(".booking-table tbody tr").first().waitFor();
  await noOverflow(admin);
  assert.equal(
    await admin
      .getByRole("button", { name: "Menu quản lý", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await admin
      .locator(".booking-table tbody tr")
      .first()
      .evaluate((row) => getComputedStyle(row).display),
    "grid",
  );
  if (process.env.UI_SCREENSHOTS) {
    await fs.mkdir(process.env.UI_SCREENSHOTS, { recursive: true });
    for (const [name, target] of [
      ["admin-mobile", admin],
      ["counter-mobile", counter],
      ["kiosk-qr", kiosk],
      ["album-mobile", phone],
    ])
      await target.screenshot({
        path: path.join(process.env.UI_SCREENSHOTS, `${name}.png`),
        fullPage: true,
      });
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: web nội bộ (/ → quản trị, không trang công khai) → lễ tân cấp mã (mất phản hồi không trùng vé) → máy chụp → khách quét QR ghép khung, gửi in theo số tờ của gói → in 15 × 10 cm (DNP DS-RX1, 6 × 4 inch) một trang → đánh dấu đã in → Trợ lí Minh Dâm đo dung lượng, lưu giới hạn, dọn đúng ảnh hết hạn; không lỗi trình duyệt, không tràn ngang.",
  );
} catch (error) {
  for (const context of browser?.contexts() || [])
    for (const page of context.pages())
      console.error(
        "Trạng thái trình duyệt:",
        page.url(),
        (
          await page
            .locator("main")
            .innerText()
            .catch(() => "")
        ).slice(0, 2500),
      );
  throw error;
} finally {
  if (originalStorageCommand)
    mongoose.connection.db.command = originalStorageCommand;
  await browser?.close();
  if (proxyServer) {
    proxyServer.closeAllConnections();
    await new Promise((resolve) => proxyServer.close(resolve));
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await memory.stop();
  await fs.rmdir(storageTestDirectory);
}
