import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { app } from "../src/app.js";
import { Booking, Frame } from "../src/models/index.js";
import { MEDIA_TTL_MS } from "../src/services/media.js";

let memory;
before(async () => {
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all([Booking.init(), Frame.init()]);
});
beforeEach(async () => {
  await Promise.all([Booking.deleteMany({}), Frame.deleteMany({})]);
});
after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});

const slots = (count) =>
  Array.from({ length: count }, (_, i) => ({
    x: (i % 4) / 4,
    y: Math.floor(i / 4) / 4,
    w: 0.2,
    h: 0.2,
  }));
const frame = (count, patch = {}) =>
  Frame.create({
    name: "Khung thử",
    active: true,
    slots: slots(count),
    ...patch,
  });
const photo = (number, patch = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  file: `test-photo-${number}.jpg`,
  originalFile: `test-original-${number}.jpg`,
  originalName: `phone-${number}.jpg`,
  number,
  kind: "original",
  favorite: false,
  ...patch,
});
const album = (count = 16, patch = {}) =>
  Booking.create({
    code: "765432",
    accessToken: randomBytes(24).toString("hex"),
    status: "completed",
    photos: Array.from({ length: count }, (_, i) => photo(i + 1)),
    ...patch,
  });
const select = (booking, ids) =>
  request(app)
    .put(`/api/albums/${booking.accessToken}/favorites`)
    .send({ ids });
const ids = (booking, count = booking.photos.length) =>
  booking.photos.slice(0, count).map((item) => String(item._id));

for (const capacity of [12, 13, 14]) {
  test(`a ${capacity}-slot theme allows more favorites than its slots without trimming`, async () => {
    await frame(6, { themeName: " Nâu " });
    await frame(capacity - 6, { themeName: "Nâu" });
    const booking = await album();
    const selected = ids(booking, capacity);
    const response = await select(booking, selected).expect(200);
    assert.deepEqual(
      response.body.photos
        .filter((item) => item.favorite)
        .map((item) => item.id),
      selected,
    );
    const allSelected = ids(booking);
    const expanded = await select(booking, allSelected).expect(200);
    assert.deepEqual(
      expanded.body.photos.filter((item) => item.favorite).map((item) => item.id),
      allSelected,
    );
    const stored = await Booking.findById(booking._id);
    assert.equal(
      stored.photos.filter((item) => item.favorite).length,
      allSelected.length,
    );
  });
}

test("favorites do not depend on grouped, ungrouped, inactive or empty catalog frames", async () => {
  await frame(6, { themeName: "Nâu" });
  await frame(8, { themeName: "Nâu", active: false });
  await frame(8);
  await frame(8, { themeName: "  " });
  await frame(0, { themeName: "Nâu" });
  const booking = await album();
  const response = await select(booking, ids(booking)).expect(200);
  assert.equal(response.body.photos.filter((item) => item.favorite).length, 16);
});

test("without any catalog frames every alive original can be favorited, including more than ten", async () => {
  const booking = await album(14);
  await select(booking, ids(booking)).expect(200);
  assert.equal(
    (await Booking.findById(booking._id)).photos.filter((item) => item.favorite)
      .length,
    14,
  );
});

test("after catalog capacity shrinks favorites can be kept, replaced, expanded or reduced", async () => {
  const theme = await frame(14);
  const booking = await album();
  await select(booking, ids(booking, 14)).expect(200);
  await Frame.updateOne({ _id: theme._id }, { slots: slots(4) });
  await select(booking, ids(booking, 14)).expect(200);
  await select(booking, ids(booking, 13)).expect(200);
  const replacement = [...ids(booking, 12), String(booking.photos[14]._id)];
  await select(booking, replacement).expect(200);
  assert.deepEqual(
    (await Booking.findById(booking._id)).photos
      .filter((item) => item.favorite)
      .map((item) => String(item._id)),
    replacement,
  );
  await select(booking, ids(booking)).expect(200);
  await select(booking, ids(booking, 4)).expect(200);
});

test("invalid, duplicate, missing, deleted, derived and expired photo IDs cannot become favorites", async () => {
  await frame(14);
  const booking = await album(5);
  booking.photos[1].deleted = true;
  booking.photos[2].kind = "edited";
  booking.photos[3]._id = mongoose.Types.ObjectId.createFromTime(
    Math.floor((Date.now() - MEDIA_TTL_MS) / 1000) - 1,
  );
  await booking.save();
  const first = String(booking.photos[0]._id);
  await select(booking, [first.toUpperCase()]).expect(200);
  await select(booking, ["invalid"]).expect(400);
  await select(booking, [first, first.toUpperCase()]).expect(400);
  for (const invalid of [
    String(new mongoose.Types.ObjectId()),
    ...booking.photos.slice(1, 4).map((item) => String(item._id)),
  ]) {
    const response = await select(booking, [invalid]).expect(400);
    assert.match(
      response.body.message,
      /không còn trong album hoặc đã hết hạn/,
    );
  }
  assert.deepEqual(
    (await Booking.findById(booking._id)).photos
      .filter((item) => item.favorite)
      .map((item) => String(item._id)),
    [first],
  );
  await select(booking, []).expect(200);
});

test("album access and completion checks still apply to selecting favorites", async () => {
  const booking = await album(14, { status: "checked_in" });
  await select(booking, ids(booking, 12)).expect(409);
  await request(app)
    .put(`/api/albums/${randomBytes(24).toString("hex")}/favorites`)
    .send({ ids: [] })
    .expect(404);
});

test("concurrent requests replace the favorite set atomically without merging selections", async () => {
  await frame(2);
  const booking = await album(16);
  const left = ids(booking, 12);
  const right = ids(booking).slice(4);
  const responses = await Promise.all([
    select(booking, left),
    select(booking, right),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  const stored = (await Booking.findById(booking._id)).photos
    .filter((item) => item.favorite)
    .map((item) => String(item._id));
  assert.ok(
    JSON.stringify(stored) === JSON.stringify(left) ||
      JSON.stringify(stored) === JSON.stringify(right),
  );
});

test("a photo uploaded between album read and favorite update is preserved", async (t) => {
  await frame(12);
  const booking = await album(12);
  const added = photo(13);
  const originalUpdate = Booking.findOneAndUpdate;
  t.mock.method(Booking, "findOneAndUpdate", async function (...args) {
    await Booking.updateOne({ _id: booking._id }, { $push: { photos: added } });
    return originalUpdate.apply(this, args);
  });
  const response = await select(booking, ids(booking)).expect(200);
  assert.equal(response.body.photos.length, 13);
  const stored = await Booking.findById(booking._id);
  const latest = stored.photos.id(added._id);
  assert.equal(latest.originalFile, added.originalFile);
  assert.equal(latest.originalName, added.originalName);
  assert.equal(latest.favorite, false);
  assert.equal(stored.photos.filter((item) => item.favorite).length, 12);
});

test("a chosen photo deleted during the request rejects the entire update", async (t) => {
  await frame(12);
  const booking = await album(12);
  const originalUpdate = Booking.findOneAndUpdate;
  t.mock.method(Booking, "findOneAndUpdate", async function (...args) {
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { "photos.0.deleted": true } },
    );
    return originalUpdate.apply(this, args);
  });
  await select(booking, ids(booking)).expect(409);
  const stored = await Booking.findById(booking._id);
  assert.equal(stored.photos[0].deleted, true);
  assert.equal(stored.photos.filter((item) => item.favorite).length, 0);
});
