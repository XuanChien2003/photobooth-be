import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { PrintJob } from "../models/index.js";
import { MEDIA_TTL_MS, sendMedia } from "../services/media.js";
import { printContentType } from "../services/print-image.js";
import { fail, id } from "./validation.js";

export const printAgentRouter = Router();
const LEASE_MS = 5 * 60 * 1000;

printAgentRouter.use((req, res, next) => {
  const expected = Buffer.from(config.printAgentToken);
  const supplied = Buffer.from((req.get("Authorization") || "").replace(/^Bearer /i, ""));
  if (expected.length < 32 || supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected))
    return res.status(403).json({ message: "Print agent chưa được cấp quyền." });
  next();
});

printAgentRouter.post("/claim", async (req, res) => {
  const { branch } = z.object({ branch: z.string().trim().min(1).max(200) }).parse(req.body);
  const now = new Date();
  // An expired lease has uncertain physical outcome. Require a human check
  // before resending so a lost acknowledgement cannot print a second copy.
  await PrintJob.updateMany({ branch, status: "pending", spoolStatus: "sending",
    spoolLeaseUntil: { $lte: now } }, { $set: { spoolStatus: "failed",
      spoolMessage: "Mất xác nhận từ máy in; kiểm tra giấy trước khi gửi lại." } });
  const leaseId = crypto.randomUUID();
  const job = await PrintJob.findOneAndUpdate({
    branch, status: "pending", spoolStatus: "queued",
    createdAt: { $gt: new Date(now.getTime() - MEDIA_TTL_MS) },
  }, { $set: { spoolStatus: "sending", spoolMessage: "Máy in tại tiệm đang nhận lệnh.",
    spoolLeaseId: leaseId, spoolLeaseUntil: new Date(now.getTime() + LEASE_MS) } },
  { sort: { createdAt: 1 }, new: true }).select("+spoolLeaseId");
  if (!job) return res.json({ job: null });
  res.json({ job: { id: job._id, leaseId, code: job.code,
    printSize: job.printSize || "full", copies: Math.max(1, job.copies || 1),
    sheets: (job.sheets?.length ? job.sheets : [{ file: job.file }]).map((sheet, index) => ({
      index, extension: /\.png$/i.test(sheet.file) ? "png" : "jpg",
    })) } });
});

printAgentRouter.get("/jobs/:id/sheets/:index", async (req, res) => {
  const job = await PrintJob.findOne({ _id: id.parse(req.params.id),
    spoolLeaseId: z.uuid().parse(req.get("X-Print-Lease")),
    spoolStatus: "sending", spoolLeaseUntil: { $gt: new Date() } })
    .select("+spoolLeaseId");
  if (!job) fail(404, "Lệnh in không còn được cấp cho máy này.");
  const index = z.coerce.number().int().min(0).max(19).parse(req.params.index);
  const file = job.sheets?.length ? job.sheets[index]?.file : index === 0 ? job.file : null;
  if (!file) fail(404, "Không tìm thấy tờ in.");
  await sendMedia(req, res, file, printContentType(file));
});

printAgentRouter.post("/jobs/:id/complete", async (req, res) => {
  const { leaseId, sent, message } = z.object({
    leaseId: z.uuid(), sent: z.boolean(), message: z.string().max(500).default(""),
  }).parse(req.body);
  const job = await PrintJob.findOneAndUpdate({ _id: id.parse(req.params.id),
    spoolLeaseId: leaseId, spoolStatus: "sending" }, { $set: {
      spoolStatus: sent ? "sent" : "failed",
      spoolMessage: sent ? "Đã gửi đến hàng đợi in Windows tại tiệm." :
        (message || "Máy in không nhận lệnh."),
    }, $unset: { spoolLeaseUntil: 1 } }, { new: true }).select("+spoolLeaseId");
  if (!job) fail(409, "Lệnh in đã được xử lý hoặc phiên máy in đã thay đổi.");
  res.json({ spoolStatus: job.spoolStatus });
});
