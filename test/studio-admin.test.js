import { randomUUID } from "node:crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import bcrypt from "bcryptjs";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { Booking, Frame, Package, Room, Screen, Setting, Shift, User } from "../src/models/index.js";
import { addDays, previousRange } from "../src/services/stats.js";
import { today } from "../src/routes/validation.js";

let memory, room, other, pack, admin, staff;
const password = "TestPassword!123";
const png = "data:image/png;base64,iVBORw0KGgo=";
const slot = [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }];
const login = async (email) => {
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email, password }).expect(200);
  return agent;
};

before(async () => {
  config.secret = "test-secret-only-not-used-in-production-123456789";
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  [room, other] = await Room.create([
    { name: "Máy 1", description: "", branch: "Bắc Giang", active: true },
    { name: "Máy 2", description: "", branch: "Hà Nội", active: true },
  ]);
  pack = await Package.create({ name: "Gói 1", price: 100000, duration: 10, shots: 10, prints: 1, active: true });
  const hash = await bcrypt.hash(password, 10);
  await User.create([
    { name: "Admin", email: "admin@test.local", password: hash, role: "admin" },
    { name: "Lễ tân", email: "staff@test.local", password: hash, role: "staff", branch: "Bắc Giang" },
  ]);
  admin = await login("admin@test.local");
  staff = await login("staff@test.local");
});
after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});

test("staff permissions default to the old receptionist rights and can be widened per account", async () => {
  const me = (await staff.get("/api/auth/me").expect(200)).body;
  assert.deepEqual(me.permissions, ["orders:export", "print:operate", "shift:operate", "rooms:setup"]);
  assert.equal((await admin.get("/api/auth/me").expect(200)).body.permissions.includes("revenue:view"), true);
  await staff.get("/api/admin/stats/chart").expect(403);
  const summary = (await staff.get("/api/admin/stats/summary").expect(200)).body;
  assert.equal(summary.revenue, undefined, "no money without revenue:view");
  assert.equal(typeof summary.orders, "number");

  const user = await User.findOne({ email: "staff@test.local" });
  await admin.put(`/api/admin/users/${user._id}`).send({
    name: user.name, email: user.email, role: "staff", branch: "Bắc Giang", active: true,
    permissions: ["revenue:view", "orders:cancel", "made:up"],
  }).expect(400);
  await admin.put(`/api/admin/users/${user._id}`).send({
    name: user.name, email: user.email, role: "staff", branch: "Bắc Giang", active: true,
    permissions: ["revenue:view", "orders:cancel"],
  }).expect(200);
  // Đổi quyền không bắt đăng nhập lại; lưu lại không gửi quyền thì giữ nguyên quyền cũ.
  await admin.put(`/api/admin/users/${user._id}`).send({
    name: "Lễ tân Hoa", email: user.email, role: "staff", branch: "Bắc Giang", active: true,
  }).expect(200);
  assert.deepEqual((await staff.get("/api/auth/me").expect(200)).body.permissions, ["revenue:view", "orders:cancel"]);
  await staff.get("/api/admin/stats/chart").expect(200);
  assert.equal(typeof (await staff.get("/api/admin/stats/summary").expect(200)).body.revenue, "number");
  // Không còn quyền in / ca trực / cài máy.
  await staff.post(`/api/admin/rooms/${room._id}/device`).expect(403);
  await staff.post("/api/admin/shifts/open").send({}).expect(403);
  const ticket = await Booking.create({ branch: "Bắc Giang", code: "424242", status: "confirmed", paid: true, total: 1000 });
  await staff.patch(`/api/admin/bookings/${ticket._id}`).send({ status: "cancelled" }).expect(200);
  await User.updateOne({ _id: user._id }, { $unset: { permissions: 1 } });
  await Booking.deleteMany({});
});

test("summary compares with the previous period, splits cash and transfer and ranks themes, packages and machines", async () => {
  const day = today();
  const prev = previousRange(day, day).from;
  await Booking.create([
    { branch: "Bắc Giang", roomName: "Máy 1", packageName: "Gói 1", frameName: "Kawaii", date: day, paid: true,
      paymentMethod: "cash", total: 130000, extraSales: [{ sheets: 1, amount: 30000, paymentMethod: "transfer", at: new Date() }] },
    { branch: "Bắc Giang", roomName: "Máy 1", packageName: "Gói 1", frameName: "Kawaii", date: day, paid: true, paymentMethod: "transfer", total: 100000 },
    { branch: "Hà Nội", roomName: "Máy 2", packageName: "Gói 2", frameName: "Basic", date: day, paid: true, paymentMethod: "cash", total: 50000 },
    { branch: "Bắc Giang", roomName: "Máy 1", packageName: "Gói 1", date: day, paid: false, total: 999000 },
    { branch: "Bắc Giang", roomName: "Máy 1", packageName: "Gói 1", date: prev, paid: true, paymentMethod: "cash", total: 140000 },
  ]);
  try {
    const all = (await admin.get(`/api/admin/stats/summary?from=${day}&to=${day}`).expect(200)).body;
    assert.equal(all.revenue, 280000);
    assert.equal(all.orders, 3);
    assert.equal(all.cash, 100000 + 50000);
    assert.equal(all.transfer, 100000 + 30000);
    assert.equal(all.previousRevenue, 140000);
    assert.equal(all.revenueGrowth, 100);
    assert.equal(all.ordersGrowth, 200);
    assert.deepEqual(all.themes.map((t) => [t.name, t.count]), [["Kawaii", 2], ["Basic", 1]]);
    assert.deepEqual(all.rooms[0], { name: "Máy 1", count: 2, revenue: 230000 });
    const branch = (await admin.get(`/api/admin/stats/summary?from=${day}&to=${day}&branch=Hà Nội`).expect(200)).body;
    assert.equal(branch.revenue, 50000);
    // Lễ tân luôn chỉ thấy chi nhánh của mình, kể cả khi hỏi chi nhánh khác.
    const desk = (await staff.get(`/api/admin/stats/summary?from=${day}&to=${day}&branch=Hà Nội`).expect(200)).body;
    assert.equal(desk.orders, 2);
    await admin.get(`/api/admin/stats/summary?from=${day}&to=${prev}`).expect(400);

    const chart = (await admin.get(`/api/admin/stats/chart?from=${addDays(day, -6)}&to=${day}`).expect(200)).body;
    assert.equal(chart.unit, "day");
    assert.equal(chart.points.length, 7);
    assert.deepEqual(chart.points.at(-1).current, { revenue: 280000, orders: 3 });
    assert.equal(chart.points.at(-1).key, day);
    const yearly = (await admin.get(`/api/admin/stats/chart?from=${addDays(day, -200)}&to=${day}`).expect(200)).body;
    assert.equal(yearly.unit, "month");
    assert.equal(yearly.points.at(-1).key, day.slice(0, 7));
    assert.ok(yearly.points.reduce((n, p) => n + p.current.revenue, 0) >= 280000);
  } finally {
    await Booking.deleteMany({});
  }
});

test("monthly reconciliation lists closed shifts with their difference and paid money per branch", async () => {
  const opened = new Date();
  await Booking.create([
    { branch: "Bắc Giang", paid: true, paidAt: opened, paymentMethod: "cash", total: 70000, status: "confirmed" },
    { branch: "Hà Nội", paid: true, paidAt: opened, paymentMethod: "transfer", total: 90000, status: "confirmed" },
  ]);
  await Shift.create([
    { branch: "Bắc Giang", open: false, openedAt: opened, closedAt: opened, openingCash: 500000, closingCash: 560000,
      summary: { tickets: 1, extraSheets: 0, cash: 70000, transfer: 0, total: 70000 } },
    { branch: "Hà Nội", open: false, openedAt: opened, closedAt: opened, openingCash: 0, closingCash: 0,
      summary: { tickets: 1, extraSheets: 0, cash: 0, transfer: 90000, total: 90000 } },
  ]);
  try {
    const month = today().slice(0, 7);
    const report = (await admin.get(`/api/admin/shifts/report?month=${month}`).expect(200)).body;
    assert.equal(report.totals.shifts, 2);
    assert.equal(report.totals.matched, 1);
    assert.equal(report.totals.difference, -10000);
    assert.equal(report.totals.total, 160000);
    assert.deepEqual(report.branches.map((b) => b.branch), ["Bắc Giang", "Hà Nội"]);
    await staff.get(`/api/admin/shifts/report?month=${month}`).expect(403);
    await admin.get("/api/admin/shifts/report?month=2026-13").expect(400);
  } finally {
    await Booking.deleteMany({});
    await Shift.deleteMany({});
  }
});

test("waiting screens: one general screen plus per-machine screens reach the catalog with cached images", async () => {
  await Setting.findOneAndUpdate({ key: "studio" },
    { $set: { "value.kiosk": { idleTitle: "Cũ", idleSubtitle: "", idleImage: png } } }, { upsert: true });
  await staff.get("/api/admin/screens").expect(403);
  const [general] = (await admin.get("/api/admin/screens").expect(200)).body;
  assert.equal(general.isDefault, true);
  assert.equal(general.title, "Cũ", "the old idle screen becomes the general screen");
  assert.equal(general.images.length, 1);
  await admin.delete(`/api/admin/screens/${general._id}`).expect(409);
  await admin.post("/api/admin/screens").send({ name: "Riêng", rooms: [], images: [] }).expect(400);
  let list = (await admin.post("/api/admin/screens").send({
    name: "Máy 1", rooms: [String(room._id)], title: "Xin chào", images: [{ data: png }, { data: png }], interval: 4,
  }).expect(200)).body;
  const own = list.find((s) => !s.isDefault);
  assert.equal(own.images.length, 2);
  // Giữ ảnh cũ theo _id, bỏ ảnh còn lại, đổi thứ tự cấu hình.
  list = (await admin.put(`/api/admin/screens/${own._id}`).send({
    name: "Máy 1", rooms: [String(room._id), String(other._id)], images: [{ _id: own.images[1]._id }],
  }).expect(200)).body;
  assert.equal(list.find((s) => s._id === own._id).images[0]._id, own.images[1]._id);
  // Một máy chỉ thuộc một cấu hình riêng.
  list = (await admin.post("/api/admin/screens").send({
    name: "Máy 2 riêng", rooms: [String(other._id)], images: [],
  }).expect(200)).body;
  assert.deepEqual(list.find((s) => s._id === own._id).rooms, [String(room._id)]);
  const catalog = (await request(app).get("/api/catalog").expect(200)).body;
  const screen = catalog.screens.find((s) => s._id === own._id);
  assert.match(screen.images[0].url, /^\/api\/screens\/[a-f0-9]{24}\/images\/[a-f0-9]{24}\?v=[a-f0-9]{12}$/);
  const image = await request(app).get(screen.images[0].url).expect(200);
  assert.equal(image.headers["content-type"], "image/png");
  await admin.delete(`/api/admin/screens/${own._id}`).expect(200);
  await Screen.deleteMany({});
});

test("themes group frames: rename, hide from customers, order and ungroup without deleting frames", async () => {
  const frame = (name, themeName, order) =>
    admin.post("/api/admin/frames").send({ name, themeName, order, image: png, slots: slot, active: true }).expect(200);
  await frame("A1", "Kawaii", 1);
  await frame("A2", "Kawaii", 2);
  await frame("B1", "Basic", 1);
  try {
    await staff.get("/api/admin/themes").expect(403);
    let themes = (await admin.get("/api/admin/themes").expect(200)).body;
    assert.deepEqual(themes.map((t) => [t.name, t.frames, t.slots]).sort(), [["Basic", 1, 1], ["Kawaii", 2, 2]]);
    themes = (await admin.post("/api/admin/themes").send({ name: "Limited" }).expect(201)).body;
    assert.equal(themes.find((t) => t.name === "Limited").frames, 0);
    await admin.post("/api/admin/themes").send({ name: "kawaii" }).expect(409);
    await admin.put("/api/admin/themes").send({ name: "Kawaii", newName: "Basic" }).expect(409);
    themes = (await admin.put("/api/admin/themes").send({ name: "Kawaii", newName: "Dễ thương" }).expect(200)).body;
    assert.equal(await Frame.countDocuments({ themeName: "Dễ thương" }), 2);
    themes = (await admin.put("/api/admin/themes").send({ name: "Basic", active: false }).expect(200)).body;
    const catalog = (await request(app).get("/api/catalog").expect(200)).body;
    assert.equal(catalog.frames.some((f) => f.themeName === "Basic"), false, "hidden theme frames leave the catalog");
    assert.equal(catalog.frames.filter((f) => f.themeName === "Dễ thương").length, 2);
    const names = ["Limited", "Basic", "Dễ thương"];
    await admin.put("/api/admin/themes/order").send({ names: ["Basic"] }).expect(409);
    themes = (await admin.put("/api/admin/themes/order").send({ names }).expect(200)).body;
    assert.deepEqual(themes.map((t) => t.name), names);
    themes = (await admin.delete(`/api/admin/themes/${encodeURIComponent("Dễ thương")}`).expect(200)).body;
    assert.deepEqual(themes.map((t) => t.name), ["Limited", "Basic"]);
    assert.equal(await Frame.countDocuments({ themeName: "" }), 2, "frames stay as single frames");
  } finally {
    await Frame.deleteMany({});
    await Setting.updateOne({ key: "studio" }, { $unset: { "value.themes": 1 } });
  }
});

test("custom filters are validated and published in the catalog settings", async () => {
  const filter = { id: "abc123", name: "Hồng dịu", brightness: 105, contrast: 95, saturate: 110, sepia: 10, hueRotate: -5 };
  await staff.put("/api/admin/settings/custom-filters").send({ customFilters: [filter] }).expect(403);
  await admin.put("/api/admin/settings/custom-filters").send({ customFilters: [{ ...filter, contrast: 500 }] }).expect(400);
  await admin.put("/api/admin/settings/custom-filters").send({ customFilters: [filter, filter] }).expect(400);
  await admin.put("/api/admin/settings/custom-filters").send({ customFilters: [filter] }).expect(200);
  const settings = (await request(app).get("/api/catalog").expect(200)).body.settings;
  assert.deepEqual(settings.customFilters, [{ ...filter, active: true }]);
});

test("kiosks report online with the remote flip mode; packages can be limited to branches", async () => {
  await admin.put(`/api/admin/rooms/${room._id}`).send({
    name: "Máy 1", description: "", branch: "Bắc Giang", flip: "off", active: true,
  }).expect(200);
  const { token } = (await staff.post(`/api/admin/rooms/${room._id}/device`).expect(200)).body;
  await request(app).post("/api/kiosk/ping").send({ device: "bad" }).expect(403);
  const ping = (await request(app).post("/api/kiosk/ping").send({ device: token }).expect(200)).body;
  assert.deepEqual(ping.room, { _id: String(room._id), name: "Máy 1", branch: "Bắc Giang", flip: "off" });
  const listed = (await admin.get("/api/admin/rooms").expect(200)).body.find((r) => r._id === String(room._id));
  assert.ok(Date.now() - new Date(listed.lastSeenAt) < 60000);
  assert.equal(listed.flip, "off");

  await admin.put(`/api/admin/packages/${pack._id}`).send({
    name: "Gói 1", description: "", price: 100000, duration: 10, prints: 1, branches: ["Hà Nội"], active: true,
  }).expect(200);
  const draft = { name: "Khách", phone: "", room: "", branch: "", package: String(pack._id), requestKey: randomUUID() };
  const refused = await staff.post("/api/admin/tickets/draft").send(draft).expect(400);
  assert.match(refused.body.message, /không áp dụng tại chi nhánh Bắc Giang/);
  await admin.put(`/api/admin/packages/${pack._id}`).send({
    name: "Gói 1", description: "", price: 100000, duration: 10, prints: 1, branches: [], active: true,
  }).expect(200);
  await staff.post("/api/admin/tickets/draft").send({ ...draft, requestKey: randomUUID() }).expect(201);
  await Booking.deleteMany({});
});
