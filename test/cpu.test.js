import { test } from "node:test";
import assert from "node:assert/strict";
import { cpuLimit, imageThreads } from "../src/services/cpu.js";

const files = (map) => (file) => {
  if (!(file in map)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return map[file];
};

test("image threads follow the CPU Render grants, not the physical machine's cores", () => {
  // Gói Starter: 0,5 CPU (cgroup v2) → 1 luồng.
  assert.equal(cpuLimit(files({ "/sys/fs/cgroup/cpu.max": "50000 100000\n" })), 0.5);
  assert.equal(imageThreads(0.5), 1);
  // Gói 2 CPU (cgroup v1) → 2 luồng; không giới hạn → theo số lõi, tối đa 4.
  assert.equal(cpuLimit(files({
    "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
  })), 2);
  assert.equal(imageThreads(2), 2);
  assert.ok(cpuLimit(files({ "/sys/fs/cgroup/cpu.max": "max 100000" })) >= 1);
  assert.equal(imageThreads(16), 4);
  assert.equal(imageThreads(0.1), 1);
});
