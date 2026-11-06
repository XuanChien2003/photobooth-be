import fs from "node:fs";
import os from "node:os";

// Số CPU thật được cấp cho máy chủ. Render giới hạn bằng cgroup (gói Starter: 0,5 CPU) trong khi
// os.availableParallelism() trả số lõi của cả máy vật lý (vd. 8): dựa vào đó sẽ mở quá nhiều luồng
// xử lý ảnh chỉ tranh nhau nửa CPU và tốn thêm RAM.
export function cpuLimit(read = (file) => fs.readFileSync(file, "utf8")) {
  try {
    // cgroup v2: "<quota> <period>" hoặc "max <period>".
    const [quota, period] = read("/sys/fs/cgroup/cpu.max").trim().split(/\s+/).map(Number);
    if (quota > 0 && period > 0) return quota / period;
  } catch { /* không phải cgroup v2 */ }
  try {
    // cgroup v1.
    const quota = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"));
    const period = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
    if (quota > 0 && period > 0) return quota / period;
  } catch { /* không giới hạn bằng cgroup (máy tính thường) */ }
  return os.availableParallelism();
}

// Số luồng xử lý ảnh (sharp / libvips): theo CPU được cấp, làm tròn lên, từ 1 tới 4.
export const imageThreads = (cpus = cpuLimit()) => Math.max(1, Math.min(4, Math.ceil(cpus)));
