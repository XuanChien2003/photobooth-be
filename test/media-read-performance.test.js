import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import sharp from "sharp";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { Booking, PrintJob, User } from "../src/models/index.js";
import { MEDIA_TTL_MS, saveMedia } from "../src/services/media.js";
import { FINISH_GRACE_MS } from "../src/services/capture.js";

let memory, booking, jpeg, thumb, photoId, job, cookie;
const byteSize = (value) => Buffer.byteLength(JSON.stringify(value));

// Inspect the actual documents MongoDB returns, rather than just the query
// text: large photo arrays must not cross the database connection per tile.
async function bookingReads(action) {
  const reads = [];
  const client = mongoose.connection.getClient();
  const ns = `${mongoose.connection.db.databaseName}.bookings`;
  const monitor = (event) => {
    if (event.reply?.cursor?.ns === ns)
      reads.push(...(event.reply.cursor.firstBatch || []));
  };
  client.on("commandSucceeded", monitor);
  try {
    await action();
    return reads;
  } finally {
    client.off("commandSucceeded", monitor);
  }
}

before(async () => {
  config.secret = "isolated-media-read-test-secret-only";
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri(), { monitorCommands: true });
  await Promise.all([Booking.init(), PrintJob.init(), User.init()]);
  const photos = Array.from({ length: 400 }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(),
    file: `original-${i}-${randomUUID()}.jpg`,
    thumbnailFile: `thumbnail-${i}-${randomUUID()}.jpg`,
    originalName: `Camera-photo-${i}-${"sample".repeat(20)}.jpg`,
    kind: "original",
    number: i + 1,
    clientKey: `camera-${randomUUID()}`,
  }));
  photoId = photos[217]._id;
  booking = await Booking.create({
    code: "345678",
    accessToken: randomUUID(),
    status: "completed",
    prints: 7,
    printSheets: 2,
    photos,
  });
  jpeg = await sharp({
    create: { width: 900, height: 600, channels: 3, background: "#924658" },
  }).jpeg({ quality: 97 }).toBuffer();
  thumb = await sharp(jpeg).resize(64).jpeg().toBuffer();
  await Promise.all([
    saveMedia(photos[217].file, jpeg, "image/jpeg"),
    saveMedia(photos[217].thumbnailFile, thumb, "image/jpeg"),
    saveMedia("performance-print-sheet.jpg", jpeg, "image/jpeg"),
  ]);
  job = await PrintJob.create({
    booking: booking._id,
    code: booking.code,
    name: "Test guest",
    roomName: "Test room",
    status: "pending",
    sheets: [{ file: "performance-print-sheet.jpg", width: 900, height: 600 }],
  });
  const user = await User.create({
    name: "Test receptionist",
    email: "media-read-test@example.test",
    role: "staff",
    active: true,
  });
  cookie = `session=${jwt.sign({ sub: String(user._id), version: 0 }, config.secret)}`;
});

after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});

test("opening a tile transfers one photo from a 400-photo album and keeps full/thumbnail bytes distinct", async () => {
  const base = `/api/albums/${booking.accessToken}/photos/${photoId}`;
  const full = await Booking.findById(booking._id).lean();
  const reads = await bookingReads(async () => {
    const small = await request(app).get(`${base}?size=thumbnail`).expect(200);
    assert.deepEqual(small.body, thumb);
    const original = await request(app).get(base).expect(200);
    assert.deepEqual(original.body, jpeg);
    assert.match(original.headers["cache-control"], /^private, max-age=/);
  });
  assert.equal(reads.length, 2);
  for (const read of reads) {
    assert.equal(read.photos.length, 1);
    assert.equal(String(read.photos[0]._id), String(photoId));
    assert.equal(read.accessToken, undefined);
    assert.ok(byteSize(read) < byteSize(full) / 100);
  }
});

test("single-photo reads retain token isolation, missing/deleted/expired rejection and overdue completion", async () => {
  const oldId = mongoose.Types.ObjectId.createFromTime(
    Math.floor((Date.now() - MEDIA_TTL_MS - 60000) / 1000),
  );
  const deletedId = new mongoose.Types.ObjectId();
  const overdue = await Booking.create({
    code: "456789",
    accessToken: randomUUID(),
    status: "checked_in",
    captureEndsAt: new Date(Date.now() - FINISH_GRACE_MS - 60000),
    photos: [
      { _id: photoId, file: booking.photos[217].file, kind: "original" },
      { _id: oldId, file: booking.photos[217].file, kind: "original" },
      { _id: deletedId, file: booking.photos[217].file, kind: "original", deleted: true },
    ],
  });
  const base = `/api/albums/${overdue.accessToken}/photos/`;
  const original = await request(app).get(base + photoId).expect(200);
  assert.deepEqual(original.body, jpeg);
  assert.equal((await Booking.findById(overdue._id)).status, "completed");
  for (const rejected of [oldId, deletedId, new mongoose.Types.ObjectId(), "bad-id"])
    await request(app).get(base + rejected).expect(404);
  await request(app).get(`/api/albums/missing-token/photos/${photoId}`).expect(404);
  const other = await Booking.create({ code: "567890", accessToken: randomUUID(), status: "completed" });
  await request(app).get(`/api/albums/${other.accessToken}/photos/${photoId}`).expect(404);
});

test("camera upload authorizes without fetching its 400 old photos twice and still rejects a replaced session", async () => {
  const sessionId = randomUUID();
  const active = await Booking.create({
    code: "678901",
    accessToken: randomUUID(),
    status: "checked_in",
    captureSession: sessionId,
    captureEndsAt: new Date(Date.now() + 60000),
    photos: booking.photos.toObject(),
  });
  const captureToken = jwt.sign({ type: "capture", booking: String(active._id), sessionId }, config.secret);
  const reads = await bookingReads(async () => {
    const saved = await request(app).post("/api/kiosk/photo")
      .set("Content-Type", "image/jpeg")
      .set("X-Capture-Token", captureToken)
      .set("X-Photo-Key", "camera-performance-photo")
      .send(jpeg).expect(200);
    assert.equal(saved.body.photos.length, 401);
    assert.equal(saved.body.photos.at(-1).clientKey, "camera-performance-photo");
  });
  // One read answers both authorization and the save's checks (the database is far away on the
  // free plans); the photo is then appended by a single atomic update.
  assert.equal(reads.length, 1);
  assert.equal(reads[0].captureSession, sessionId);
  assert.ok(!reads[0].photos?.length, "the 400 old photos are never transferred to check the save");
  await Booking.updateOne({ _id: active._id }, { captureSession: randomUUID() });
  await request(app).post("/api/kiosk/photo")
    .set("Content-Type", "image/jpeg")
    .set("X-Capture-Token", captureToken)
    .set("X-Photo-Key", "stale-session-photo")
    .send(jpeg).expect(409);
  assert.equal((await Booking.findById(active._id)).photos.length, 401);
});

test("print status and full sheet requests do not fetch the album photo array", async () => {
  const base = `/api/albums/${booking.accessToken}`;
  const reads = await bookingReads(async () => {
    const status = await request(app).get(`${base}/print`).expect(200);
    assert.equal(status.body._id, String(job._id));
    assert.equal(status.body.prints, 7);
    assert.equal(status.body.printSheets, 2);
    const sheet = await request(app).get(`${base}/prints/${job._id}?download=1`).expect(200);
    assert.deepEqual(sheet.body, jpeg);
    assert.match(sheet.headers["content-disposition"], /NXC-345678-in.jpg/);
  });
  assert.equal(reads.length, 2);
  assert.ok(reads.every((read) => read.photos === undefined));
});

test("phone upload authenticates without transferring the existing photo array twice", async () => {
  const completed = await Booking.create({
    code: "789012", accessToken: randomUUID(), status: "completed",
    photos: booking.photos.toObject(),
  });
  const reads = await bookingReads(async () => {
    const response = await request(app).post(`/api/albums/${completed.accessToken}/photos`)
      .set("Content-Type", "image/jpeg").set("X-Photo-Key", "phone-performance-photo")
      .send(jpeg).expect(201);
    assert.equal(response.body.photos.length, 401);
  });
  assert.equal(reads.length, 1, "one read for authorization and the save's checks");
  assert.ok(!reads[0].photos?.length, "only the retry key is looked up, never the old photos");
});

test("print queue populates just the album link token and still supports marking a job printed", async () => {
  await request(app).get("/api/admin/print-jobs").expect(401);
  const reads = await bookingReads(async () => {
    const queue = await request(app).get("/api/admin/print-jobs").set("Cookie", cookie).expect(200);
    assert.equal(queue.body.length, 1);
    assert.equal(queue.body[0].image, `/api/albums/${booking.accessToken}/prints/${job._id}`);
    const changed = await request(app).patch(`/api/admin/print-jobs/${job._id}`)
      .set("Cookie", cookie).send({ status: "printed" }).expect(200);
    assert.equal(changed.body.status, "printed");
    assert.equal(changed.body.image, queue.body[0].image);
  });
  assert.equal(reads.length, 2);
  assert.ok(reads.every((read) => read.photos === undefined && read.accessToken === booking.accessToken));
  assert.equal((await Booking.findById(booking._id)).printed, true);
});
