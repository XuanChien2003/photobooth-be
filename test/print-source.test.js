import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import sharp from "sharp";
import { MongoMemoryServer } from "mongodb-memory-server";
import { config } from "../src/config.js";
import Booking from "../src/models/Booking.js";
import { appendCapture, prepareImageTasks } from "../src/services/capture.js";
import { readMedia } from "../src/services/media.js";
import { saveImageTask } from "../src/services/image-save-queue.js";
import { schedulePrintSource, whenPrintSourcesIdle } from "../src/services/print-source.js";

let memory;
const files = () => mongoose.connection.db.collection("media.files").countDocuments();
const names = async () => (await mongoose.connection.db.collection("media.files")
  .find({}, { projection: { filename: 1 } }).toArray()).map((f) => f.filename);
const booking = () => Booking.create({ code: randomUUID(), accessToken: randomUUID(), status: "completed" });
// A camera-like photo: texture and noise, so JPEG decoding and the comparison below are meaningful.
async function photo(width = 1500, height = 1000) {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x7fffffff - 0.5) * 30, base = 130 + 60 * Math.sin(x / 90) + 40 * Math.cos(y / 70);
    raw.set([base + noise, base * 0.9 + noise, base * 0.75 + noise], (y * width + x) * 3);
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

before(async () => {
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Booking.init();
});
beforeEach(async () => {
  await whenPrintSourcesIdle();
  await Promise.all(["media.files", "media.chunks"].map((c) => mongoose.connection.db.collection(c).deleteMany({})));
  await Booking.deleteMany({});
});
after(async () => { await whenPrintSourcesIdle(); await mongoose.disconnect(); await memory?.stop(); });

test("a photo is saved with its display sizes first; the print source follows and is announced on the photo", async () => {
  const b = await booking();
  const saved = await appendCapture(b._id, await photo(), { imported: true, clientKey: "print-after-save" });
  assert.equal(saved.photos[0].printFile, undefined, "the response does not wait for the 4:4:4 encode");
  assert.equal(await files(), 3, "original, thumbnail and preview exist as soon as it is saved");
  await whenPrintSourcesIdle();
  const stored = (await Booking.findById(b._id)).photos[0];
  assert.match(stored.printFile, /\.print\.jpg$/);
  const meta = await sharp(await readMedia(stored.printFile)).metadata();
  assert.deepEqual([meta.width, meta.height], [1500, 1000], "never enlarged beyond the source");
  assert.equal(meta.chromaSubsampling, "4:4:4");
  assert.equal(await files(), 4);
});

test("every derivative cut from the single decode matches decoding the source directly", async () => {
  const source = await photo(3200, 2133);
  const tasks = prepareImageTasks(source, false);
  const [thumbnail, preview, print] = await Promise.all([tasks.thumbnail, tasks.preview, tasks.encodePrint()]);
  const mean = async (edge, made) => {
    const direct = await sharp(source).rotate().resize({ width: edge, height: edge, fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const cut = await sharp(made).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Rounding through the 3000 px pixels may change the height by one pixel; compare the overlap.
    assert.equal(cut.info.width, direct.info.width);
    assert.ok(Math.abs(cut.info.height - direct.info.height) <= 1);
    const rows = Math.min(cut.info.height, direct.info.height), row = direct.info.width * 3;
    let total = 0;
    for (let i = 0; i < rows * row; i++) total += Math.abs(direct.data[i] - cut.data[i]);
    return total / (rows * row);
  };
  assert.ok(await mean(640, thumbnail) < 4, "thumbnail");
  assert.ok(await mean(1600, preview) < 4, "editor preview");
  assert.ok(await mean(3000, print) < 4, "print source");
  const flipped = prepareImageTasks(source, true);
  const mirrored = await sharp(await flipped.preview).raw().toBuffer({ resolveWithObject: true });
  const plain = await sharp(await tasks.preview).flop().raw().toBuffer({ resolveWithObject: true });
  let diff = 0;
  for (let i = 0; i < mirrored.data.length; i++) diff += Math.abs(mirrored.data[i] - plain.data[i]);
  assert.ok(diff / mirrored.data.length < 3, "mirroring happens before the display sizes are cut");
});

test("many photos at once all get a print source, the later ones decoding the stored original again", async () => {
  const b = await booking();
  const source = await photo(900, 600);
  const accepted = await Promise.all(Array.from({ length: 9 }, (_, i) =>
    appendCapture(b._id, source, { imported: true, clientKey: `burst-photo-${i}` })));
  assert.equal(accepted.length, 9);
  await whenPrintSourcesIdle();
  const stored = (await Booking.findById(b._id)).photos;
  assert.equal(stored.length, 9);
  assert.ok(stored.every((p) => /\.print\.jpg$/.test(p.printFile)), "retained and re-decoded jobs both finish");
  assert.equal(await files(), 9 * 4);
  const first = await sharp(await readMedia(stored[0].printFile)).metadata();
  const last = await sharp(await readMedia(stored[8].printFile)).metadata();
  assert.deepEqual([first.width, first.height], [last.width, last.height]);
});

test("a queued burst releases excess camera pixels before background printing resumes", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--expose-gc", "--import", new URL("./environment.js", import.meta.url).href,
    fileURLToPath(new URL("./print-source-memory.mjs", import.meta.url)),
  ], { timeout: 15000 });
  assert.match(stdout, /all print sources finish/);
});

test("background work waits while photos are being saved", async () => {
  const b = await booking();
  const saved = await appendCapture(b._id, await photo(600, 400), { imported: true, clientKey: "yield-to-saves" });
  await whenPrintSourcesIdle();
  await Booking.updateOne({ _id: b._id }, { $unset: { "photos.0.printFile": 1 } });
  let release;
  const holding = saveImageTask(() => new Promise((resolve) => { release = resolve; }));
  let started = false;
  schedulePrintSource({
    bookingId: b._id, photoId: saved.photos[0]._id, printFile: `waits-${randomUUID()}.print.jpg`,
    encode: null, reload: async () => { started = true; return photo(600, 400); },
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(started, false, "a save is in progress, so the print source waits");
  release();
  await holding;
  await whenPrintSourcesIdle();
  assert.equal(started, true);
  assert.match((await Booking.findById(b._id)).photos[0].printFile, /waits-/);
});

test("a photo removed meanwhile leaves no orphan file, and a failing job leaves the photo usable", async () => {
  const b = await booking();
  const saved = await appendCapture(b._id, await photo(600, 400), { imported: true, clientKey: "removed-meanwhile" });
  await whenPrintSourcesIdle();
  const before = await files();
  schedulePrintSource({
    bookingId: b._id, photoId: new mongoose.Types.ObjectId(), printFile: `orphan-${randomUUID()}.print.jpg`,
    encode: null, reload: async () => photo(600, 400),
  });
  await whenPrintSourcesIdle();
  assert.equal(await files(), before, "the file saved for a vanished photo is deleted again");
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    schedulePrintSource({
      bookingId: b._id, photoId: saved.photos[0]._id, printFile: `broken-${randomUUID()}.print.jpg`,
      encode: null, reload: async () => { throw new Error("storage hiccup"); },
    });
    await whenPrintSourcesIdle();
  } finally { console.error = original; }
  assert.match(errors.join("\n"), /storage hiccup/);
  assert.equal(await files(), before, "nothing left behind");
  assert.equal((await Booking.findById(b._id)).photos.length, 1, "the photo itself is untouched");
  assert.deepEqual((await names()).filter((n) => /orphan-|broken-/.test(n)), []);
});
