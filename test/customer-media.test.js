import "./environment.js"; // never production R2, even run on its own
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { Booking, PrintJob, User } from "../src/models/index.js";
import { readMedia, saveMedia } from "../src/services/media.js";

let memory, adminCookie, staffCookie;
const asAdmin = (method, path) => request(app)[method](path).set("Cookie", adminCookie);
const asStaff = (method, path) => request(app)[method](path).set("Cookie", staffCookie);
const putFile = (name, size) => saveMedia(name, Buffer.alloc(size, 0x61), "image/jpeg");

before(async () => {
  config.secret = "customer-media-test-only-123456789-not-production";
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const users = await User.create([
    { name: "Admin", email: "media-admin@test.local", role: "admin" },
    { name: "Staff", email: "media-staff@test.local", role: "staff" },
  ]);
  [adminCookie, staffCookie] = users.map((user) => `session=${jwt.sign({ sub: String(user._id) }, config.secret)}`);
});
beforeEach(async () => {
  await Promise.all([
    Booking.deleteMany({}),
    PrintJob.deleteMany({}),
    mongoose.connection.db.collection("media.files").deleteMany({}),
    mongoose.connection.db.collection("media.chunks").deleteMany({}),
  ]);
});
after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});

const photo = (name, patch = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  kind: "original",
  file: `${name}.jpg`,
  thumbnailFile: `${name}.thumb.jpg`,
  previewFile: `${name}.preview.jpg`,
  ...patch,
});
async function customer(code, status = "completed") {
  const photos = [photo(`${code}-a`), photo(`${code}-b`, { deleted: true })];
  for (const p of photos) {
    await putFile(p.file, 1000);
    await putFile(p.thumbnailFile, 100);
    await putFile(p.previewFile, 200);
  }
  // Ảnh ghép khung của máy chụp (Photobooth): tính và xoá cùng ảnh của khách.
  await putFile(`${code}-composite.jpg`, 3000);
  return Booking.create({ code, name: `Khách ${code}`, phone: "0912345678", status, prints: 2, printSheets: 1,
    accessToken: `token-${code}`, photos, composite: { file: `${code}-composite.jpg`, frameName: "Hồng" } });
}

test("only an admin sees each customer's stored photos and sizes, and deletes one customer", async () => {
  const first = await customer("111111");
  const second = await customer("222222");
  await putFile("111111-sheet.png", 5000);
  await PrintJob.create({ booking: first._id, code: first.code, status: "pending",
    sheets: [{ file: "111111-sheet.png", width: 1200, height: 1800 }] });

  await asStaff("get", "/api/admin/storage/customers").expect(403);
  const list = (await asAdmin("get", "/api/admin/storage/customers").expect(200)).body;
  const row = list.find((r) => r.code === "111111");
  assert.equal(row.name, "Khách 111111");
  assert.equal(row.photos, 1, "hidden photos are not counted as photos");
  assert.equal(row.files, 8, "every size of every photo, the framed composite and the print sheet");
  assert.equal(row.bytes, 2 * 1300 + 3000 + 5000);
  assert.equal(row.pendingPrints, 1);
  assert.ok(list.some((r) => r.code === "222222"));

  await request(app).delete(`/api/admin/storage/customers/${first._id}`).expect(401);
  await asStaff("delete", `/api/admin/storage/customers/${first._id}`).expect(403);
  assert.ok(await readMedia("111111-a.jpg"), "nothing deleted by staff");

  const deleted = (await asAdmin("delete", `/api/admin/storage/customers/${first._id}`).expect(200)).body;
  assert.deepEqual([deleted.files, deleted.photos, deleted.printJobs], [8, 2, 1]);
  assert.ok(deleted.summary.media, "the new storage figures come back");
  for (const name of ["111111-a.jpg", "111111-a.thumb.jpg", "111111-b.preview.jpg", "111111-composite.jpg", "111111-sheet.png"])
    assert.equal(await readMedia(name), null, `${name} is gone`);
  const after = await Booking.findById(first._id).lean();
  assert.deepEqual(after.photos, []);
  assert.equal(after.composite, undefined);
  assert.equal(after.mediaDeleted, true);
  assert.equal(after.code, "111111", "the ticket and its sale stay");
  assert.equal(after.printSheets, 0, "the unprinted sheet goes back to the ticket");
  assert.equal(await PrintJob.countDocuments({ booking: first._id }), 0);
  // Another customer is untouched.
  assert.ok(await readMedia("222222-a.jpg"));
  assert.equal((await Booking.findById(second._id).lean()).photos.length, 2);
  const remaining = (await asAdmin("get", "/api/admin/storage/customers").expect(200)).body;
  assert.deepEqual(remaining.map((r) => r.code), ["222222"]);
  // The album now says its photos are gone.
  const album = (await request(app).get("/api/albums/token-111111").expect(200)).body;
  assert.equal(album.mediaDeleted, true);
  assert.deepEqual(album.photos, []);
});

test("a customer still shooting cannot be deleted; unknown tickets are reported", async () => {
  const shooting = await customer("333333", "checked_in");
  await asAdmin("delete", `/api/admin/storage/customers/${shooting._id}`).expect(409);
  assert.ok(await readMedia("333333-a.jpg"));
  await asAdmin("delete", `/api/admin/storage/customers/${new mongoose.Types.ObjectId()}`).expect(404);
  await asAdmin("delete", "/api/admin/storage/customers/not-an-id").expect(400);
});
