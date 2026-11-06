import fs from "node:fs";
import os from "node:os";

// Sức chứa thật của máy chủ. Render giới hạn CPU và RAM bằng cgroup (Starter 0,5 CPU / 512 MB,
// Standard 1 CPU / 2 GB) trong khi os.availableParallelism() và os.totalmem() trả số của cả máy vật
// lý (vd. 8 lõi, 64 GB): dựa vào đó sẽ xử lý quá nhiều ảnh cùng lúc và bị tắt vì hết RAM.
const readFile = (file) => fs.readFileSync(file, "utf8");

export function cpuLimit(read = readFile) {
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

// RAM được cấp (byte): cgroup v2 "memory.max" ("max" = không giới hạn), rồi cgroup v1 (không giới
// hạn thì là một số rất lớn), không thì RAM của máy.
export function memoryLimit(read = readFile, total = os.totalmem()) {
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const limit = Number(read(file).trim());
      if (limit > 0) return Math.min(limit, total);
    } catch { /* không có tệp này */ }
  }
  return total;
}

// Số luồng xử lý ảnh (sharp / libvips): theo CPU được cấp, làm tròn lên, từ 1 tới 4.
export const imageThreads = (cpus = cpuLimit()) => Math.max(1, Math.min(4, Math.ceil(cpus)));

const MB = 1024 * 1024;
// Việc xử lý ảnh vừa sức máy. Giải mã một ảnh gốc 26 MP (~15 MB) cần ~75 MB lúc cao điểm; Node,
// Mongoose và thư viện S3 đã chiếm ~150 MB.
//   saves:          số ảnh xử lý cùng lúc (ảnh gửi cả tệp qua máy chủ; ảnh đã lên thẳng kho R2 nhẹ).
//   retainedPrints: số ảnh chờ tạo nguồn in được giữ sẵn điểm ảnh đã giải mã (~18 MB mỗi ảnh); ảnh
//                   sau đó giải mã lại ảnh gốc từ kho khi tới lượt.
//   sharpCacheMB:   bộ nhớ đệm của libvips.
//   Starter (512 MB): 1 / 0 / 16.  1 GB: 2 / 2 / 32.  Standard (2 GB) trở lên: 3 / 4 / 64.
export function serverBudget({ cpus = cpuLimit(), memory = memoryLimit() } = {}) {
  const mb = memory / MB;
  const tier = mb < 900 ? 0 : mb < 1800 ? 1 : 2;
  return {
    cpus,
    memory,
    threads: imageThreads(cpus),
    saves: [1, 2, 3][tier],
    retainedPrints: [0, 2, 4][tier],
    sharpCacheMB: [16, 32, 64][tier],
  };
}

export const budget = serverBudget();
export const describeBudget = (b = budget) =>
  `${Number(b.cpus.toFixed(2))} CPU, ${Math.round(b.memory / MB)} MB RAM → xử lý ${b.saves} ảnh cùng lúc, ` +
  `${b.threads} luồng sharp, giữ sẵn ${b.retainedPrints} ảnh chờ tạo nguồn in`;

// Phần RAM đang dùng so với giới hạn (0..1, có thể vượt 1 ngay trước khi bị tắt).
export const memoryUse = (rss = process.memoryUsage.rss(), limit = budget.memory) => rss / limit;

// Ngưỡng: từ 70% việc nền (tạo nguồn in) chờ và không giữ điểm ảnh; từ 85% không nhận thêm body lớn
// (ảnh / video gửi cả tệp qua máy chủ) — máy chụp giữ ảnh trên máy và tự gửi lại sau vài giây, còn
// để máy chủ hết RAM thì Render tắt nó: mất mọi yêu cầu đang chạy và hàng chờ tạo nguồn in.
export const MEMORY_BUSY = 0.7;
export const MEMORY_FULL = 0.85;
const LARGE_BODY = 8 * MB;

export function shedLargeBodies({ use = memoryUse, full = MEMORY_FULL, minBytes = LARGE_BODY } = {}) {
  return (req, res, next) => {
    if (Number(req.get("content-length")) > minBytes && use() > full) {
      res.set("Retry-After", "15");
      return res.status(503).json({
        message: "Máy chủ đang bận xử lý ảnh. Ảnh vẫn được giữ trên máy và sẽ tự gửi lại sau ít giây.",
      });
    }
    next();
  };
}
