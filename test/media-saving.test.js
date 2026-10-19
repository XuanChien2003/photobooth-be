import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import sharp from "sharp";
import { MongoMemoryServer } from "mongodb-memory-server";
import { config } from "../src/config.js";
import Booking from "../src/models/Booking.js";
import { appendCapture, prepareImages, finishCapture } from "../src/services/capture.js";
import { whenPrintSourcesIdle } from "../src/services/print-source.js";
import {
  MEDIA_TTL_MS,
  deleteMedia,
  readMedia,
  saveMedia,
} from "../src/services/media.js";

let memory;
let mediaDirectory;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const makeBooking = () =>
  Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    status: "completed",
  });
const image = () =>
  sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: "#924658",
    },
  })
    .jpeg({ quality: 97 })
    .toBuffer();
// Print sources are made in the background after the photo is saved: count once they are done.
const fileCount = async () => {
  await whenPrintSourcesIdle();
  return mongoose.connection.db.collection("media.files").countDocuments();
};
const chunkCount = () =>
  mongoose.connection.db.collection("media.chunks").countDocuments();

before(async () => {
  mediaDirectory = await mkdtemp(path.join(tmpdir(), "nxc-media-saving-test-"));
  config.uploadDir = mediaDirectory;
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri(), { monitorCommands: true });
  await Booking.init();
});

beforeEach(async () => {
  await whenPrintSourcesIdle();
  await Promise.all([
    Booking.deleteMany({}),
    mongoose.connection.db.collection("media.files").deleteMany({}),
    mongoose.connection.db.collection("media.chunks").deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
  if (mediaDirectory)
    await rm(mediaDirectory, { recursive: true, force: true });
});

test("six uploads reuse the GridFS bucket and check files only once", async () => {
  const client = mongoose.connection.getClient();
  let checks = 0;
  const monitor = (event) => {
    if (event.commandName === "find" && event.command.find === "media.files")
      checks++;
  };
  client.on("commandStarted", monitor);
  try {
    for (let i = 0; i < 6; i++)
      await saveMedia(
        `reuse-${i}.jpg`,
        Buffer.from(`photo-${i}`),
        "image/jpeg",
      );
  } finally {
    client.off("commandStarted", monitor);
  }
  assert.equal(checks, 1);
  assert.equal(await fileCount(), 6);
  for (let i = 0; i < 6; i++)
    assert.deepEqual(
      await readMedia(`reuse-${i}.jpg`),
      Buffer.from(`photo-${i}`),
    );
});

test("capture keeps full JPEG pixels and EXIF orientation without storing a second copy", async () => {
  const width = 40;
  const height = 20;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      pixels.set(x < width / 2 ? [240, 20, 30] : [20, 40, 240], offset);
    }
  const original = await sharp(pixels, {
    raw: { width, height, channels: 3 },
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 97 })
    .toBuffer();
  const booking = await makeBooking();
  const saved = await appendCapture(booking._id, original, {
    imported: true,
    clientKey: "oriented-upload",
    originalName: "portrait.jpg",
  });
  assert.equal(saved.photos.length, 1);
  const photo = saved.photos[0];
  assert.equal(photo.number, 1);
  assert.equal(photo.originalName, "portrait.jpg");
  assert.equal(photo.originalFile, undefined);
  const jpeg = await readMedia(photo.file);
  const metadata = await sharp(jpeg).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, width);
  assert.equal(metadata.height, height);
  assert.equal(metadata.orientation, 6);
  const decoded = await sharp(jpeg).rotate().raw().toBuffer({ resolveWithObject: true });
  const sourceDecoded = await sharp(original).rotate().raw().toBuffer();
  assert.deepEqual(decoded.data, sourceDecoded, "stored JPEG decodes to the exact source pixels");
  const rgb = (x, y) => {
    const offset = (y * decoded.info.width + x) * decoded.info.channels;
    return [...decoded.data.subarray(offset, offset + 3)];
  };
  const top = rgb(10, 5);
  const bottom = rgb(10, 35);
  assert.ok(top[0] > 200 && top[2] < 60, "the red side becomes the top");
  assert.ok(
    bottom[2] > 200 && bottom[0] < 60,
    "the blue side becomes the bottom",
  );
  assert.equal(
    saved.mediaExpiresAt.getTime(),
    photo._id.getTimestamp().getTime() + MEDIA_TTL_MS,
  );
  const thumbnail = await sharp(await readMedia(photo.thumbnailFile)).metadata();
  assert.deepEqual(
    [thumbnail.width, thumbnail.height],
    [height, width],
    "the library thumbnail is upright too",
  );
  assert.equal(await fileCount(), 4, "one original plus library/editor previews and a print source");
});

test("a clean JPEG is stored byte for byte; metadata, PNG and broken uploads are handled", async () => {
  const booking = await makeBooking();
  const clean = await image();
  const first = await appendCapture(booking._id, clean, {
    imported: true,
    clientKey: "clean-jpeg",
  });
  assert.deepEqual(
    await readMedia(first.photos[0].file),
    clean,
    "no second compression for a JPEG that is already upright and metadata-free",
  );
  const thumbnail = await sharp(
    await readMedia(first.photos[0].thumbnailFile),
  ).metadata();
  assert.deepEqual([thumbnail.width, thumbnail.height], [64, 48]);
  // JPEG kèm EXIF (vị trí, máy ảnh…) bị bỏ metadata khi lưu.
  const tagged = await sharp(clean)
    .withExif({ IFD0: { Copyright: "private owner" } })
    .jpeg({ quality: 90 })
    .toBuffer();
  assert.ok((await sharp(tagged).metadata()).exif);
  const second = await appendCapture(booking._id, tagged, {
    imported: true,
    clientKey: "tagged-jpeg",
  });
  const stored = await sharp(await readMedia(second.photos[1].file)).metadata();
  assert.equal(stored.format, "jpeg");
  assert.equal(stored.exif, undefined);
  // PNG được đổi sang JPEG.
  const png = await sharp(clean).png().toBuffer();
  const third = await appendCapture(booking._id, png, {
    imported: true,
    clientKey: "png-upload",
  });
  assert.equal(
    (await sharp(await readMedia(third.photos[2].file)).metadata()).format,
    "jpeg",
  );
  assert.equal(third.photos[0].sourcePreserved, true);
  assert.equal(third.photos[2].sourcePreserved, false, "converted files must use the server original for consistent edits");
  assert.equal(await fileCount(), 12);
  // Tệp cụt / hỏng bị từ chối, không để lại tệp nào.
  for (const broken of [clean.subarray(0, clean.length >> 1), Buffer.from("not an image")])
    await assert.rejects(
      appendCapture(booking._id, broken, {
        imported: true,
        clientKey: "broken-" + broken.length,
      }),
      (error) => error.status === 400,
    );
  assert.equal(await fileCount(), 12);
  assert.equal((await Booking.findById(booking._id)).photos.length, 3);
});

test("prepareImages keeps clean JPEG bytes and converts other formats once", async () => {
  const clean = await image();
  const same = await prepareImages(clean);
  assert.equal(same.jpeg, clean);
  const wide = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: "#123456" },
  })
    .jpeg()
    .toBuffer();
  const prepared = await prepareImages(wide);
  const meta = await sharp(prepared.thumbnail).metadata();
  assert.deepEqual([meta.width, meta.height], [640, 320]);
  const cmyk = await sharp(clean).toColourspace("cmyk").jpeg().toBuffer();
  const converted = await prepareImages(cmyk);
  assert.notEqual(converted.jpeg, cmyk);
  assert.equal((await sharp(converted.jpeg).metadata()).space, "srgb");
});

test("concurrent retries remain idempotent and distinct captures remain numbered", async () => {
  const booking = await makeBooking();
  const buffer = await image();
  const options = { imported: true, clientKey: "retry-same-photo" };
  const retries = await Promise.all([
    appendCapture(booking._id, buffer, options),
    appendCapture(booking._id, buffer, options),
  ]);
  assert.equal(retries[0].photos[0].file, retries[1].photos[0].file);
  assert.equal(await fileCount(), 4);
  await Promise.all(
    ["distinct-photo-1", "distinct-photo-2"].map((clientKey) =>
      appendCapture(booking._id, buffer, { imported: true, clientKey }),
    ),
  );
  const saved = await Booking.findById(booking._id);
  assert.deepEqual(
    saved.photos.map((photo) => photo.number),
    [1, 2, 3],
  );
  assert.equal(new Set(saved.photos.map((photo) => photo.file)).size, 3);
  assert.equal(await fileCount(), 12);
});

test("original JPEG starts saving while its preview is still being prepared", async () => {
  const booking = await makeBooking();
  const buffer = await image();
  const encode = sharp.prototype.toBuffer;
  const open = mongoose.mongo.GridFSBucket.prototype.openUploadStream;
  const originalStarted = deferred(), releasePreview = deferred();
  let previewPending = false, operation;
  sharp.prototype.toBuffer = function (...args) {
    previewPending = true;
    return releasePreview.promise.then(() => encode.apply(this, args));
  };
  mongoose.mongo.GridFSBucket.prototype.openUploadStream = function (name, options) {
    if (!/\.(thumb|preview|print)\.jpg$/.test(name)) originalStarted.resolve(previewPending);
    return open.call(this, name, options);
  };
  let timer;
  try {
    operation = appendCapture(booking._id, buffer, { imported: true, clientKey: "pipelined-preview" });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("original waited for preview")), 5000); });
    assert.equal(await Promise.race([originalStarted.promise, timeout]), true);
    assert.equal((await Booking.findById(booking._id)).photos.length, 0, "only acknowledge after both writes");
    releasePreview.resolve();
    const saved = await operation;
    assert.deepEqual(await readMedia(saved.photos[0].file), buffer);
    assert.equal(await fileCount(), 4);
  } finally {
    clearTimeout(timer);
    releasePreview.resolve();
    await operation?.catch(() => {});
    sharp.prototype.toBuffer = encode;
    mongoose.mongo.GridFSBucket.prototype.openUploadStream = open;
  }
});

test("three booths overlap original writes, bound memory and finish only after every accepted photo", async () => {
  const bookings = await Promise.all(Array.from({ length: 3 }, async () => {
    const b = await makeBooking();
    return Booking.findByIdAndUpdate(b._id, {
      status: "checked_in", captureEndsAt: new Date(Date.now() + 60000),
    }, { new: true });
  }));
  const buffers = await Promise.all(Array.from({ length: 6 }, (_, i) => sharp({
    create: { width: 64 + i, height: 48, channels: 3, background: "#924658" },
  }).jpeg().toBuffer()));
  const open = mongoose.mongo.GridFSBucket.prototype.openUploadStream;
  const started = [], held = [], threeStarted = deferred();
  let active = 0, peak = 0, operations = [], finish, releaseLater = false;
  mongoose.mongo.GridFSBucket.prototype.openUploadStream = function (name, options) {
    const stream = open.call(this, name, options);
    if (/\.(thumb|preview|print)\.jpg$/.test(name)) return stream;
    const end = stream.end;
    stream.end = function (...args) {
      active++; peak = Math.max(peak, active);
      const index = buffers.findIndex(buffer => buffer.equals(args[0]));
      started.push(index);
      let released = false;
      const release = () => { if (!released) { released = true; active--; end.apply(stream, args); } };
      held[index] = release;
      if (releaseLater && index !== 0) release();
      if (started.length === 3) threeStarted.resolve();
      return stream;
    };
    return stream;
  };
  let timer;
  try {
    // Queue two shots per booth while the first writes remain paused.
    operations = bookings.flatMap((b, booth) => [1, 2].map(number =>
      appendCapture(b._id, buffers[booth * 2 + number - 1], { clientKey: `booth-${b._id}-${number}` })));
    finish = finishCapture(bookings[0]._id);
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error("storage did not overlap")), 5000); });
    await Promise.race([threeStarted.promise, timeout]);
    assert.equal(started.length, 3);
    assert.equal((await Booking.findById(bookings[0]._id)).status, "checked_in");
    // Let the second write finish first. Commits and numbering still follow the
    // incoming order, and finishCapture stays behind both accepted operations.
    releaseLater = true;
    held.forEach((release, index) => { if (index !== 0) release(); });
    for (let attempts = 0; started.length < 6 && attempts < 200; attempts++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(started.length, 6);
    assert.equal((await Booking.findById(bookings[0]._id)).photos.length, 0);
    held[0]();
    await Promise.all(operations);
    const ended = await finish;
    assert.equal(ended.status, "completed");
    assert.equal(peak, 3, "only three full-size saves can run across all booths");
    for (const [booth, b] of bookings.entries()) {
      const saved = await Booking.findById(b._id);
      assert.deepEqual(saved.photos.map(p => p.number), [1, 2]);
      assert.deepEqual(saved.photos.map(p => p.clientKey), [1, 2].map(n => `booth-${b._id}-${n}`));
      for (const [index, photo] of saved.photos.entries()) assert.deepEqual(await readMedia(photo.file), buffers[booth * 2 + index]);
    }
    assert.equal(await fileCount(), 24);
  } finally {
    clearTimeout(timer);
    // Restore end before releasing future jobs so assertion failures cannot hang.
    mongoose.mongo.GridFSBucket.prototype.openUploadStream = open;
    held.forEach(release => release());
    await Promise.allSettled([...operations, finish].filter(Boolean));
  }
});

test("a failed write waits for its slower sibling before cleanup and leaves no saved files", async () => {
  const booking = await makeBooking();
  const buffer = await image();
  const prototype = mongoose.mongo.GridFSBucket.prototype;
  const originalOpen = prototype.openUploadStream;
  const originalFind = prototype.find;
  const jpegStarted = deferred();
  const thumbnailFailed = deferred();
  const releaseJpeg = deferred();
  const failure = new Error("injected thumbnail write failure");
  const events = [];
  let settled = false;
  let operation;
  prototype.openUploadStream = function (name, options) {
    const stream = originalOpen.call(this, name, options);
    if (/\.(preview|print)\.jpg$/.test(name)) return stream;
    const end = stream.end;
    stream.end = function (...args) {
      if (name.endsWith(".thumb.jpg")) {
        events.push("thumbnail-started");
        queueMicrotask(() => stream.destroy(failure));
      } else {
        events.push("jpeg-started");
        jpegStarted.resolve();
        releaseJpeg.promise.then(() => end.apply(stream, args));
      }
      return stream;
    };
    stream.once("error", () => thumbnailFailed.resolve());
    stream.once("finish", () => events.push("jpeg-finished"));
    return stream;
  };
  prototype.find = function (filter, options) {
    if (filter?.filename) events.push("cleanup-query");
    return originalFind.call(this, filter, options);
  };
  try {
    operation = appendCapture(booking._id, buffer, {
      imported: true,
      clientKey: "failed-pair",
    });
    operation.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.all([jpegStarted.promise, thumbnailFailed.promise]);
    await nextTurn();
    assert.deepEqual(events, ["jpeg-started", "thumbnail-started"]);
    assert.equal(
      settled,
      false,
      "the pair is still waiting for the JPEG write",
    );
    assert.equal((await Booking.findById(booking._id)).photos.length, 0);
    releaseJpeg.resolve();
    await assert.rejects(operation, (error) => error === failure);
    assert.ok(
      events.indexOf("cleanup-query") > events.indexOf("jpeg-finished"),
    );
    assert.equal(await fileCount(), 0);
    assert.equal(await chunkCount(), 0);
    assert.equal((await Booking.findById(booking._id)).photos.length, 0);
    assert.equal((await Booking.findById(booking._id)).nextPhotoNumber, 0);
  } finally {
    releaseJpeg.resolve();
    await operation?.catch(() => {});
    prototype.openUploadStream = originalOpen;
    prototype.find = originalFind;
  }
  const retry = await appendCapture(booking._id, buffer, {
    imported: true,
    clientKey: "failed-pair",
  });
  assert.equal(retry.photos.length, 1);
  assert.equal(retry.photos[0].number, 1);
  assert.equal(await fileCount(), 4);
});

test("a reconnected database gets its own bucket and retains read/delete behavior", async () => {
  const previousDb = mongoose.connection.db;
  await mongoose.disconnect();
  await mongoose.connect(memory.getUri(), {
    dbName: "media_saving_reconnected",
    monitorCommands: true,
  });
  assert.notEqual(mongoose.connection.db, previousDb);
  const client = mongoose.connection.getClient();
  let checks = 0;
  const monitor = (event) => {
    if (event.commandName === "find" && event.command.find === "media.files")
      checks++;
  };
  client.on("commandStarted", monitor);
  try {
    await saveMedia(
      "reconnected.jpg",
      Buffer.from("new database"),
      "image/jpeg",
    );
  } finally {
    client.off("commandStarted", monitor);
  }
  assert.equal(checks, 1);
  assert.deepEqual(
    await readMedia("reconnected.jpg"),
    Buffer.from("new database"),
  );
  await deleteMedia(["reconnected.jpg"]);
  assert.equal(await readMedia("reconnected.jpg"), null);
  assert.equal(await fileCount(), 0);
  assert.equal(await chunkCount(), 0);
});
