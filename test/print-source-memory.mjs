// Runs in an isolated --expose-gc process. All database/storage calls stay in memory.
import assert from "node:assert/strict";
import sharp from "sharp";
import { config } from "../src/config.js";
import Booking from "../src/models/Booking.js";
import { appendCapture } from "../src/services/capture.js";
import { saveImageTask } from "../src/services/image-save-queue.js";
import { whenPrintSourcesIdle } from "../src/services/print-source.js";
import { r2Storage } from "../src/services/r2.js";

config.mediaStorageProvider = "r2";
config.r2 = {
  accountId: "0".repeat(32), accessKeyId: "fixture", secretAccessKey: "fixture",
  bucket: "memory-fixture", prefix: "media/",
};
const files = new Map();
r2Storage.save = async (file, bytes) => { files.set(file, Buffer.from(bytes)); };
r2Storage.read = async (file) => files.get(file);
r2Storage.deleteMany = async (names) => { names.forEach((name) => files.delete(name)); };
const photos = [];
Booking.findOneAndUpdate = async (_filter, pipeline) => {
  photos.push(pipeline[1].$set.photos.$concatArrays[1][0].$literal);
  return { photos: [...photos] };
};
Booking.updateOne = async () => ({ matchedCount: 1 });

// Observe the real decoded camera buffers without retaining them in the test.
const decoded = [];
const originalEncode = sharp.prototype.toBuffer;
sharp.prototype.toBuffer = async function (...args) {
  const result = await originalEncode.apply(this, args);
  if (args[0]?.resolveWithObject && result.info) decoded.push(new WeakRef(result.data));
  return result;
};

let release;
const hold = saveImageTask(() => new Promise((resolve) => { release = resolve; }));
try {
  const source = await sharp({
    create: { width: 900, height: 600, channels: 3, background: "#924658" },
  }).jpeg({ quality: 97 }).toBuffer();
  await Promise.all(Array.from({ length: 9 }, (_, i) => appendCapture("fixture-booking", source, {
    imported: true, clientKey: `burst-memory-${i}`,
    precheck: { status: "completed", photos: [] },
  })));
  assert.equal(decoded.length, 9, "each saved photo was actually decoded");
  assert.equal(files.size, 27, "print processing stays paused while a camera save is active");
  // GC can only collect a WeakRef target after returning to the event loop.
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
  }
  const alive = decoded.filter((ref) => ref.deref()).length;
  assert.ok(alive <= 4, `only four queued decodes may stay in memory; retained ${alive} of nine`);
} finally {
  sharp.prototype.toBuffer = originalEncode;
  release();
  await hold;
  await whenPrintSourcesIdle();
}
assert.equal(files.size, 36, "released pixels are reloaded and all nine print sources still finish");
console.log("nine queued photos release excess decoded buffers and all print sources finish");
