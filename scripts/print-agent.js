import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, root } from "../src/config.js";

const api = (process.env.PRINT_AGENT_API_URL || "").replace(/\/$/, "");
const branch = (process.env.PRINT_AGENT_BRANCH || "").trim();
const token = config.printAgentToken;
if (process.platform !== "win32" || !/^https:\/\//.test(api) || !branch || token.length < 32)
  throw new Error("Cần Windows, PRINT_AGENT_API_URL (HTTPS), PRINT_AGENT_BRANCH và PRINT_AGENT_TOKEN dài ít nhất 32 ký tự.");

const headers = { Authorization: `Bearer ${token}` };
async function call(endpoint, options = {}) {
  const response = await fetch(`${api}/api/print-agent${endpoint}`, {
    ...options, headers: { ...headers, ...options.headers },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Print API ${response.status} tại ${endpoint}`);
  return response;
}
async function print(job) {
  // Khung nhỏ (2 dải trên một tờ 4x6) in qua hàng in "2inch cut" để máy cắt đôi; chưa tạo hàng in đó
  // thì in qua hàng in chính (nhân viên tự cắt) thay vì bỏ lệnh in của khách.
  const strip = job.printSize === "strip";
  if (strip && !config.dnpStripPrinter && config.dnpPrinter)
    console.warn("Chưa đặt DNP_STRIP_PRINTER_NAME — tờ 2 dải in qua máy chính, cần tự cắt đôi.");
  const printer = strip ? config.dnpStripPrinter || config.dnpPrinter : config.dnpPrinter;
  if (!printer) throw new Error("Thiếu DNP_PRINTER_NAME (tên máy in DNP trong Windows) trong file .env của print agent.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "photo-agent-"));
  try {
    const files = [];
    for (const sheet of job.sheets) {
      const response = await call(`/jobs/${job.id}/sheets/${sheet.index}`, {
        headers: { "X-Print-Lease": job.leaseId },
      });
      const file = path.join(directory, `${sheet.index}.${sheet.extension}`);
      await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
      for (let copy = 0; copy < job.copies; copy++) files.push(file);
    }
    const manifest = path.join(directory, "manifest.json");
    await fs.writeFile(manifest, JSON.stringify(files));
    await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
        path.join(root, "scripts", "print-dnp.ps1"), "-PrinterName", printer,
        "-Manifest", manifest], { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data.toString().slice(0, 1000); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(
        stderr.trim() || `Windows Print Spooler trả mã ${code}.`)));
    });
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) &&
      path.basename(resolved).startsWith("photo-agent-"))
      await fs.rm(resolved, { recursive: true, force: true });
  }
}

async function cycle() {
  const { job } = await (await call("/claim", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch }) })).json();
  if (!job) return false;
  let sent = false, message = "";
  try {
    await print(job);
    sent = true;
    console.log(`Đã gửi lệnh ${job.id} đến hàng in Windows.`);
  } catch (error) {
    message = error.message;
    console.error(`Lệnh ${job.id} thất bại: ${message}`);
  }
  await call(`/jobs/${job.id}/complete`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leaseId: job.leaseId, sent, message: message.slice(0, 500) }) });
  return true;
}

console.log(`Print agent đang theo dõi chi nhánh ${branch}.`);
do {
  try { await cycle(); }
  catch (error) { console.error(`Không thể nhận lệnh in: ${error.message}`); }
  if (process.env.PRINT_AGENT_ONCE === "1") break;
  await new Promise((resolve) => setTimeout(resolve, 4000));
} while (true);
