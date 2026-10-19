import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { R2_REF, r2Storage, validateR2Config } from "../src/services/r2.js";

// No MongoDB connection or existing files modified. Verify read/write/list/delete
// permissions with one tiny, uniquely named probe, even before enabling R2.
let file;
let client;
let failure;
try {
  validateR2Config();
  client = r2Storage.client();
  file = `${R2_REF}${config.r2.prefix.replace(/\/?$/, "/")}check-${randomUUID()}.txt`;
  const bytes = Buffer.from("NXC R2 connection check");
  await r2Storage.save(file, bytes, "text/plain");
  assert.equal((await r2Storage.head(file)).ContentLength, bytes.length);
  assert.deepEqual(await r2Storage.read(file), bytes);
  assert.ok((await r2Storage.list()).some((entry) => entry.filename === file));
  await r2Storage.deleteMany([file]);
  assert.equal(await r2Storage.head(file), null);
} catch (error) {
  failure = error;
} finally {
  if (file) {
    try {
      await r2Storage.delete(file);
      assert.equal(await r2Storage.head(file), null);
    } catch (error) {
      failure ||= error;
    }
  }
  if (failure) {
    console.error(
      `Kiểm tra R2 thất bại (${failure.name}). Kiểm tra biến môi trường, bucket và quyền Object Read & Write. Không thay đổi dữ liệu MongoDB.`,
    );
    process.exitCode = 1;
  } else
    console.log(
      `R2 OK: ${config.r2.bucket}; đã xác minh ghi, đọc, liệt kê và xóa tệp kiểm tra.`,
    );
  client?.destroy();
}
