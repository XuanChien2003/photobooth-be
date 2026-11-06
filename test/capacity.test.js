import { test } from "node:test";
import assert from "node:assert/strict";
import { cpuLimit, imageThreads, memoryLimit, serverBudget, shedLargeBodies } from "../src/services/capacity.js";

const files = (map) => (file) => {
  if (!(file in map)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return map[file];
};
const MB = 1024 * 1024;

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

test("the RAM limit comes from the cgroup, never above the machine's own memory", () => {
  const machine = 64 * 1024 * MB;
  // Standard: 2 GB (cgroup v2).
  assert.equal(memoryLimit(files({ "/sys/fs/cgroup/memory.max": `${2048 * MB}\n` }), machine), 2048 * MB);
  // Không giới hạn: "max" (v2) hoặc một số khổng lồ (v1) → RAM của máy.
  assert.equal(memoryLimit(files({ "/sys/fs/cgroup/memory.max": "max\n" }), machine), machine);
  assert.equal(memoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" }), machine), machine);
  assert.equal(memoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${512 * MB}` }), machine), 512 * MB);
  assert.equal(memoryLimit(files({}), machine), machine);
});

test("photo work at once follows the plan: Starter one photo, Standard three", () => {
  const starter = serverBudget({ cpus: 0.5, memory: 512 * MB });
  assert.deepEqual([starter.threads, starter.saves, starter.retainedPrints, starter.sharpCacheMB], [1, 1, 0, 16]);
  const standard = serverBudget({ cpus: 1, memory: 2048 * MB });
  assert.deepEqual([standard.threads, standard.saves, standard.retainedPrints, standard.sharpCacheMB], [1, 3, 4, 64]);
  const pro = serverBudget({ cpus: 2, memory: 4096 * MB });
  assert.deepEqual([pro.threads, pro.saves], [2, 3]);
});

test("near the RAM limit a large upload is turned away with Retry-After instead of crashing the server", () => {
  const run = (use, length) => {
    const sent = { status: 200, headers: {}, body: null, next: false };
    const req = { get: (name) => (name.toLowerCase() === "content-length" ? String(length) : undefined) };
    const res = {
      set: (name, value) => { sent.headers[name] = value; return res; },
      status: (code) => { sent.status = code; return res; },
      json: (body) => { sent.body = body; return res; },
    };
    shedLargeBodies({ use: () => use })(req, res, () => { sent.next = true; });
    return sent;
  };
  const full = run(0.9, 15 * MB);
  assert.equal(full.status, 503);
  assert.equal(full.headers["Retry-After"], "15");
  assert.match(full.body.message, /tự gửi lại/);
  assert.equal(full.next, false);
  // A small commit (booth preview) or a calm server always goes through.
  assert.equal(run(0.9, 600 * 1024).next, true);
  assert.equal(run(0.5, 15 * MB).next, true);
});
