import { Router } from "express";
import { z } from "zod";
import { Booking, PrintJob } from "../../models/index.js";
import { deleteMedia, MEDIA_TTL_MS } from "../../services/media.js";
import { printEvents } from "../../services/print-events.js";
import { fail, id } from "../validation.js";
import { publicJob, releaseSheets } from "../print-helpers.js";

export const printsRouter = Router();

// ─── Hàng chờ in: lệnh in khách gửi từ Web App ───────────────────────────
printsRouter.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 5000\n\n");
  const send = (job) =>
    res.write(`event: print\ndata: ${JSON.stringify(job)}\n\n`);
  printEvents.on("print", send);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    printEvents.off("print", send);
  });
});
printsRouter.get("/", async (req, res) => {
  const status = z
    .enum(["pending", "printed"])
    .default("pending")
    .parse(req.query.status);
  // Chỉ lệnh in còn hạn (24 giờ kể từ lúc gửi); lệnh hết hạn được dọn mỗi 15 phút.
  const jobs = await PrintJob.find({
    status,
    createdAt: { $gt: new Date(Date.now() - MEDIA_TTL_MS) },
  })
    .sort({ createdAt: status === "pending" ? 1 : -1 })
    .limit(200)
    .populate({ path: "booking", select: "accessToken" })
    .lean();
  res.json(jobs.map((j) => publicJob(j, j.booking?.accessToken)));
});
printsRouter.patch("/:id", async (req, res) => {
  const d = z
    .object({ status: z.enum(["pending", "printed"]) })
    .parse(req.body);
  const job = await PrintJob.findByIdAndUpdate(
    id.parse(req.params.id),
    d.status === "printed"
      ? { status: "printed", printedAt: new Date(), printedBy: req.user.name }
      : { status: "pending", $unset: { printedAt: 1, printedBy: 1 } },
    { new: true },
  ).populate({ path: "booking", select: "accessToken" });
  if (!job) fail(404, "Không tìm thấy lệnh in.");
  if (d.status === "printed" && job.booking)
    await Booking.updateOne({ _id: job.booking._id }, { printed: true });
  res.json(publicJob(job, job.booking?.accessToken));
});
printsRouter.delete("/:id", async (req, res) => {
  const job = await PrintJob.findById(id.parse(req.params.id));
  if (!job) fail(404, "Không tìm thấy lệnh in.");
  await deleteMedia([
    ...new Set([job.file, ...(job.sheets || []).map((s) => s.file)]),
  ]);
  // Keep the reference/quota when R2 is unavailable so cancellation can retry.
  const removed = await PrintJob.findOneAndDelete({ _id: job._id });
  if (!removed) return res.json({ ok: true });
  // Lệnh chưa in bị hủy: trả lại số tờ để khách sửa và gửi lại.
  if (removed.status === "pending" && removed.booking)
    await releaseSheets(removed.booking, removed.sheets?.length || 1);
  res.json({ ok: true });
});
