import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { migrateCollectionNames } from "../src/migrations/collection-names.js";

let memory, connection;
before(async () => {
  memory = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(memory.getUri()).asPromise();
});
after(async () => {
  await connection?.close();
  await memory?.stop();
});

test("migration preserves IDs, references and unique indexes and can run again", async () => {
  const db = connection.useDb("preservation").db;
  const roomId = new mongoose.Types.ObjectId();
  await db.collection("hf_rooms").insertOne({ _id: roomId, name: "Classic" });
  await db
    .collection("hf_bookings")
    .insertOne({ code: "123456", room: roomId });
  await db.collection("hf_bookings").createIndex({ code: 1 }, { unique: true });
  const results = await migrateCollectionNames(db);
  assert.equal(results.length, 2);
  assert.equal(
    (await db.collection("rooms").findOne())._id.toString(),
    roomId.toString(),
  );
  assert.equal(
    (await db.collection("bookings").findOne()).room.toString(),
    roomId.toString(),
  );
  await assert.rejects(
    db.collection("bookings").insertOne({ code: "123456" }),
    { code: 11000 },
  );
  assert.equal(
    (await db.listCollections({ name: /^hf_/ }).toArray()).length,
    0,
  );
  assert.deepEqual(await migrateCollectionNames(db), []);
});

test("migration aborts all changes when an existing target would conflict", async () => {
  const db = connection.useDb("collision").db;
  await db.collection("hf_users").insertOne({ name: "Legacy user" });
  await db.collection("hf_bookings").insertOne({ code: "111111" });
  await db.collection("bookings").insertOne({ code: "222222" });
  await assert.rejects(migrateCollectionNames(db), /bookings/);
  assert.equal(await db.collection("hf_users").countDocuments(), 1);
  assert.equal(
    (await db.listCollections({ name: "users" }).toArray()).length,
    0,
  );
  assert.equal((await db.collection("bookings").findOne()).code, "222222");
});
