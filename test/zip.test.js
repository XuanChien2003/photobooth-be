import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { crc32 } from "node:zlib";
import { sendZip } from "../src/services/zip.js";

// Phản hồi giả: hàng đợi nhỏ để buộc sendZip phải chờ "drain", ghi chậm từng đoạn.
function fakeResponse(highWaterMark = 8) {
  const chunks = [];
  const res = new Writable({
    highWaterMark,
    write(chunk, _encoding, done) {
      chunks.push(chunk);
      setImmediate(done);
    },
  });
  res.headers = {};
  res.set = (name, value) => ((res.headers[name] = value), res);
  res.attachment = (name) => ((res.filename = name), res);
  res.type = (value) => ((res.headers["Content-Type"] = value), res);
  res.body = () => Buffer.concat(chunks);
  return res;
}

// Đọc ZIP độc lập với bộ ghi: duyệt danh mục cuối, kiểm tra từng tệp theo local header + CRC.
function readZip(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  assert.equal(at + zip.readUInt32LE(end + 12), end);
  const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26);
    const data = zip.subarray(start, start + size);
    assert.equal(zip.readUInt32LE(at + 16), crc32(data), `CRC of ${name}`);
    assert.equal(zip.readUInt32LE(local + 14), crc32(data));
    files.push({ name, data });
    at += 46 + nameLength;
  }
  return files;
}

test("sendZip streams every file into a valid archive despite back-pressure", async () => {
  const inputs = [
    { name: "ảnh-01.jpg", data: Buffer.alloc(5000, 1) },
    { name: "b.jpg", data: Buffer.from("small") },
    { name: "empty.jpg", data: Buffer.alloc(0) },
    { name: "c.jpg", data: Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 251)) },
  ];
  async function* source() {
    for (const file of inputs) yield file;
  }
  const res = fakeResponse();
  assert.equal(await sendZip(res, "album.zip", source()), true);
  await new Promise((resolve) => res.once("finish", resolve));
  assert.equal(res.filename, "album.zip");
  assert.equal(res.headers["Content-Type"], "application/zip");
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  const files = readZip(res.body());
  assert.deepEqual(
    files.map((f) => f.name),
    inputs.map((f) => f.name),
  );
  files.forEach((file, i) => assert.deepEqual(file.data, inputs[i].data));
  // Cũng nhận mảng thường.
  const plain = fakeResponse(1 << 20);
  await sendZip(plain, "x.zip", inputs.slice(0, 2));
  await new Promise((resolve) => plain.once("finish", resolve));
  assert.equal(readZip(plain.body()).length, 2);
});

test("sendZip writes nothing and reports false when there is no file", async () => {
  const res = fakeResponse();
  assert.equal(await sendZip(res, "none.zip", []), false);
  assert.equal(res.filename, undefined);
  assert.equal(res.body().length, 0);
});

test("sendZip stops reading more files once the downloader disconnects", async () => {
  let produced = 0;
  let closed = false;
  async function* source() {
    try {
      for (let i = 0; i < 50; i++) {
        produced++;
        yield { name: `${i}.jpg`, data: Buffer.alloc(100_000, i) };
      }
    } finally {
      closed = true;
    }
  }
  const res = fakeResponse();
  const sending = sendZip(res, "gone.zip", source());
  setTimeout(() => res.destroy(), 5);
  assert.equal(await sending, true);
  assert.ok(produced < 50, `stopped early after ${produced} files`);
  assert.equal(closed, true, "the file source is released");
});

test("sendZip ends the connection when a file fails halfway", async () => {
  async function* source() {
    yield { name: "1.jpg", data: Buffer.from("one") };
    throw new Error("storage unavailable");
  }
  await assert.rejects(
    sendZip(fakeResponse(1 << 20), "broken.zip", source()),
    /storage unavailable/,
  );
});

test("the CRC-32 used for archives matches the standard check values", async () => {
  const { crc32: archiveCrc } = await import("../src/services/zip.js");
  assert.equal(archiveCrc(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(archiveCrc(Buffer.alloc(0)), 0);
  assert.equal(archiveCrc(Buffer.from("The quick brown fox jumps over the lazy dog")), 0x414fa339);
});

// Past 4 GB (about 270 camera originals) entries need 64-bit offsets. A low limit forces that
// layout with small files; the archive must read back entry by entry and open in unzip.
test("large albums get ZIP64 offsets and still open in a standard tool", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const inputs = [700, 900, 1200].map((n, i) =>
    ({ name: `NXC-123456-0${i + 1}.jpg`, data: Buffer.from(Array.from({ length: n }, (_, j) => (j * 7 + i) % 256)) }));
  const res = fakeResponse(1 << 20);
  assert.equal(await sendZip(res, "album.zip", inputs, new Date(2026, 9, 17), { zip64From: 1000 }), true);
  await new Promise((resolve) => res.once("finish", resolve));
  const zip = res.body();
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end - 20), 0x07064b50, "ZIP64 locator");
  const record = Number(zip.readBigUInt64LE(end - 20 + 8));
  assert.equal(zip.readUInt32LE(record), 0x06064b50, "ZIP64 end record");
  assert.equal(Number(zip.readBigUInt64LE(record + 32)), 3);
  let at = Number(zip.readBigUInt64LE(record + 48));
  const far = [];
  for (const input of inputs) {
    const nameLength = zip.readUInt16LE(at + 28), extraLength = zip.readUInt16LE(at + 30);
    let local = zip.readUInt32LE(at + 42);
    if (local === 0xffffffff) {
      assert.equal(zip.readUInt16LE(at + 46 + nameLength), 0x0001);
      local = Number(zip.readBigUInt64LE(at + 46 + nameLength + 4));
      far.push(input.name);
    }
    assert.equal(zip.toString("utf8", at + 46, at + 46 + nameLength), input.name);
    const start = local + 30 + zip.readUInt16LE(local + 26);
    assert.deepEqual(zip.subarray(start, start + input.data.length), input.data);
    at += 46 + nameLength + extraLength;
  }
  assert.deepEqual(far, ["NXC-123456-03.jpg"], "only offsets past the limit use 64 bits");
  const dir = mkdtempSync(join(tmpdir(), "nxc-zip-"));
  try {
    writeFileSync(join(dir, "album.zip"), zip);
    let report;
    try { report = execFileSync("unzip", ["-t", join(dir, "album.zip")], { encoding: "utf8" }); }
    catch (error) { if (error.code !== "ENOENT") throw error; } // no unzip installed: skip
    if (report) assert.match(report, /No errors detected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
