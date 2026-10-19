import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import PrintJob from "../models/PrintJob.js";
import { readMedia } from "./media.js";
import { deviceMessage } from "./messages.js";
import { printExtension } from "./print-image.js";
import { config, root } from "../config.js";
let queue = Promise.resolve();
export function dispatchPrint(job) {
  if (!config.dnpPrinter || process.platform !== "win32") return false;
  queue = queue
    .catch(() => {})
    .then(async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "photo-dnp-"));
      try {
        await PrintJob.updateOne(
          { _id: job._id },
          {
            $set: {
              spoolStatus: "sending",
              spoolMessage: "Đang gửi đến máy in DNP.",
            },
          },
        );
        const files = [];
        for (const [i, sheet] of (job.sheets?.length
          ? job.sheets
          : [{ file: job.file }]
        ).entries()) {
          const data = await readMedia(sheet.file);
          if (!data) throw new Error("Không tìm thấy file in.");
          const file = path.join(directory, i + "." + printExtension(sheet.file));
          await fs.writeFile(file, data);
          for (let n = 0; n < Math.max(1, job.copies || 1); n++)
            files.push(file);
        }
        const manifest = path.join(directory, "manifest.json");
        await fs.writeFile(manifest, JSON.stringify(files));
        await new Promise((resolve, reject) => {
          const child = spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-File",
              path.join(root, "scripts/print-dnp.ps1"),
              "-PrinterName",
              config.dnpPrinter,
              "-Manifest",
              manifest,
            ],
            { windowsHide: true },
          );
          let error = "";
          child.stderr.on("data", (data) => (error += data));
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0
              ? resolve()
              : reject(
                  new Error(deviceMessage(error, "Máy in DNP không nhận lệnh in.")),
                ),
          );
        });
        await PrintJob.updateOne(
          { _id: job._id },
          {
            $set: {
              spoolStatus: "sent",
              spoolMessage: "Đã gửi tất cả các tờ đến hàng đợi máy in Windows.",
            },
          },
        );
      } catch (e) {
        await PrintJob.updateOne(
          { _id: job._id },
          { $set: { spoolStatus: "failed", spoolMessage: e.message } },
        );
      } finally {
        if (
          path.dirname(directory) === os.tmpdir() &&
          path.basename(directory).startsWith("photo-dnp-")
        )
          await fs.rm(directory, { recursive: true, force: true });
      }
    });
  return true;
}
