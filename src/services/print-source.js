import { delay } from "./delay.js";
import Booking from "../models/Booking.js";
import { saveMedia, deleteMedia } from "./media.js";
import { isSaveQueueBusy } from "./image-save-queue.js";

// The 3000 px print source is the most expensive derivative (a 4:4:4 JPEG encode of ~6 MP), but
// nobody needs it until the customer prints, minutes after the shoot. Making it after the photo
// is already saved keeps the kiosk's "Đang lưu…" short on the small free server. Jobs run one at
// a time, only while no photo is being saved, and the album simply prints from the camera
// original until `printFile` appears.
//
// A job keeps the already decoded pixels (about 18 MB) so nothing is decoded twice; when many
// jobs are waiting only the first few keep them and the rest decode the stored original again.
const MAX_RETAINED = 4;
const MAX_POLITE_WAIT_MS = 60_000;
const waiting = [];
let running = false;
let retained = 0;
let idleWaiters = [];

const polite = async () => {
  const until = Date.now() + MAX_POLITE_WAIT_MS;
  while (isSaveQueueBusy() && Date.now() < until) await delay(250);
};

async function run(job) {
  const bytes = job.encode ? await job.encode() : await job.reload();
  await saveMedia(job.printFile, bytes, "image/jpeg");
  const { matchedCount } = await Booking.updateOne(
    { _id: job.bookingId, "photos._id": job.photoId },
    { $set: { "photos.$.printFile": job.printFile } },
  );
  // The photo was deleted or expired while this was being made: do not leave an orphan file.
  if (!matchedCount) await deleteMedia([job.printFile]);
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (waiting.length) {
      const job = waiting.shift();
      try {
        await polite();
        await run(job);
      } catch (error) {
        // The photo stays fully usable: printing falls back to the camera original.
        console.error("Chưa tạo được nguồn in:", error.message);
        await deleteMedia([job.printFile]).catch(() => {});
      } finally {
        job.encode = null;
        if (job.retained) retained--;
      }
    }
  } finally {
    running = false;
    const done = idleWaiters;
    idleWaiters = [];
    for (const resolve of done) resolve();
  }
}

// job: { bookingId, photoId, printFile, encode(), reload() }
export function schedulePrintSource(job) {
  job.retained = retained < MAX_RETAINED;
  if (job.retained) retained++;
  else job.encode = null; // drop the decoded pixels; reload() decodes the stored original later
  waiting.push(job);
  pump();
}

// Resolves when every queued print source has been made (used by tests and shutdown).
export const whenPrintSourcesIdle = () =>
  running || waiting.length ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve();
