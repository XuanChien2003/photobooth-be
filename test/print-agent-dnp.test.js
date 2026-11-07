// The Windows DNP print agent (PowerShell, photobooth-fe/src/admin/installers/print-agent-dnp.ps1) against
// a real server: it takes only its own room's jobs, sends big sheets to the main DNP queue and small
// sheets (two 2 × 6 strips) to the 2-inch-cut queue, and reports the printer. Printing is replaced by
// copying the sheets (-DryRunDir); everything else is the real script. Windows only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import sharp from "sharp";
import { MongoMemoryServer } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { PrintJob, Room, Setting } from "../src/models/index.js";
import { saveMedia } from "../src/services/media.js";

const script = fileURLToPath(new URL("../../photobooth-fe/src/admin/installers/print-agent-dnp.ps1", import.meta.url));
const skip = process.platform !== "win32" ? "Windows only" : !existsSync(script) ? "photobooth-fe not next to photobooth-be" : false;
let memory, server, base, folder;

before(async () => {
  if (skip) return;
  config.secret = "test-secret-only-not-used-in-production-123456789";
  config.printAgentToken = "";
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  folder = await mkdtemp(path.join(os.tmpdir(), "nxc-dnp-agent-"));
});
after(async () => {
  if (skip) return;
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await memory?.stop();
  await rm(folder, { recursive: true, force: true });
});

test("the room's DNP agent prints its own jobs: big sheets as they are, small sheets on the cut queue", { skip, timeout: 120000 }, async () => {
  const [room, other] = await Room.create([
    { name: "Phòng 1", branch: "Chi nhánh A", active: true },
    { name: "Phòng 2", branch: "Chi nhánh A", active: true },
  ]);
  const sheet = async (name, width, height) => {
    await saveMedia(name, await sharp({ create: { width, height, channels: 3, background: "#e8d2c4" } }).jpeg().toBuffer(), "image/jpeg");
    return { file: name, width, height };
  };
  const full = await sheet("full-sheet.jpg", 1200, 1800), strip = await sheet("strip-sheet.jpg", 1200, 1800);
  const job = (target, code, printSize, sheets, copies = 1) => PrintJob.create({
    branch: "Chi nhánh A", room: target._id, code, printSize, copies, file: sheets[0].file, sheets,
    status: "pending", spoolStatus: "queued",
  });
  const big = await job(room, "111111", "full", [full], 2);
  const small = await job(room, "222222", "strip", [strip]);
  const foreign = await job(other, "333333", "full", [full]);
  const token = jwt.sign({ type: "print-agent", room: String(room._id), branch: "Chi nhánh A" }, config.secret);
  const configPath = path.join(folder, "config.json");
  await writeFile(configPath, JSON.stringify({
    api: base, token, room: "Phòng 1", printer: "DNP TEST", stripPrinter: "DNP TEST - cat doi 2x6", cut: "queue",
  }));
  const out = path.join(folder, "printed");
  await promisify(execFile)("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Once", "-DryRunDir", out, "-ConfigPath", configPath,
  ], { timeout: 110000, windowsHide: true });

  const printed = (await readdir(out)).sort();
  assert.deepEqual(printed, [
    "NXC-111111-1-DNP_TEST.jpg", "NXC-111111-2-DNP_TEST.jpg",
    "NXC-222222-1-DNP_TEST_-_cat_doi_2x6.jpg",
  ], "2 copies of the big sheet on the main queue, the strip sheet on the cut queue");
  const [bigDone, smallDone, foreignAfter] = await Promise.all([big, small, foreign].map((j) => PrintJob.findById(j._id)));
  assert.equal(bigDone.spoolStatus, "sent");
  assert.match(bigDone.spoolMessage, /^Đã gửi 2 tờ tới máy DNP/);
  assert.equal(smallDone.spoolStatus, "sent");
  assert.match(smallDone.spoolMessage, /cắt đôi 2 inch/);
  assert.equal(foreignAfter.spoolStatus, "queued", "the other room's printer prints this one");
  // Tình trạng máy in (máy này không có máy DNP "DNP TEST" thật).
  const status = (await Setting.collection.findOne({ key: `printers:room:${room._id}` })).value;
  assert.equal(status.dnp.ready, false);
  assert.equal(status.dnp.state, "Không thấy máy in DNP trong Windows");
  assert.equal(status.dnp.printer, "DNP TEST");
  assert.ok(status.agent.at, "the admin sees the agent running");
});
