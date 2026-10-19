import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Booking } from "../src/models/index.js";
import { migrateCounterIndexes } from "../src/services/counter-indexes.js";

test("counter migration preserves existing tickets and code uniqueness, removes only time-slot uniqueness", async () => {
  const memory = await MongoMemoryServer.create();
  try {
    await mongoose.connect(memory.getUri());
    await Booking.init();
    await Booking.collection.createIndex(
      { room: 1, date: 1, time: 1 },
      { unique: true, partialFilterExpression: { active: true } },
    );
    const original = await Booking.create({
      code: "100001",
      accessToken: "old-album",
      room: new mongoose.Types.ObjectId(),
      date: "2026-09-25",
      time: "",
      total: 60000,
    });
    await migrateCounterIndexes();
    await migrateCounterIndexes();
    const another = await Booking.create({
      code: "100002",
      accessToken: "new-album",
      room: original.room,
      date: original.date,
      time: "",
    });
    assert.ok(another._id);
    assert.equal((await Booking.findById(original._id)).total, 60000);
    const indexes = await Booking.collection.indexes();
    assert.ok(!indexes.some((i) => i.name === "room_1_date_1_time_1"));
    assert.equal(indexes.find((i) => i.name === "code_1").unique, true);
    assert.equal(indexes.find((i) => i.name === "requestKey_1").unique, true);
  } finally {
    await mongoose.disconnect();
    await memory.stop();
  }
});
