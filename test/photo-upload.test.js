import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import sharp from "sharp";
import jwt from "jsonwebtoken";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import Booking from "../src/models/Booking.js";
import { readMedia } from "../src/services/media.js";
import { whenPrintSourcesIdle } from "../src/services/print-source.js";

let memory;
let jpeg;
before(async () => {
  config.secret = "isolated-photo-upload-test-secret-1234567890";
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Booking.init();
  const width = 4032, height = 3024;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset] = (x % 16 < 8 ? 225 : 25);
    pixels[offset + 1] = y & 255;
    pixels[offset + 2] = x & 255;
  }
  jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .withIccProfile("srgb").jpeg({ quality: 97, chromaSubsampling: "4:4:4" }).toBuffer();
});
after(async () => { await mongoose.disconnect(); await memory?.stop(); });
const booking = (status = "completed") => Booking.create({
  code: randomUUID(), accessToken: randomUUID(), status,
  captureEndsAt: new Date(Date.now() + 60000),
});
const upload = (url, key, data = jpeg) => request(app).post(url)
  .set("Content-Type", "image/jpeg").set("X-Photo-Key", key).send(data);

test("readiness identifies binary upload support for a compatible frontend rollout", async () => {
  const response = await request(app).get("/api/health").expect(200);
  assert.equal(response.headers["x-photo-upload"], "binary-v1");
  assert.equal(response.headers["x-photo-quality"], "original-jpeg-lossless-print-v1");
  assert.equal(response.headers["x-photo-pipeline"], "original-preview-overlap-v1");
  // Dò lại máy chủ khi mất kết nối: luôn hỏi thật, không dùng bản lưu sẵn.
  assert.equal(response.headers["cache-control"], "no-store");
});

test("binary phone upload preserves JPEG bytes, orientation, name and thumbnail", async () => {
  const b = await booking();
  const response = await upload(`/api/albums/${b.accessToken}/photos`, "binary-phone-01")
    .set("X-Photo-Name", encodeURIComponent("Ảnh điện thoại.jpg")).expect(201);
  assert.equal(response.body.photos.length, 1);
  const saved = await Booking.findById(b._id);
  assert.equal(saved.photos[0].originalName, "Ảnh điện thoại.jpg");
  assert.deepEqual(await readMedia(saved.photos[0].file), jpeg);
  const downloaded = await request(app).get(`/api/albums/${b.accessToken}/photos/${saved.photos[0]._id}`).expect(200);
  assert.deepEqual(downloaded.body, jpeg, "full camera-size JPEG survives upload, storage and download byte for byte");
  const metadata = await sharp(downloaded.body).metadata();
  assert.deepEqual([metadata.width, metadata.height], [4032, 3024]);
  assert.deepEqual(metadata.icc, (await sharp(jpeg).metadata()).icc);
  const thumb = await sharp(await readMedia(saved.photos[0].thumbnailFile)).metadata();
  assert.equal(Math.max(thumb.width, thumb.height), 640);
  assert.equal(response.body.photos[0].mirrored, false);
  assert.equal(response.body.photos[0].sourcePreserved, true);
});

test("kiosk mirror choice changes the preview while preserving the camera JPEG", async () => {
  const b = await booking("checked_in");
  const raw = Buffer.from(Array.from({ length: 120 * 60 * 3 }, (_, i) =>
    Math.floor(i / 3) % 120 < 60 ? [235, 25, 35][i % 3] : [30, 50, 225][i % 3]));
  const source = await sharp(raw, { raw: { width: 120, height: 60, channels: 3 } })
    .jpeg({ quality: 96 }).toBuffer();
  const captureToken = jwt.sign({ type: "capture", booking: String(b._id) }, config.secret);
  const response = await upload("/api/kiosk/photo", "mirrored-camera-01", source)
    .set("X-Capture-Token", captureToken)
    .set("X-Photo-Mirrored", "1").expect(200);
  assert.equal(response.body.photos[0].mirrored, true);
  const saved = await Booking.findById(b._id);
  assert.deepEqual(await readMedia(saved.photos[0].file), source);
  const thumb = await sharp(await readMedia(saved.photos[0].thumbnailFile)).raw().toBuffer({ resolveWithObject: true });
  assert.ok(thumb.data[2] > thumb.data[0], "mirrored thumbnail shows the blue side on the left");
  assert.ok(thumb.data.at(-3) > thumb.data.at(-1), "mirrored thumbnail shows the red side on the right");
});

test("print source is a full-colour 3000 px copy that follows the mirror choice; old photos print from the original", async () => {
  const b = await booking("checked_in");
  const w = 6240, h = 4160;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) raw.set(i % w < w / 2 ? [235, 25, 35] : [30, 50, 225], i * 3);
  const camera = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 95 }).toBuffer();
  const captureToken = jwt.sign({ type: "capture", booking: String(b._id) }, config.secret);
  const response = await upload("/api/kiosk/photo", "print-source-01", camera)
    .set("X-Capture-Token", captureToken).set("X-Photo-Mirrored", "1").expect(200);
  const listed = response.body.photos[0];
  assert.equal(listed.printSource, false, "the photo is saved first; its print source follows");
  await whenPrintSourcesIdle();
  const saved = await Booking.findById(b._id).select("+accessToken");
  const photo = saved.photos[0];
  assert.match(photo.printFile, /\.print\.jpg$/);
  const served = await request(app)
    .get(`/api/albums/${saved.accessToken}/photos/${photo._id}?size=print`).expect(200);
  const meta = await sharp(served.body).metadata();
  assert.deepEqual([meta.width, meta.height], [3000, 2000], "enough pixels for any frame slot");
  assert.equal(meta.chromaSubsampling, "4:4:4", "colour kept at full resolution for printing");
  assert.ok(served.body.length < camera.length, "much lighter than the camera original");
  const px = await sharp(served.body).raw().toBuffer({ resolveWithObject: true });
  assert.ok(px.data[2] > px.data[0], "mirrored like the kiosk preview: blue side on the left");
  // The camera original stays byte for byte for downloads.
  assert.deepEqual(await readMedia(photo.file), camera);
  // Photos saved before print sources existed fall back to the original.
  await Booking.updateOne({ _id: b._id }, { $unset: { "photos.0.printFile": 1 } });
  const legacy = await request(app)
    .get(`/api/albums/${saved.accessToken}/photos/${photo._id}?size=print`).expect(200);
  assert.deepEqual(legacy.body, camera);
  const album = await request(app).get(`/api/albums/${saved.accessToken}`).expect(200);
  assert.equal(album.body.photos[0].printSource, false);
});

test("binary and old JSON retries share the same idempotency key", async () => {
  const b = await booking();
  const url = `/api/albums/${b.accessToken}/photos`;
  await upload(url, "same-upload-key").expect(201);
  await request(app).post(url).send({ image: `data:image/jpeg;base64,${jpeg.toString("base64")}`, clientKey: "same-upload-key" }).expect(201);
  assert.equal((await Booking.findById(b._id)).photos.length, 1);
});

test("binary kiosk upload requires a valid capture token and an active session", async () => {
  const b = await booking("checked_in");
  await upload("/api/kiosk/photo", "binary-kiosk-01").expect(400);
  await upload("/api/kiosk/photo", "binary-kiosk-01").set("X-Capture-Token", "invalid").expect(401);
  const captureToken = jwt.sign({ type: "capture", booking: String(b._id) }, config.secret);
  await upload("/api/kiosk/photo", "binary-kiosk-01").set("X-Capture-Token", captureToken).expect(200);
  assert.equal((await Booking.findById(b._id)).photos.length, 1);
  await Booking.updateOne({ _id: b._id }, { captureEndsAt: new Date(Date.now() - 1000) });
  await upload("/api/kiosk/photo", "binary-kiosk-02").set("X-Capture-Token", captureToken).expect(409);
});

test("malformed binary images and metadata never create stored photos", async () => {
  const b = await booking();
  const url = `/api/albums/${b.accessToken}/photos`;
  await upload(url, "broken-image-key", Buffer.from("not-a-jpeg")).expect(400);
  await upload(url, "valid-name-key").set("X-Photo-Name", "%invalid").expect(400);
  await upload(url, "short").expect(400);
  await upload(url, "empty-image-key", Buffer.alloc(0)).expect(400);
  await upload("/api/albums/unknown/photos", "unknown-album-key").expect(404);
  assert.equal((await Booking.findById(b._id)).photos.length, 0);
});

test("photo saves report how long they took (Server-Timing) so slow steps can be found", async () => {
  const b = await booking();
  const phone = await upload(`/api/albums/${b.accessToken}/photos`, "timing-phone-01").expect(201);
  assert.match(phone.headers["server-timing"], /^save;dur=\d+$/);
  const k = await booking("checked_in");
  const captureToken = jwt.sign({ type: "capture", booking: String(k._id) }, config.secret);
  const kiosk = await upload("/api/kiosk/photo", "timing-kiosk-01").set("X-Capture-Token", captureToken).expect(200);
  assert.match(kiosk.headers["server-timing"], /^save;dur=\d+$/);
  await whenPrintSourcesIdle();
});

// A booth decodes each camera photo anyway to show it: it sends that 1600 px preview after the
// camera bytes so the server does not decode the 26 MP original while the guest waits.
const solid = (width, height, background, quality = 92) =>
  sharp({ create: { width, height, channels: 3, background } }).jpeg({ quality }).toBuffer();
const boothUpload = (url, key, camera, preview) => request(app).post(url)
  .set("Content-Type", "image/jpeg").set("X-Photo-Key", key)
  .set("X-Photo-Preview-Length", String(preview.length))
  .send(Buffer.concat([camera, preview]));

test("a booth's own preview becomes the editor preview and the thumbnail; prints still come from the camera file", async () => {
  const b = await booking("checked_in");
  const captureToken = jwt.sign({ type: "capture", booking: String(b._id) }, config.secret);
  const camera = await solid(3600, 2400, "#1030d0", 95);
  const preview = await solid(1600, 1067, "#d01020");
  const response = await boothUpload("/api/kiosk/photo", "booth-preview-01", camera, preview)
    .set("X-Capture-Token", captureToken).expect(200);
  assert.equal(response.body.photos.length, 1);
  const saved = (await Booking.findById(b._id)).photos[0];
  assert.deepEqual(await readMedia(saved.file), camera, "the camera file is stored byte for byte, without the preview");
  assert.deepEqual(await readMedia(saved.previewFile), preview, "the booth preview is used as is");
  const thumb = await sharp(await readMedia(saved.thumbnailFile)).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([thumb.info.width, thumb.info.height], [640, 427]);
  assert.ok(thumb.data[0] > 150 && thumb.data[2] < 90, "the thumbnail is made from the booth preview");
  await whenPrintSourcesIdle();
  const print = await sharp(await readMedia((await Booking.findById(b._id)).photos[0].printFile))
    .raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([print.info.width, print.info.height], [3000, 2000]);
  assert.ok(print.data[2] > 150 && print.data[0] < 90, "the print source comes from the camera file, not the preview");
});

test("a preview that is not the same picture is ignored, and malformed preview lengths are refused", async () => {
  const b = await booking();
  const camera = await solid(3600, 2400, "#1030d0", 95);
  const square = await solid(1600, 1600, "#d01020");
  await boothUpload(`/api/albums/${b.accessToken}/photos`, "wrong-shape-01", camera, square).expect(201);
  const saved = (await Booking.findById(b._id)).photos[0];
  assert.deepEqual(await readMedia(saved.file), camera);
  const made = await sharp(await readMedia(saved.previewFile)).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([made.info.width, made.info.height], [1600, 1067], "the server made its own preview");
  assert.ok(made.data[2] > 150, "from the camera file");
  const notJpeg = Buffer.from("definitely not an image");
  await boothUpload(`/api/albums/${b.accessToken}/photos`, "not-jpeg-01", camera, notJpeg).expect(201);
  for (const length of ["0", "-5", "abc", "1.5", String(camera.length + 10), String(7 * 1024 * 1024)])
    await request(app).post(`/api/albums/${b.accessToken}/photos`)
      .set("Content-Type", "image/jpeg").set("X-Photo-Key", "bad-length-" + length)
      .set("X-Photo-Preview-Length", length).send(camera).expect(400);
  await whenPrintSourcesIdle();
});
