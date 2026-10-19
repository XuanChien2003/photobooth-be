import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { removeActivityLogs } from "../src/services/activity-log-cleanup.js";
import { migrateCollectionNames } from "../src/migrations/collection-names.js";

let memory;
let connection;
let db;

before(async () => {
  memory = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(memory.getUri()).asPromise();
  db = connection.db;
});

after(async () => {
  await connection?.close();
  await memory?.stop();
});

test("cleanup deletes current and legacy logs while preserving all other data and indexes", async () => {
  const preservedNames = [
    "bookings",
    "print_jobs",
    "users",
    "rooms",
    "packages",
    "frames",
    "settings",
    "media.files",
    "media.chunks",
    "audit_notes",
    "audits_archive",
  ];
  const snapshots = new Map();
  for (const name of preservedNames) {
    const collection = db.collection(name);
    await collection.insertOne({
      _id: "keep",
      value: name,
      photo: Buffer.from("original image bytes"),
    });
    await collection.createIndex({ value: 1 });
    snapshots.set(name, {
      documents: await collection.find({}).toArray(),
      indexes: await collection.indexes(),
    });
  }
  await db.collection("audits").insertMany([{ action: "a" }, { action: "b" }]);
  await db.collection("audits").createIndex({ action: 1 });
  await db.collection("hf_audits").insertOne({ action: "legacy" });

  assert.deepEqual(await removeActivityLogs(db), {
    removed: [
      { collection: "audits", documents: 2 },
      { collection: "hf_audits", documents: 1 },
    ],
    deletedDocuments: 3,
  });
  const remaining = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((collection) => collection.name)
    .sort();
  assert.deepEqual(remaining, [...preservedNames].sort());
  for (const [name, snapshot] of snapshots) {
    assert.deepEqual(
      await db.collection(name).find({}).toArray(),
      snapshot.documents,
    );
    assert.deepEqual(await db.collection(name).indexes(), snapshot.indexes);
  }
  assert.deepEqual(await removeActivityLogs(db), {
    removed: [],
    deletedDocuments: 0,
  });
  assert.deepEqual(
    (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((collection) => collection.name)
      .sort(),
    remaining,
  );
});

test("legacy collection migration cannot rename retired activity logs", async () => {
  await db.collection("hf_audits").insertOne({ _id: "legacy-log" });
  assert.deepEqual(await migrateCollectionNames(db), []);
  assert.equal(await db.collection("hf_audits").countDocuments(), 1);
  assert.equal(
    (await db.listCollections({ name: "audits" }).toArray()).length,
    0,
  );
  assert.equal((await removeActivityLogs(db)).deletedDocuments, 1);
});

test("standalone cleanup reports verified deletion without touching preserved data", async () => {
  await db.collection("audits").insertOne({ _id: "command-log" });
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(
        new URL("../scripts/remove-activity-logs.js", import.meta.url),
      ),
    ],
    {
      env: { ...process.env, MONGO_URI: memory.getUri() },
      timeout: 35000,
    },
  );
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    removed: [{ collection: "audits", documents: 1 }],
    deletedDocuments: 1,
    remainingLogCollections: [],
  });
  assert.equal(await db.collection("bookings").countDocuments(), 1);
  assert.equal(await db.collection("media.files").countDocuments(), 1);
  assert.equal(await db.collection("media.chunks").countDocuments(), 1);
});
