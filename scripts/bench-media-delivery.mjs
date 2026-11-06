// Live R2 transport benchmark. It never connects to MongoDB or uses customer media.
// Default is a dry run; pass --run explicitly to upload a unique disposable object.
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import express from "express";
import { config, root } from "../src/config.js";
import { sendMedia } from "../src/services/media.js";
import { mediaReference, r2Configured, r2Storage } from "../src/services/r2.js";

const args = new Set(process.argv.slice(2));
assert.ok([...args].every((arg) => ["--run", "--check-config"].includes(arg)), "Unknown argument");
const SIZE = 16 * 1024 * 1024;
const RUNS = 3;
const WARMUPS = 1;
const TRANSFER_TIMEOUT_MS = 180_000;
const plan = {
  provider: config.mediaStorageProvider,
  r2Configured: r2Configured(),
  objectMiB: SIZE / 1024 ** 2,
  measuredPairs: RUNS,
  warmupPairs: WARMUPS,
  totalDownloadMiB: SIZE / 1024 ** 2 * (RUNS + WARMUPS) * 2,
  uploadMiB: SIZE / 1024 ** 2,
  scope: "Local laptop proxy versus direct R2; not a Render production benchmark",
};
const round = (n) => Math.round(n * 100) / 100;
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
// Keep URLs, authorization details and upstream error messages out of saved reports/stdout.
const safeError = (error) => ({
  name: error?.name || "Error",
  ...(error?.code && { code: String(error.code) }),
  ...(Number.isInteger(error?.status) && { status: error.status }),
});

async function runBenchmark() {
  const id = randomUUID();
  const file = mediaReference(`benchmarks/media-delivery-${id}.bin`);
  // Fixed AES-CTR output is deterministic, noncompressible test data, with no customer input.
  const cipher = createCipheriv("aes-256-ctr", Buffer.alloc(32, 19), Buffer.alloc(16, 7));
  const bytes = Buffer.concat([cipher.update(Buffer.alloc(SIZE)), cipher.final()]);
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  const report = {
    id, startedAt: new Date().toISOString(), ...plan,
    method: {
      before: "Node fetch -> local HTTP server -> actual sendMedia() proxy -> R2 GET",
      after: "Node fetch -> private signed R2 GET",
      ordering: "One warmup pair, then three pairs alternating proxy/direct and direct/proxy",
      cache: "Node fetch cache=no-store, Cache-Control=no-cache, response cache-control=no-store",
      qualityCheck: "Exact length and SHA-256 validated on every complete download",
    },
    limitations: [
      "The proxy runs on this laptop, not Render; these timings do not predict a production speedup.",
      "Authentication/database queries and obtaining direct links are outside the measured transfer.",
      "The proxy bytes path is unchanged by this patch; direct delivery bypasses that path.",
      "A synthetic binary measures transport only, not image decoding, video rendering or capture-to-album time.",
      "Both paths use the same laptop, Wi-Fi and Node fetch client; no browser/CDN cache is used.",
    ],
    expectedSha256, warmups: [], runs: [], cleanup: { deleted: false, verifiedMissing: false },
  };
  let server, uploadAttempted = false;
  let proxyRequests = 0;
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const app = express();
    app.get("/proxy", async (req, res) => {
      proxyRequests++;
      res.set("Cache-Control", "no-store");
      try {
        // No direct query and no expiry: the existing unmodified proxy branch in sendMedia.
        await sendMedia(req, res, file, "application/octet-stream");
      } catch {
        if (!res.headersSent) res.status(502).end();
        else res.destroy();
      }
    });
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      listener.once("error", reject);
    });
    const proxy = `http://127.0.0.1:${server.address().port}/proxy`;
    uploadAttempted = true;
    const uploadStart = performance.now();
    await r2Storage.save(file, bytes, "application/octet-stream");
    const uploadMs = performance.now() - uploadStart;
    report.upload = { bytes: SIZE, ms: round(uploadMs), MiBps: round(SIZE / 1024 ** 2 / (uploadMs / 1000)) };
    console.log(JSON.stringify({ step: "temporary object uploaded", ...report.upload }));
    const head = await r2Storage.head(file);
    assert.equal(head?.ContentLength, SIZE, "Uploaded benchmark object has the wrong length");
    interrupted.signal.throwIfAborted();

    for (let pair = -WARMUPS; pair < RUNS; pair++) {
      const paths = pair >= 0 && pair % 2 ? ["direct", "proxy"] : ["proxy", "direct"];
      for (const route of paths) {
        interrupted.signal.throwIfAborted();
        const src = route === "proxy" ? proxy : await r2Storage.signedGet(file, 300, {
          ResponseContentType: "application/octet-stream", ResponseCacheControl: "no-store",
        });
        const result = await download(src, route, interrupted.signal, expectedSha256);
        const row = { pair: pair + 1, ...result };
        (pair < 0 ? report.warmups : report.runs).push(row);
        console.log(JSON.stringify({ step: pair < 0 ? "warmup" : "measured", ...row }));
      }
    }
    const medians = Object.fromEntries(["proxy", "direct"].map((route) => {
      const rows = report.runs.filter((row) => row.route === route);
      return [route, {
        totalMs: round(median(rows.map((row) => row.totalMs))),
        firstByteMs: round(median(rows.map((row) => row.firstByteMs))),
        MiBps: round(median(rows.map((row) => row.MiBps))),
      }];
    }));
    report.summary = {
      medians,
      localProxyToDirectRatio: round(medians.proxy.totalMs / medians.direct.totalMs),
      localReductionPercent: round((1 - medians.direct.totalMs / medians.proxy.totalMs) * 100),
      allDownloadsByteIdentical: true,
      proxyRequests,
    };
  } catch (error) {
    report.error = safeError(error);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    // Delete only the exact unique object this process created; never list or clean a prefix.
    if (uploadAttempted) {
      try {
        await r2Storage.delete(file);
        report.cleanup.deleted = true;
        report.cleanup.verifiedMissing = (await r2Storage.head(file)) === null;
        assert.equal(report.cleanup.verifiedMissing, true, "Temporary object remains after deletion");
      } catch (error) {
        report.cleanup.error = safeError(error);
        // This non-secret reference permits precise cleanup if the network fails during deletion.
        report.cleanup.remainingTemporaryReference = file;
        process.exitCode = 1;
      }
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    r2Storage.client().destroy();
    report.finishedAt = new Date().toISOString();
    const reportDir = path.join(root, ".cache");
    await mkdir(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `media-delivery-benchmark-${id}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ reportPath, summary: report.summary, cleanup: report.cleanup, error: report.error }));
  }
}

async function download(src, route, interruptSignal, expectedSha256) {
  const signal = AbortSignal.any([interruptSignal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)]);
  const start = performance.now();
  const response = await fetch(src, {
    cache: "no-store", headers: { "Cache-Control": "no-cache", "Accept-Encoding": "identity" }, signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error("Benchmark download failed"), { status: response.status });
  }
  const headersMs = performance.now() - start;
  const hash = createHash("sha256");
  let length = 0, firstByteMs;
  for await (const chunk of response.body) {
    firstByteMs ??= performance.now() - start;
    length += chunk.length;
    hash.update(chunk);
  }
  const totalMs = performance.now() - start;
  assert.equal(length, SIZE, "Benchmark download has the wrong length");
  assert.equal(hash.digest("hex"), expectedSha256, "Benchmark download has different bytes");
  return { route, bytes: length, headersMs: round(headersMs), firstByteMs: round(firstByteMs),
    totalMs: round(totalMs), MiBps: round(length / 1024 ** 2 / (totalMs / 1000)), sha256Matches: true };
}

console.log(JSON.stringify(plan));
if (args.has("--check-config") || !args.has("--run")) {
  console.log("No network transfers performed. Pass --run to execute.");
} else if (config.mediaStorageProvider !== "r2" || !r2Configured()) {
  console.error("Live R2 benchmark unavailable: R2 is not the configured media provider.");
  process.exitCode = 1;
} else {
  await runBenchmark();
}
