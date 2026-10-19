import { randomUUID } from "node:crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import sharp from "sharp";
import { app } from "../src/app.js";
import {
  MEDIA_TTL_MS,
  purgeExpiredMedia,
  readMedia,
  saveMedia,
} from "../src/services/media.js";
import { config } from "../src/config.js";
import {
  User,
  Room,
  Package,
  Booking,
  PrintJob,
  Frame,
} from "../src/models/index.js";
import { printEvents } from "../src/services/print-events.js";
import { backfillImageHashes, hashImage } from "../src/services/frame-image.js";
import {
  FINISH_GRACE_MS,
  finishOverdueSessions,
} from "../src/services/capture.js";
let memory, room, pack, staff, admin;
const bookingData = (time) => ({
  name: "Khách thử nghiệm",
  phone: "0912345678",
  room: String(room._id),
  package: String(pack._id),
  requestKey: randomUUID(),
  paymentReceived: true,
  paymentMethod: "cash",
});
before(async () => {
  config.secret = "test-secret-only-not-used-in-production-123456789";
  // Không bao giờ in thật / điều khiển máy ảnh thật khi chạy test trên máy ở tiệm.
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  room = await Room.create({
    name: "Test room",
    description: "Test",
    branch: "Test branch",
    active: true,
  });
  pack = await Package.create({
    name: "Test package",
    price: 120000,
    duration: 20,
    shots: 2,
    prints: 2,
    active: true,
  });
  const password = await bcrypt.hash("TestPassword!123", 10);
  await User.create([
    { name: "Admin", email: "admin@test.local", password, role: "admin" },
    { name: "Staff", email: "staff@test.local", password, role: "staff" },
  ]);
  admin = request.agent(app);
  staff = request.agent(app);
  await admin
    .post("/api/auth/login")
    .send({ email: "admin@test.local", password: "TestPassword!123" })
    .expect(200);
  await staff
    .post("/api/auth/login")
    .send({ email: "staff@test.local", password: "TestPassword!123" })
    .expect(200);
});
after(async () => {
  try {
    assert.equal(mongoose.models.Audit, undefined);
    assert.deepEqual(
      await mongoose.connection.db
        .listCollections({ name: "audits" }, { nameOnly: true })
        .toArray(),
      [],
      "business operations must never recreate the removed activity logs",
    );
  } finally {
    await mongoose.disconnect();
    await memory?.stop();
  }
});
test("catalog is public, admin is protected, staff cannot edit catalog or promote themselves", async () => {
  const c = await request(app).get("/api/catalog").expect(200);
  assert.equal(c.body.packages.length, 1);
  await request(app).get("/api/admin/bookings").expect(401);
  await staff.post("/api/admin/packages").send({}).expect(403);
  await staff.get("/api/admin/users").expect(403);
  const users = await admin.get("/api/admin/users").expect(200);
  assert.ok(users.body.every((u) => !u.password));
});
test("staff can view active rooms and branches, while room changes and other catalogs remain admin-only", async () => {
  const inactive = await Room.create({
    name: "Hidden inactive room",
    branch: "Inactive branch",
    active: false,
  });
  try {
    await request(app).get("/api/admin/rooms").expect(401);
    const desk = await staff.get("/api/admin/rooms").expect(200);
    assert.ok(desk.body.every((r) => r.active === true));
    const activeRoom = desk.body.find((r) => r._id === String(room._id));
    assert.equal(activeRoom?.branch, "Test branch");
    assert.equal(
      desk.body.some((r) => r._id === String(inactive._id)),
      false,
    );
    const owner = await admin.get("/api/admin/rooms").expect(200);
    assert.ok(owner.body.some((r) => r._id === String(inactive._id)));

    await staff.post("/api/admin/rooms").send({}).expect(403);
    await staff.put(`/api/admin/rooms/${room._id}`).send({}).expect(403);
    await staff.delete(`/api/admin/rooms/${room._id}`).expect(403);
    assert.equal((await Room.findById(room._id)).active, true);
    for (const resource of ["packages", "frames", "users"])
      await staff.get(`/api/admin/${resource}`).expect(403);
    await staff.get("/api/admin/settings").expect(403);
    await staff.put("/api/admin/settings").send({}).expect(403);
  } finally {
    await Room.deleteOne({ _id: inactive._id });
  }
});
test("staff can open a room kiosk, but guests and inactive rooms cannot receive device tokens", async () => {
  const kioskRoom = await Room.create({
    name: "Staff kiosk room",
    description: "Opened from the receptionist room list",
    branch: "Staff kiosk branch",
    active: true,
  });
  let ticket;
  try {
    const endpoint = `/api/admin/rooms/${kioskRoom._id}/device`;
    await request(app).post(endpoint).expect(401);
    const device = await staff.post(endpoint).expect(200);
    assert.equal(device.body.name, kioskRoom.name);
    const decoded = jwt.verify(device.body.token, config.secret);
    assert.equal(decoded.type, "kiosk");
    assert.equal(decoded.room, String(kioskRoom._id));
    assert.equal(decoded.exp - decoded.iat, 365 * 24 * 60 * 60);
    await admin.post(endpoint).expect(200);

    const issued = await staff
      .post("/api/admin/tickets")
      .send({ ...bookingData(), room: String(kioskRoom._id) })
      .expect(201);
    ticket = issued.body;
    const claimed = await request(app)
      .post("/api/kiosk/claim")
      .send({ code: ticket.code, device: device.body.token })
      .expect(200);
    assert.equal(claimed.body.booking.room, String(kioskRoom._id));
    assert.equal(
      jwt.verify(claimed.body.captureToken, config.secret).type,
      "capture",
    );

    await Room.updateOne({ _id: kioskRoom._id }, { active: false });
    for (const session of [staff, admin]) {
      const inactive = await session.post(endpoint).expect(409);
      assert.equal(inactive.body.message, "Phòng chụp đã ngừng hoạt động.");
      assert.equal(inactive.body.token, undefined);
    }
    await request(app)
      .post("/api/kiosk/claim")
      .send({ code: ticket.code, device: device.body.token })
      .expect(403);
    await staff.post("/api/admin/rooms/not-an-id/device").expect(400);
    await staff
      .post(`/api/admin/rooms/${new mongoose.Types.ObjectId()}/device`)
      .expect(404);
  } finally {
    if (ticket) await Booking.deleteOne({ _id: ticket._id });
    await Room.deleteOne({ _id: kioskRoom._id });
  }
});
test("the removed activity log API is unavailable to admin and staff", async () => {
  const response = await admin.get("/api/admin/audit").expect(404);
  assert.equal(response.body.message, "API không tồn tại.");
  await staff.get("/api/admin/audit").expect(404);
});
test("only staff issue paid walk-in codes; multiple customers need no time slot", async () => {
  const d = { ...bookingData(), total: 1, date: "2020-01-01", time: "01:00" };
  await request(app).post("/api/admin/tickets").send(d).expect(401);
  // Web nội bộ: không còn đặt lịch, tra cứu mã vé hay tự hủy vé công khai.
  for (const [method, path] of [
    ["post", "/api/bookings"],
    ["get", "/api/availability"],
    ["post", "/api/bookings/lookup"],
  ])
    await request(app)[method](path).send({ code: "123456" }).expect(404);
  const responses = await Promise.all([
    staff.post("/api/admin/tickets").send(d),
    staff.post("/api/admin/tickets").send({ ...d, requestKey: randomUUID() }),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [201, 201],
  );
  const b = responses[0].body;
  assert.notEqual(b.code, responses[1].body.code);
  assert.equal(b.total, 120000);
  assert.equal(b.paid, true);
  assert.equal(b.status, "confirmed");
  assert.equal(b.source, "counter");
  assert.equal(b.time, "");
  assert.notEqual(b.date, d.date);
  const album = await request(app)
    .get(`/api/albums/${b.accessToken}`)
    .expect(200);
  assert.equal(album.body.code, b.code, "the QR link opens the ticket album");
  await request(app).post(`/api/albums/${b.accessToken}/cancel`).expect(404);
  const anonymous = await staff
    .post("/api/admin/tickets")
    .send({ ...bookingData(), name: "", phone: "" })
    .expect(201);
  assert.equal(anonymous.body.name, "Khách tại quầy");
  await staff
    .post("/api/admin/tickets")
    .send({ ...bookingData(), paymentReceived: false })
    .expect(400);
});

test("payment transitions are enforced and cancelled tickets cannot be revived", async () => {
  const { body: b } = await staff
    .post("/api/admin/tickets")
    .send(bookingData("11:00"))
    .expect(201);
  await staff
    .patch(`/api/admin/bookings/${b._id}`)
    .send({ status: "completed" })
    .expect(409);
  await Booking.updateOne({ _id: b._id }, { status: "pending", paid: false });
  const paid = await staff
    .patch(`/api/admin/bookings/${b._id}`)
    .send({ status: "confirmed" })
    .expect(200);
  assert.equal(paid.body.paid, true);
  await staff
    .patch(`/api/admin/bookings/${b._id}`)
    .send({ status: "cancelled" })
    .expect(200);
  await staff
    .patch(`/api/admin/bookings/${b._id}`)
    .send({ status: "confirmed" })
    .expect(409);
});

test("retrying a booking after a lost response returns the same ticket", async () => {
  const body = {
    ...bookingData("14:30"),
    requestKey: "a7ef2608-9c73-43f4-b56b-6f06d7051f65",
  };
  const responses = await Promise.all([
    staff.post("/api/admin/tickets").send(body),
    staff.post("/api/admin/tickets").send(body),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  assert.equal(responses[0].body._id, responses[1].body._id);
  assert.equal(responses[0].body.accessToken, responses[1].body.accessToken);
  assert.equal(responses[0].body.requestKey, undefined);
  await staff.post("/api/admin/tickets").send(body).expect(200);
  await staff
    .post("/api/admin/tickets")
    .send({ ...body, name: "Different customer" })
    .expect(409);
  assert.equal(
    await Booking.countDocuments({ requestKey: body.requestKey }),
    1,
  );
});
const jpeg = async (width, height, color = "#722f3e") =>
  `data:image/jpeg;base64,${(
    await sharp({ create: { width, height, channels: 3, background: color } })
      .jpeg()
      .toBuffer()
  ).toString("base64")}`;

test("a paid ticket keeps its purchased duration after the package is edited", async () => {
  const { b, session } = await startSession();
  try {
    assert.equal(b.captureDuration, 20);
    await Package.updateOne({ _id: pack._id }, { duration: 5 });
    const started = await request(app)
      .post("/api/kiosk/start")
      .send({ captureToken: session.captureToken })
      .expect(200);
    assert.equal(started.body.booking.captureDuration, 20);
    assert.ok(
      Math.abs(
        new Date(started.body.booking.captureEndsAt) - Date.now() - 20 * 60000,
      ) < 5000,
    );
    const resumed = await request(app)
      .post("/api/kiosk/start")
      .send({ captureToken: session.captureToken })
      .expect(200);
    assert.equal(
      resumed.body.booking.captureEndsAt,
      started.body.booking.captureEndsAt,
    );
  } finally {
    await Package.updateOne({ _id: pack._id }, { duration: 20 });
    await Booking.deleteOne({ _id: b._id });
  }
});

test("legacy tickets without a duration snapshot can still start", async () => {
  const { b, session } = await startSession();
  await Booking.updateOne({ _id: b._id }, { $unset: { captureDuration: 1 } });
  const started = await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: session.captureToken })
    .expect(200);
  assert.equal(started.body.booking.captureDuration, 20);
  await Booking.deleteOne({ _id: b._id });
});

test("frame moves normalize legacy order, keep themes separate and reject stale/concurrent lists", async () => {
  const frames = await Frame.create([
    { name: "pink", themeName: "Order test", order: 0, active: true },
    { name: "pink", themeName: " Order test ", order: 0, active: false },
    { name: "Third", themeName: "Order test", order: 8, active: true },
    {
      name: "Other theme",
      themeName: "Other order test",
      order: 7,
      active: true,
    },
  ]);
  const ids = frames.slice(0, 3).map((frame) => String(frame._id));
  const path = `/api/admin/frames/${ids[1]}/move`;
  try {
    await request(app)
      .post(path)
      .send({ direction: "up", expectedIds: ids })
      .expect(401);
    await staff
      .post(path)
      .send({ direction: "up", expectedIds: ids })
      .expect(403);
    await admin
      .post(path)
      .send({ direction: "up", expectedIds: [ids[0], String(frames[3]._id)] })
      .expect(409);
    await admin
      .post(path)
      .send({ direction: "sideways", expectedIds: ids })
      .expect(400);
    const moved = await admin
      .post(path)
      .send({ direction: "up", expectedIds: ids })
      .expect(200);
    const ordered = moved.body
      .filter((frame) => ids.includes(frame._id))
      .sort((a, b) => a.order - b.order);
    assert.deepEqual(
      ordered.map((frame) => frame._id),
      [ids[1], ids[0], ids[2]],
    );
    assert.deepEqual(
      ordered.map((frame) => frame.order),
      [1, 2, 3],
    );
    assert.equal(
      moved.body.find((frame) => frame._id === String(frames[3]._id)).order,
      7,
    );
    await admin
      .post(path)
      .send({ direction: "up", expectedIds: ids })
      .expect(409);
    const expectedIds = ordered.map((frame) => frame._id);
    await admin.post(path).send({ direction: "up", expectedIds }).expect(400);
    const concurrent = await Promise.all([
      admin
        .post(`/api/admin/frames/${ids[0]}/move`)
        .send({ direction: "down", expectedIds }),
      admin
        .post(`/api/admin/frames/${ids[2]}/move`)
        .send({ direction: "up", expectedIds }),
    ]);
    assert.deepEqual(
      concurrent.map((response) => response.status).sort(),
      [200, 409],
    );
  } finally {
    await Frame.deleteMany({ _id: { $in: frames.map((frame) => frame._id) } });
  }
});

test("frames created before image hashes get one at startup without changing their edit time", async () => {
  const image = "data:image/png;base64,iVBORw0KGgo=";
  const frame = await Frame.create({
    name: "Legacy hash",
    image,
    slots: [{ x: 0, y: 0, w: 1, h: 1 }],
    active: true,
  });
  await Frame.collection.updateOne(
    { _id: frame._id },
    { $unset: { imageHash: 1 } },
  );
  try {
    assert.ok((await backfillImageHashes()) >= 1);
    const stored = await Frame.findById(frame._id).lean();
    assert.equal(stored.imageHash, hashImage(image));
    assert.equal(+stored.updatedAt, +frame.updatedAt);
    assert.equal(await backfillImageHashes(), 0, "already hashed frames are skipped");
    assert.ok(
      (await request(app).get("/api/catalog")).body.frames
        .find((f) => String(f._id) === String(frame._id))
        .image.endsWith("?v=" + hashImage(image)),
    );
  } finally {
    await Frame.deleteOne({ _id: frame._id });
  }
});

async function startSession() {
  const { body: b } = await staff
    .post("/api/admin/tickets")
    .send(bookingData())
    .expect(201);
  const { body: d } = await admin
    .post(`/api/admin/rooms/${room._id}/device`)
    .expect(200);
  const { body: session } = await request(app)
    .post("/api/kiosk/claim")
    .send({ code: b.code, device: d.token })
    .expect(200);
  return { b, d, session };
}

test("self-booth: timed session, unlimited numbered photos, idempotent uploads, timeout and finish", async () => {
  const { b, d, session } = await startSession();
  await request(app)
    .post("/api/kiosk/claim")
    .send({ code: b.code, device: "invalid" })
    .expect(403);
  const otherRoom = await Room.create({ name: "Other room", active: false });
  const otherDevice = jwt.sign(
    { type: "kiosk", room: String(otherRoom._id) },
    config.secret,
  );
  await request(app)
    .post("/api/kiosk/claim")
    .send({ code: b.code, device: otherDevice })
    .expect(403);
  await Room.deleteOne({ _id: otherRoom._id });

  const token = session.captureToken;
  await request(app)
    .post("/api/kiosk/photo")
    .send({
      captureToken: token,
      image: await jpeg(30, 30),
      clientKey: "before-start",
    })
    .expect(409);
  const started = await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: token })
    .expect(200);
  const endsAt = new Date(started.body.booking.captureEndsAt).getTime();
  assert.ok(
    Math.abs(endsAt - Date.now() - 20 * 60000) < 5000,
    "20-minute package sets a 20-minute timer",
  );
  assert.equal(
    started.body.booking.captureMode,
    "folder",
    "photos only come from the camera (X Acquire folder)",
  );
  // Không còn nút chụp trên màn hình / Capture One điều khiển từ máy chủ.
  await request(app)
    .post("/api/kiosk/trigger")
    .send({ captureToken: token })
    .expect(404);
  await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: token })
    .expect(200);
  assert.equal(
    new Date((await Booking.findById(b._id)).captureEndsAt).getTime(),
    endsAt,
    "restart keeps the timer",
  );

  await request(app)
    .post("/api/kiosk/photo")
    .send({
      captureToken: token,
      image: "data:image/jpeg;base64,aW52YWxpZA==",
      clientKey: "bad-image-1",
    })
    .expect(400);
  for (let i = 0; i < 3; i++)
    await request(app)
      .post("/api/kiosk/photo")
      .send({
        captureToken: token,
        image: await jpeg(40, 30),
        clientKey: `shot-000${i}`,
      })
      .expect(200);
  const retry = await request(app)
    .post("/api/kiosk/photo")
    .send({
      captureToken: token,
      image: await jpeg(40, 30),
      clientKey: "shot-0001",
    })
    .expect(200);
  assert.deepEqual(
    retry.body.photos.map((p) => p.number),
    [1, 2, 3],
    "retry does not duplicate",
  );
  const state = await request(app)
    .post("/api/kiosk/state")
    .send({ captureToken: token })
    .expect(200);
  assert.equal(state.body.booking.photos.length, 3);
  assert.deepEqual(
    state.body.booking.photos.map((p) => p.clientKey),
    ["shot-0000", "shot-0001", "shot-0002"],
    "kiosk matches saved photos with the ones it is still showing",
  );
  // Máy chụp báo tình trạng đọc thư mục ảnh máy ảnh: lưu cho quản trị, không trả cho khách.
  const diag = await request(app)
    .post("/api/kiosk/state")
    .send({
      captureToken: token,
      diag: {
        mode: "folder",
        camera: "",
        cameras: "USB Video (345f:2109), Camera FaceTime HD",
        cameraError: "NotReadableError: Could not start video source",
        folder: "X Acquire",
        access: "granted",
        jpegs: 12,
        fresh: 0,
        error: "",
        junk: "x",
      },
    })
    .expect(200);
  assert.equal(diag.body.booking.captureDiag, undefined);
  const withDiag = await Booking.findById(b._id).select("+captureDiag").lean();
  assert.equal(withDiag.captureDiag.folder, "X Acquire");
  assert.equal(withDiag.captureDiag.jpegs, 12);
  assert.match(withDiag.captureDiag.cameras, /USB Video/);
  assert.match(withDiag.captureDiag.cameraError, /NotReadableError/);
  assert.equal(
    withDiag.captureDiag.junk,
    undefined,
    "unknown fields are dropped",
  );
  assert.ok(withDiag.captureDiag.at instanceof Date);
  // Quản trị tra một vé theo mã (Swagger) để xem máy chụp đang thấy gì.
  const byCode = await admin
    .get(`/api/admin/bookings?code=${b.code}`)
    .expect(200);
  assert.equal(byCode.body.length, 1);
  assert.equal(byCode.body[0].captureDiag.folder, "X Acquire");
  assert.ok(Array.isArray(byCode.body[0].photos));
  // Danh sách chung (tự làm mới liên tục) nhẹ hơn: không kèm ảnh và chẩn đoán máy chụp.
  const listed = (await admin.get("/api/admin/bookings").expect(200)).body.find(
    (x) => x.code === b.code,
  );
  assert.ok(listed.accessToken);
  assert.equal(listed.photos, undefined);
  assert.equal(listed.captureDiag, undefined);
  await admin.get("/api/admin/bookings?code=12ab").expect(400);
  await request(app)
    .post("/api/kiosk/state")
    .send({ captureToken: token, diag: { jpegs: "many", folder: 5 } })
    .expect(200);
  await request(app)
    .get(
      `/api/albums/${session.accessToken}/photos/${state.body.booking.photos[0].id}`,
    )
    .expect(200)
    .expect("Content-Type", /image\/jpeg/);

  await Booking.updateOne(
    { _id: b._id },
    { captureEndsAt: new Date(Date.now() - 1000) },
  );
  await request(app)
    .post("/api/kiosk/photo")
    .send({
      captureToken: token,
      image: await jpeg(40, 30),
      clientKey: "too-late-1",
    })
    .expect(409);
  const done = await request(app)
    .post("/api/kiosk/finish")
    .send({ captureToken: token })
    .expect(200);
  assert.equal(done.body.status, "completed");
  await request(app)
    .post("/api/kiosk/finish")
    .send({ captureToken: token })
    .expect(200);
  await request(app)
    .post("/api/kiosk/photo")
    .send({
      captureToken: jwt.sign(
        { type: "capture", booking: b._id, sessionId: "another" },
        config.secret,
      ),
      image: await jpeg(30, 30),
      clientKey: "other-session",
    })
    .expect(409);

  const stored = await Booking.findById(b._id);
  assert.ok(stored.mediaExpiresAt > new Date());
  assert.equal(await purgeExpiredMedia(), 0);
  assert.ok(
    (await purgeExpiredMedia(new Date(Date.now() + MEDIA_TTL_MS + 1000))) >= 1,
  );
  const purged = await Booking.findById(b._id);
  assert.equal(purged.photos.length, 0);
  assert.equal(purged.mediaDeleted, true);
  await request(app)
    .get(`/api/albums/${session.accessToken}/photos/${stored.photos[0]._id}`)
    .expect(404);
  void d;
});

test("web app: favorites, bulk delete, upload, zip and multi-sheet print reach the admin queue", async () => {
  const { b, session } = await startSession();
  const token = session.accessToken;
  await request(app)
    .put(`/api/albums/${token}/favorites`)
    .send({ ids: [] })
    .expect(409);
  await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: session.captureToken })
    .expect(200);
  for (const [i, color] of ["#aa0000", "#00aa00", "#0000aa"].entries())
    await request(app)
      .post("/api/kiosk/photo")
      .send({
        captureToken: session.captureToken,
        image: await jpeg(40, 30, color),
        clientKey: `web-shot-${i}`,
      })
      .expect(200);
  const { body: done } = await request(app)
    .post("/api/kiosk/finish")
    .send({ captureToken: session.captureToken })
    .expect(200);
  const [first, second, third] = done.photos;

  const fav = await request(app)
    .put(`/api/albums/${token}/favorites`)
    .send({ ids: [first.id, third.id] })
    .expect(200);
  assert.deepEqual(
    fav.body.photos.map((p) => p.favorite),
    [true, false, true],
  );
  await request(app)
    .put(`/api/albums/${token}/favorites`)
    .send({ ids: [first.id, first.id] })
    .expect(400);
  const unavailable = await request(app)
    .put(`/api/albums/${token}/favorites`)
    .send({
      ids: Array.from({ length: 11 }, () =>
        new mongoose.Types.ObjectId().toString(),
      ),
    })
    .expect(400);
  assert.equal(
    unavailable.body.message,
    "Ảnh được chọn không còn trong album hoặc đã hết hạn lưu trữ.",
  );

  const removed = await request(app)
    .delete(`/api/albums/${token}/photos`)
    .send({ ids: [second.id] })
    .expect(200);
  // Numbers close up after a delete: the old #03 becomes #02.
  assert.deepEqual(
    removed.body.photos.map((p) => p.number),
    [1, 2],
  );
  const uploaded = await request(app)
    .post(`/api/albums/${token}/photos`)
    .send({
      image: await jpeg(50, 40, "#ffcc00"),
      clientKey: "upload-0001",
      name: "phone.jpg",
    })
    .expect(201);
  assert.equal(uploaded.body.photos.length, 3);
  assert.deepEqual(uploaded.body.photos.map((p) => p.number), [1, 2, 3]);
  // Delete the newest photo and add another: it takes the same number again.
  const newest = uploaded.body.photos.at(-1).id;
  await request(app).delete(`/api/albums/${token}/photos`).send({ ids: [newest] }).expect(200);
  const refilled = await request(app)
    .post(`/api/albums/${token}/photos`)
    .send({ image: await jpeg(50, 40, "#00ccff"), clientKey: "upload-0002", name: "again.jpg" })
    .expect(201);
  assert.deepEqual(refilled.body.photos.map((p) => p.number), [1, 2, 3]);
  assert.notEqual(refilled.body.photos.at(-1).id, newest);

  const zip = await request(app)
    .get(`/api/albums/${token}/download`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    })
    .expect(200)
    .expect("Content-Type", /zip/);
  assert.equal(zip.body.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.body.readUInt16LE(zip.body.length - 12), 3);

  const received = [];
  printEvents.on("print", (job) => received.push(job));
  const requestKey = randomUUID();
  await request(app)
    .post(`/api/albums/${token}/print-pack`)
    .send({
      images: [await jpeg(800, 1200)],
      frameName: "Sai khổ",
      requestKey: randomUUID(),
    })
    .expect(400);
  const sheet = await jpeg(1181, 1772, "#ffe0ea");
  const landscape = await jpeg(1772, 1181, "#e0f0ff"); // khung ngang → tờ ngang
  const job = await request(app)
    .post(`/api/albums/${token}/print-pack`)
    .send({ images: [sheet, landscape], frameName: "Chấm bi", requestKey })
    .expect(201);
  assert.equal(job.body.sheetCount, 2);
  const again = await request(app)
    .post(`/api/albums/${token}/print-pack`)
    .send({ images: [sheet, landscape], frameName: "Chấm bi", requestKey })
    .expect(200);
  assert.equal(again.body._id, job.body._id, "same requestKey is idempotent");
  printEvents.removeAllListeners("print");
  assert.equal(received.length, 1);
  assert.equal(received[0].code, b.code);

  const queue = await staff.get("/api/admin/print-jobs").expect(200);
  const mine = queue.body.find((j) => j.code === b.code);
  assert.equal(mine.sheetCount, 2);
  await request(app)
    .get(`${mine.image}?sheet=1`)
    .expect(200)
    .expect("Content-Type", /image\/jpeg/);
  await request(app).get(`${mine.image}?sheet=5`).expect(404);
  // Hàng chờ in xem bản nhỏ (nhẹ hơn nhiều); tải về vẫn là tờ đầy đủ.
  const small = await request(app)
    .get(`${mine.image}?sheet=1&size=thumbnail`)
    .expect(200)
    .expect("Content-Type", /image\/jpeg/);
  const smallMeta = await sharp(small.body).metadata();
  assert.ok(Math.max(smallMeta.width, smallMeta.height) <= 512);
  const fullSheet = await request(app).get(`${mine.image}?sheet=1`).expect(200);
  assert.ok(small.body.length < fullSheet.body.length);
  assert.equal((await sharp(fullSheet.body).metadata()).width > 512, true);
  await request(app).get(`${mine.image}?sheet=5&size=thumbnail`).expect(404);
  const downloaded = await request(app)
    .get(`${mine.image}?sheet=1&size=thumbnail&download=1`)
    .expect(200);
  assert.deepEqual(downloaded.body, fullSheet.body, "tải về không bao giờ là bản nhỏ");
  // Tải lệnh in nhiều tờ: một tệp ZIP đủ các tờ (trước đây chỉ tải được tờ đầu).
  const all = await request(app)
    .get(`${mine.image}?download=1`)
    .buffer(true)
    .parse((res, done) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    })
    .expect(200)
    .expect("Content-Type", /application\/zip/)
    .expect("Content-Disposition", new RegExp(`NXC-${b.code}-2-to-in\\.zip`));
  const zipped = all.body.toString("latin1");
  assert.ok(
    zipped.includes(`NXC-${b.code}-to-01.jpg`) &&
      zipped.includes(`NXC-${b.code}-to-02.jpg`),
    "zip has both sheets",
  );
  await request(app)
    .get(`${mine.image}?sheet=1&download=1`)
    .expect(200)
    .expect("Content-Type", /image\/jpeg/)
    .expect("Content-Disposition", new RegExp(`NXC-${b.code}-to-02\\.jpg`));
  await request(app).get("/api/admin/print-jobs").expect(401);
  const printed = await staff
    .patch(`/api/admin/print-jobs/${mine._id}`)
    .send({ status: "printed" })
    .expect(200);
  assert.equal(printed.body.printedBy, "Staff");
  assert.equal((await Booking.findById(b._id)).printed, true);
  const status = await request(app)
    .get(`/api/albums/${token}/print`)
    .expect(200);
  assert.equal(status.body.status, "printed");
  await staff.delete(`/api/admin/print-jobs/${mine._id}`).expect(200);
  await Booking.deleteOne({ _id: b._id });
});

test("each print job lives 24 hours from when it was sent, then is purged with its files", async () => {
  const hour = 3600 * 1000;
  const make = async (code, age, status = "pending") => {
    const file = `ttl-test-${code}.jpg`;
    await saveMedia(
      file,
      await sharp({
        create: { width: 10, height: 10, channels: 3, background: "#fff" },
      })
        .jpeg()
        .toBuffer(),
      "image/jpeg",
    );
    const createdAt = new Date(Date.now() - age);
    await PrintJob.collection.insertOne({
      code,
      name: "Khách",
      status,
      file,
      sheets: [{ file, width: 1772, height: 1181 }],
      copies: 1,
      createdAt,
      updatedAt: createdAt,
    });
    return file;
  };
  const expired = await make("111111", 25 * hour); // gửi 25 giờ trước
  const expiredPrinted = await make("111112", 24 * hour + 60000, "printed");
  const fresh = await make("222222", 23 * hour); // gửi 23 giờ trước — còn 1 giờ
  const pending = await staff.get("/api/admin/print-jobs").expect(200);
  const printed = await staff
    .get("/api/admin/print-jobs?status=printed")
    .expect(200);
  const listed = [...pending.body, ...printed.body];
  const kept = listed.find((j) => j.code === "222222");
  assert.ok(
    kept,
    "job sent 23 hours ago is still listed (not wiped at midnight)",
  );
  assert.ok(
    Math.abs(new Date(kept.expiresAt) - (Date.now() + hour)) < 60000,
    "expiresAt = sent time + 24 hours",
  );
  assert.ok(
    !listed.some((j) => ["111111", "111112"].includes(j.code)),
    "jobs older than 24 hours are hidden before the purge runs",
  );
  await purgeExpiredMedia();
  assert.equal(
    await PrintJob.countDocuments({ code: { $in: ["111111", "111112"] } }),
    0,
    "expired jobs deleted, printed or not",
  );
  assert.equal(await readMedia(expired), null, "expired sheet file deleted");
  assert.equal(await readMedia(expiredPrinted), null);
  assert.equal(await PrintJob.countDocuments({ code: "222222" }), 1);
  assert.ok(await readMedia(fresh), "fresh sheet file kept");
  await PrintJob.deleteMany({ code: "222222" });
});

test("each photo is kept 24 hours from when it was taken; older photos go first", async () => {
  const { b, session } = await startSession();
  await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: session.captureToken })
    .expect(200);
  for (const key of ["photo-early-1", "photo-early-2", "photo-late-1"])
    await request(app)
      .post("/api/kiosk/photo")
      .send({
        captureToken: session.captureToken,
        image: await jpeg(40, 30),
        clientKey: key,
      })
      .expect(200);
  await request(app)
    .post("/api/kiosk/finish")
    .send({ captureToken: session.captureToken })
    .expect(200);
  // Giả lập: 2 ảnh đầu chụp 25 giờ trước, ảnh cuối chụp 2 giờ trước (đổi mã ảnh theo thời điểm).
  const hour = 3600 * 1000;
  const stored = await Booking.findById(b._id);
  const at = (ms) =>
    mongoose.Types.ObjectId.createFromTime(
      Math.floor((Date.now() - ms) / 1000),
    );
  const photos = stored.photos.map((p) => ({
    ...p.toObject(),
    _id: at(p.clientKey === "photo-late-1" ? 2 * hour : 25 * hour),
  }));
  await Booking.collection.updateOne({ _id: stored._id }, { $set: { photos } });
  const files = Object.fromEntries(photos.map((p) => [p.clientKey, p.file]));
  const album = await request(app)
    .get(`/api/albums/${session.accessToken}`)
    .expect(200);
  const late = album.body.photos.find((p) => p.clientKey === "photo-late-1");
  assert.ok(
    Math.abs(new Date(late.expiresAt) - (Date.now() + 22 * hour)) < 5000,
    "each photo reports its own expiry (taken + 24h)",
  );
  assert.equal(await purgeExpiredMedia(), 1);
  const after = await Booking.findById(b._id);
  assert.deepEqual(
    after.photos.map((p) => p.clientKey),
    ["photo-late-1"],
    "only photos older than 24 hours are removed",
  );
  assert.equal(
    after.mediaDeleted,
    false,
    "album still open while a photo remains",
  );
  assert.ok(
    Math.abs(after.mediaExpiresAt - (Date.now() + 22 * hour)) < 5000,
    "album shows when the earliest remaining photo expires",
  );
  assert.equal(
    await readMedia(files["photo-early-1"]),
    null,
    "expired photo file deleted",
  );
  assert.ok(await readMedia(files["photo-late-1"]), "recent photo file kept");
  // Ảnh cuối cùng cũng hết hạn → album báo hết hạn.
  await Booking.collection.updateOne(
    { _id: stored._id },
    { $set: { "photos.0._id": at(24 * hour + 60000) } },
  );
  assert.equal(await purgeExpiredMedia(), 1);
  const gone = await Booking.findById(b._id);
  assert.equal(gone.photos.length, 0);
  assert.equal(gone.mediaDeleted, true);
  await Booking.deleteOne({ _id: b._id });
});

test("a paid ticket works at any room and any time on the day it was issued", async () => {
  const { body: b } = await staff
    .post("/api/admin/tickets")
    .send(bookingData("08:00"))
    .expect(201);
  const otherRoom = await Room.create({ name: "Phòng 02", active: true });
  const device = jwt.sign(
    { type: "kiosk", room: String(otherRoom._id) },
    config.secret,
  );
  const { body } = await request(app)
    .post("/api/kiosk/claim")
    .send({ code: b.code, device })
    .expect(200);
  assert.equal(body.booking.roomName, "Phòng 02");
  await request(app)
    .post("/api/kiosk/claim")
    .send({ code: "000000", device })
    .expect(400);
  await Booking.deleteOne({ _id: b._id });
  await Room.deleteOne({ _id: otherRoom._id });
});
async function finishedAlbum(photos = 1) {
  const { b, session } = await startSession();
  await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: session.captureToken })
    .expect(200);
  for (let i = 0; i < photos; i++)
    await request(app)
      .post("/api/kiosk/photo")
      .send({
        captureToken: session.captureToken,
        image: await jpeg(40, 30),
        clientKey: `quota-${b.code}-${i}`,
      })
      .expect(200);
  await request(app)
    .post("/api/kiosk/finish")
    .send({ captureToken: session.captureToken })
    .expect(200);
  return { b, token: session.accessToken };
}

test("lost print responses replay only identical sheets and request lookups stay inside the album", async () => {
  const { b, token } = await finishedAlbum();
  const images = [
    await jpeg(1181, 1772, "#ee9999"),
    await jpeg(1772, 1181, "#9999ee"),
  ];
  const requestKey = randomUUID();
  const body = { images, frameName: "Retry test", requestKey };
  const first = await request(app)
    .post(`/api/albums/${token}/print-pack`)
    .send(body)
    .expect(201);
  for (const changed of [
    { ...body, images: [...images].reverse() },
    { ...body, images: images.slice(0, 1) },
    { ...body, frameName: "Different theme" },
  ])
    await request(app)
      .post(`/api/albums/${token}/print-pack`)
      .send(changed)
      .expect(409);
  assert.equal(
    await PrintJob.countDocuments({ booking: b._id, requestKey }),
    1,
  );
  assert.equal((await Booking.findById(b._id)).printSheets, 2);
  const recovered = await request(app)
    .get(`/api/albums/${token}/print?requestKey=${requestKey}`)
    .expect(200);
  assert.equal(recovered.body._id, first.body._id);
  assert.equal(recovered.body.printSheets, 2);
  assert.equal(recovered.body.requestFingerprint, undefined);
  assert.equal(recovered.body.requestKey, undefined);
  assert.equal(
    (
      await request(app)
        .get(`/api/albums/${token}/print?requestKey=${randomUUID()}`)
        .expect(200)
    ).body,
    null,
  );
  await request(app)
    .get(`/api/albums/${token}/print?requestKey=not-a-key`)
    .expect(400);
  const other = await Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    status: "completed",
  });
  assert.equal(
    (
      await request(app)
        .get(`/api/albums/${other.accessToken}/print?requestKey=${requestKey}`)
        .expect(200)
    ).body,
    null,
  );
  await Booking.deleteOne({ _id: other._id });
  // A response lost immediately before original media expires is still recoverable.
  await Booking.updateOne({ _id: b._id }, { photos: [] });
  const replay = await request(app)
    .post(`/api/albums/${token}/print-pack`)
    .send(body)
    .expect(200);
  assert.equal(replay.body._id, first.body._id);
  assert.equal(replay.body.printSheets, 2);
});
test("print sheets sent as raw bytes match the JSON form, so a retry is recognised either way", async () => {
  const { b, token } = await finishedAlbum();
  const png = await sharp({ create: { width: 1200, height: 1800, channels: 3, background: "#d4a5b5" } })
    .png().toBuffer();
  const jpg = Buffer.from((await jpeg(1772, 1181, "#99bbee")).split(",")[1], "base64");
  const binary = (sheets, requestKey, frameName = "Bộ nhị phân") =>
    request(app)
      .post(`/api/albums/${token}/print-pack`)
      .set("Content-Type", "application/octet-stream")
      .set("X-Print-Key", requestKey)
      .set("X-Print-Frame", encodeURIComponent(frameName))
      .set("X-Print-Sheets", sheets.map((s) => s.length).join(","))
      .send(Buffer.concat(sheets));
  const asJson = (sheets, requestKey, frameName = "Bộ nhị phân") =>
    request(app).post(`/api/albums/${token}/print-pack`).send({
      frameName, requestKey,
      images: sheets.map((s) => `data:image/${s === png ? "png" : "jpeg"};base64,${s.toString("base64")}`),
    });
  const key = randomUUID();
  const first = await binary([png, jpg], key).expect(201);
  assert.equal(first.body.printSheets, 2);
  // The same sheets as JSON (an older page retrying) replay the job instead of printing twice.
  assert.equal((await asJson([png, jpg], key).expect(200)).body._id, first.body._id);
  assert.equal((await binary([png, jpg], key).expect(200)).body._id, first.body._id);
  await binary([jpg, png], key).expect(409);
  await binary([png, jpg], key, "Bộ khác").expect(409);
  const job = await PrintJob.findById(first.body._id);
  assert.deepEqual(job.sheets.map((s) => [s.width, s.height]), [[1200, 1800], [1772, 1181]]);
  assert.equal(job.frameName, "Bộ nhị phân");
  // Sheets keep their exact bytes (lossless PNG stays PNG).
  const stored = await request(app).get(`/api/albums/${token}/prints/${job._id}?sheet=0`).expect(200);
  assert.deepEqual(stored.body, png);
  // A job first sent as JSON is recognised when the retry arrives as bytes.
  await Booking.updateOne({ _id: b._id }, { $inc: { prints: 1 } });
  const jsonKey = randomUUID();
  const viaJson = await asJson([png], jsonKey).expect(201);
  assert.equal((await binary([png], jsonKey).expect(200)).body._id, viaJson.body._id);
  assert.equal((await Booking.findById(b._id)).printSheets, 3);
  // Malformed packs are refused before anything is reserved (another album: 10 sends / 10 min).
  const other = await finishedAlbum();
  const bad = (sizes, body = Buffer.concat([png, jpg]), headers = {}) => {
    const r = request(app).post(`/api/albums/${other.token}/print-pack`)
      .set("Content-Type", "application/octet-stream")
      .set("X-Print-Key", headers.key ?? randomUUID())
      .set("X-Print-Frame", headers.frame ?? "x");
    if (sizes !== undefined) r.set("X-Print-Sheets", sizes);
    return r.send(body).expect(400);
  };
  await bad(`${png.length},${jpg.length - 1}`);
  await bad(`${png.length + jpg.length},0`);
  await bad(undefined);
  await bad("abc");
  await bad(`${png.length},${jpg.length}`, Buffer.concat([png, jpg]), { key: "not-a-key" });
  await bad(`${png.length},${jpg.length}`, Buffer.concat([png, jpg]), { frame: "%E0%A4%A" });
  await bad("4,4", Buffer.from("not-an-image"));
  assert.equal((await Booking.findById(other.b._id)).printSheets || 0, 0);
});
test("prints follow the package quota; staff sell extra sheets and cancelled jobs give sheets back", async () => {
  const { b, token } = await finishedAlbum();
  const sheet = await jpeg(1181, 1772, "#ffe0ea");
  const send = (images, requestKey = randomUUID()) =>
    request(app)
      .post(`/api/albums/${token}/print-pack`)
      .send({ images, frameName: "Bộ thử", requestKey });
  const album = await request(app).get(`/api/albums/${token}`).expect(200);
  assert.equal(album.body.prints, 2, "package includes 2 sheets");
  assert.equal(album.body.printSheets, 0);
  const tooMany = await send([sheet, sheet, sheet]).expect(409);
  assert.match(tooMany.body.message, /còn 2\/2 tờ in/);
  const concurrent = await Promise.all([
    send([sheet, sheet]),
    send([sheet, sheet]),
  ]);
  assert.deepEqual(
    concurrent.map((r) => r.status).sort(),
    [201, 409],
    "two taps at once cannot exceed the quota",
  );
  const job = concurrent.find((r) => r.status === 201).body;
  assert.equal(job.printSheets, 2);
  const used = await send([sheet]).expect(409);
  assert.match(used.body.message, /đã dùng hết 2 tờ in/);

  await admin
    .put("/api/admin/settings")
    .send({
      name: "NXC",
      address: "ABC",
      phone: "0836663285",
      bank: "",
      bankAccount: "",
      bankOwner: "",
      extraPrintPrice: 15000,
    })
    .expect(200);
  const sale = {
    sheets: 1,
    paymentMethod: "cash",
    paymentReceived: true,
    requestKey: randomUUID(),
  };
  await staff
    .post(`/api/admin/bookings/${b._id}/prints`)
    .send({ ...sale, expectedTotal: 10000 })
    .expect(409);
  const sold = await staff
    .post(`/api/admin/bookings/${b._id}/prints`)
    .send({ ...sale, expectedTotal: 15000 })
    .expect(200);
  assert.equal(sold.body.prints, 3);
  assert.equal(sold.body.extraPrints, 1);
  assert.equal(sold.body.total, undefined, "staff never see ticket totals");
  assert.equal((await Booking.findById(b._id)).total, 120000 + 15000);
  assert.equal(sold.body.extraPrintKeys, undefined);
  const replay = await staff
    .post(`/api/admin/bookings/${b._id}/prints`)
    .send({ ...sale, expectedTotal: 15000 })
    .expect(200);
  assert.equal(replay.body.prints, 3);
  assert.equal(
    (await Booking.findById(b._id)).total,
    135000,
    "retrying a sale does not charge twice",
  );
  await send([sheet]).expect(201);
  await send([sheet]).expect(409);

  // The price is changed from the sale dialog by an admin only, leaving the other settings alone.
  await staff.put("/api/admin/settings/extra-print-price").send({ extraPrintPrice: 25000 }).expect(403);
  await admin.put("/api/admin/settings/extra-print-price").send({ extraPrintPrice: 20 }).expect(400);
  const priced = await admin.put("/api/admin/settings/extra-print-price").send({ extraPrintPrice: 25000 }).expect(200);
  assert.equal(priced.body.extraPrintPrice, 25000);
  assert.equal(priced.body.address, "ABC", "other settings untouched");
  assert.equal((await request(app).get("/api/catalog").expect(200)).body.settings.extraPrintPrice, 25000,
    "the cached catalog shows the new price at once");
  await staff
    .post(`/api/admin/bookings/${b._id}/prints`)
    .send({ ...sale, requestKey: randomUUID(), expectedTotal: 15000 })
    .expect(409, /Giá in thêm vừa thay đổi/);

  await staff.delete(`/api/admin/print-jobs/${job._id}`).expect(200);
  const back = await request(app).get(`/api/albums/${token}`).expect(200);
  assert.equal(
    back.body.printSheets,
    1,
    "cancelled pending job returns its 2 sheets",
  );
  await Booking.deleteOne({ _id: b._id });
});
test("a closed kiosk never blocks the album: overdue sessions finish on their own", async () => {
  const { b, session } = await startSession();
  await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: session.captureToken })
    .expect(200);
  await Booking.updateOne(
    { _id: b._id },
    { captureEndsAt: new Date(Date.now() - FINISH_GRACE_MS + 30000) },
  );
  const waiting = await request(app)
    .get(`/api/albums/${session.accessToken}`)
    .expect(200);
  assert.equal(
    waiting.body.status,
    "checked_in",
    "kiosk still has a short grace period",
  );
  await Booking.updateOne(
    { _id: b._id },
    { captureEndsAt: new Date(Date.now() - FINISH_GRACE_MS - 1000) },
  );
  const opened = await request(app)
    .get(`/api/albums/${session.accessToken}`)
    .expect(200);
  assert.equal(opened.body.status, "completed");
  // Không chụp ảnh nào thì không có hạn lưu (hạn tính theo từng ảnh).
  assert.equal(opened.body.mediaExpiresAt, undefined);

  const other = await startSession();
  await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: other.session.captureToken })
    .expect(200);
  await Booking.updateOne(
    { _id: other.b._id },
    { captureEndsAt: new Date(Date.now() - FINISH_GRACE_MS - 1000) },
  );
  assert.equal(await finishOverdueSessions(), 1);
  assert.equal((await Booking.findById(other.b._id)).status, "completed");
  await Booking.deleteMany({ _id: { $in: [b._id, other.b._id] } });
});
test("a broken kiosk hands the ticket to another room; a live kiosk keeps it", async () => {
  const { b, session } = await startSession();
  await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: session.captureToken })
    .expect(200);
  const endsAt = (await Booking.findById(b._id)).captureEndsAt.getTime();
  const roomB = await Room.create({ name: "Phòng B", active: true });
  const deviceB = jwt.sign(
    { type: "kiosk", room: String(roomB._id) },
    config.secret,
  );
  const busy = await request(app)
    .post("/api/kiosk/claim")
    .send({ code: b.code, device: deviceB })
    .expect(409);
  assert.match(busy.body.message, /đang được dùng ở Test room/);
  await Booking.updateOne(
    { _id: b._id },
    { captureSeenAt: new Date(Date.now() - 60000) },
  );
  const moved = await request(app)
    .post("/api/kiosk/claim")
    .send({ code: b.code, device: deviceB })
    .expect(200);
  assert.equal(moved.body.booking.roomName, "Phòng B");
  const old = await request(app)
    .post("/api/kiosk/state")
    .send({ captureToken: session.captureToken })
    .expect(409);
  assert.equal(old.body.message, "Mã vé này vừa được mở ở máy chụp khác.");
  const resumed = await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: moved.body.captureToken })
    .expect(200);
  assert.equal(
    new Date(resumed.body.booking.captureEndsAt).getTime(),
    endsAt,
    "resuming keeps the remaining time",
  );
  await request(app)
    .post("/api/kiosk/photo")
    .send({
      captureToken: moved.body.captureToken,
      image: await jpeg(40, 30),
      clientKey: "moved-0001",
    })
    .expect(200);
  await request(app)
    .post("/api/kiosk/finish")
    .send({ captureToken: moved.body.captureToken })
    .expect(200);
  const again = await request(app)
    .post("/api/kiosk/claim")
    .send({ code: b.code, device: deviceB })
    .expect(200);
  assert.equal(
    again.body.completed,
    true,
    "finished ticket shows its QR again",
  );
  assert.equal(again.body.accessToken, session.accessToken);
  assert.equal(again.body.captureToken, undefined);
  await Booking.deleteOne({ _id: b._id });
  await Room.deleteOne({ _id: roomB._id });
});
test("front desk: tickets need no room and the room board shows live sessions", async () => {
  const { body: anyRoom } = await staff
    .post("/api/admin/tickets")
    .send({ ...bookingData(), room: "" })
    .expect(201);
  assert.equal(anyRoom.roomName, "");
  assert.equal(anyRoom.prints, 2);
  const { b, session } = await startSession();
  const idle = await staff.get("/api/admin/rooms/live").expect(200);
  assert.equal(
    idle.body.rooms.find((r) => r.name === "Test room").status,
    "starting",
  );
  await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: session.captureToken })
    .expect(200);
  const live = await staff.get("/api/admin/rooms/live").expect(200);
  const testRoom = live.body.rooms.find((r) => r.name === "Test room");
  assert.equal(testRoom.status, "shooting");
  assert.equal(testRoom.code, b.code);
  assert.equal(testRoom.online, true);
  await request(app)
    .post("/api/kiosk/finish")
    .send({ captureToken: session.captureToken })
    .expect(200);
  const free = await staff.get("/api/admin/rooms/live").expect(200);
  assert.equal(
    free.body.rooms.find((r) => r.name === "Test room").status,
    "free",
  );
  await request(app).get("/api/admin/rooms/live").expect(401);
  await Booking.deleteMany({ _id: { $in: [anyRoom._id, b._id] } });
});
test("a busy studio on one wifi IP is not rate limited while kiosks and phones poll", async () => {
  const { b, session } = await startSession();
  // Máy chụp đọc ảnh gốc của máy ảnh từ thư mục (X Acquire / Capture One).
  const started = await request(app)
    .post("/api/kiosk/start")
    .send({ captureToken: session.captureToken, mode: "folder" })
    .expect(200);
  assert.equal(started.body.booking.captureMode, "folder");
  // 3 phòng chụp báo trạng thái 2 giây/lần + điện thoại khách mở album trong 1 phút.
  for (let i = 0; i < 200; i++) {
    await request(app)
      .post("/api/kiosk/state")
      .send({ captureToken: session.captureToken })
      .expect(200);
    await request(app).get(`/api/albums/${session.accessToken}`).expect(200);
    // Mọi máy trong tiệm dò lại máy chủ khi vừa mất kết nối.
    await request(app).get("/api/health").expect(200);
  }
  await request(app)
    .post("/api/kiosk/finish")
    .send({ captureToken: session.captureToken })
    .expect(200);
  await Booking.deleteOne({ _id: b._id });
});
test("invalid ticket inputs and cross-origin writes are rejected", async () => {
  await staff
    .post("/api/admin/tickets")
    .send({ ...bookingData(), phone: "123" })
    .expect(400);
  await staff
    .post("/api/admin/tickets")
    .set("Origin", "https://untrusted.example")
    .send(bookingData())
    .expect(403);
  await staff
    .post("/api/admin/tickets")
    .set("Content-Type", "application/json")
    .send("{invalid")
    .expect(400);
  await staff
    .post("/api/admin/tickets")
    .send({ ...bookingData(), room: String(new mongoose.Types.ObjectId()) })
    .expect(400);
});

test("swagger documents every API route and can call the API from the same origin", async () => {
  const html = await request(app).get("/api/docs/").expect(200);
  assert.match(html.text, /swagger-ui/i);
  const spec = (await request(app).get("/api/openapi.json").expect(200)).body;
  assert.equal(spec.openapi, "3.0.3");
  // Mọi route /api thật đều có trong tài liệu (thêm API mới mà quên ghi tài liệu thì báo lỗi).
  const missing = [];
  for (const layer of app.router.stack) {
    const route = layer.route;
    if (!route || !route.path.startsWith("/api/")) continue;
    if (["/api/openapi.json"].includes(route.path)) continue;
    const doc = spec.paths[route.path.replace(/:(\w+)/g, "{$1}")];
    for (const method of Object.keys(route.methods))
      if (!doc?.[method]) missing.push(`${method.toUpperCase()} ${route.path}`);
  }
  assert.deepEqual(missing, [], "routes missing from /api/openapi.json");
  // Trang Swagger chạy cùng địa chỉ máy chủ: lệnh ghi từ chính máy chủ không bị chặn.
  const host = "api.studio.test";
  await request(app)
    .post("/api/auth/logout")
    .set("Host", host)
    .set("Origin", `http://${host}`)
    .expect(200);
  await request(app)
    .post("/api/auth/logout")
    .set("Host", host)
    .set("Origin", "https://untrusted.example")
    .expect(403);
});

test("tickets use the package price and reject stale totals", async () => {
  const quote = await staff
    .post("/api/admin/tickets/quote")
    .send({ package: String(pack._id), coupon: "SAVE20" })
    .expect(200);
  assert.deepEqual(quote.body, { total: 120000, discount: 0 });
  const { body: b } = await staff
    .post("/api/admin/tickets")
    .send({ ...bookingData(), coupon: "SAVE20", expectedTotal: 120000 })
    .expect(201);
  assert.equal(b.total, 120000);
  assert.equal(b.discount, 0);
  await staff
    .post("/api/admin/tickets")
    .send({ ...bookingData(), expectedTotal: 1 })
    .expect(409);
  const catalog = await request(app).get("/api/catalog").expect(200);
  assert.equal(catalog.body.events, undefined);
  assert.equal(catalog.body.poses, undefined);
  for (const removed of ["poses", "events", "coupons"])
    await admin.get(`/api/admin/${removed}`).expect(404);
});

test("aggregated dashboard matches totals, paid revenue and room occupancy", async () => {
  const existing = await Booking.find().lean();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date());
  const { body: stats } = await admin.get("/api/admin/stats").expect(200);
  assert.equal(stats.bookings, existing.length);
  assert.equal(
    stats.revenue,
    existing.filter((b) => b.paid).reduce((n, b) => n + b.total, 0),
  );
  assert.equal(
    stats.pending,
    existing.filter((b) => b.status === "pending").length,
  );
  assert.equal(
    stats.today,
    existing.filter((b) => b.date === today && b.status !== "cancelled").length,
  );
  assert.equal(stats.byDate.length, 7);
  assert.equal(
    stats.byDate.at(-1).revenue,
    existing
      .filter((b) => b.date === today && b.paid)
      .reduce((n, b) => n + b.total, 0),
  );
  assert.equal(stats.occupancy[0].booked, stats.today);
  assert.equal(stats.occupancy[0].capacity, undefined);
  assert.equal(
    stats.todayRevenue,
    existing
      .filter((b) => b.date === today && b.paid)
      .reduce((n, b) => n + b.total, 0),
    "Doanh thu (trong ngày) = tiền đã nhận của vé cấp hôm nay",
  );
});

test("only admins see money: staff get no revenue, no ticket totals, no monthly report", async () => {
  // Lễ tân mới (phiên "staff" chung bị đổi mật khẩu ở bài test sau).
  await User.create({
    name: "Lễ tân Lan",
    email: "lan@test.local",
    password: await bcrypt.hash("TestPassword!123", 10),
    role: "staff",
  });
  const desk = request.agent(app);
  await desk
    .post("/api/auth/login")
    .send({ email: "lan@test.local", password: "TestPassword!123" })
    .expect(200);
  // Lễ tân vẫn thấy số tiền cần thu của vé mình đang cấp.
  const { body: ticket } = await desk
    .post("/api/admin/tickets")
    .send(bookingData())
    .expect(201);
  assert.equal(ticket.total, 120000);

  const stats = await desk.get("/api/admin/stats").expect(200);
  for (const field of ["revenue", "todayRevenue", "byDate"])
    assert.equal(stats.body[field], undefined, `staff stats hide ${field}`);
  assert.equal(typeof stats.body.today, "number");
  assert.equal(typeof stats.body.printQueue, "number");
  const adminStats = await admin.get("/api/admin/stats").expect(200);
  assert.equal(typeof adminStats.body.todayRevenue, "number");
  assert.equal(adminStats.body.byDate.length, 7);

  const report = await desk.get("/api/admin/stats/revenue").expect(403);
  assert.equal(
    report.body.message,
    "Chỉ quản trị viên được thực hiện thao tác này.",
  );
  await admin.get("/api/admin/stats/revenue").expect(200);

  const deskList = await desk.get("/api/admin/bookings").expect(200);
  assert.ok(deskList.body.length > 0);
  assert.ok(deskList.body.every((b) => b.total === undefined));
  assert.ok(deskList.body.some((b) => b.code === ticket.code && b.paid));
  const adminList = await admin.get("/api/admin/bookings").expect(200);
  assert.equal(
    adminList.body.find((b) => b.code === ticket.code).total,
    120000,
  );
  const cancelled = await desk
    .patch(`/api/admin/bookings/${ticket._id}`)
    .send({ status: "cancelled" })
    .expect(200);
  assert.equal(cancelled.body.total, undefined);
  await desk.get("/api/admin/audit").expect(404);
  await desk.get("/api/admin/settings").expect(403);
  await Booking.deleteOne({ _id: ticket._id });
});

test("monthly revenue lists every day of the chosen month with paid totals", async () => {
  const ticket = (date, total, paid = true) => ({
    code: String(randomUUID()).replace(/\D/g, "").slice(0, 6).padEnd(6, "7"),
    accessToken: randomUUID().replace(/-/g, ""),
    name: "Khách tháng 8",
    date,
    total,
    paid,
    status: paid ? "completed" : "cancelled",
  });
  const docs = await Booking.insertMany([
    ticket("2026-08-01", 100000),
    ticket("2026-08-15", 60000),
    ticket("2026-08-15", 120000),
    ticket("2026-08-31", 90000, false), // vé đã hủy, không tính
    ticket("2026-09-01", 70000), // tháng khác
  ]);
  const { body } = await admin
    .get("/api/admin/stats/revenue?month=2026-08")
    .expect(200);
  assert.equal(body.month, "2026-08");
  assert.equal(body.days.length, 31);
  assert.deepEqual(body.days[0], {
    date: "2026-08-01",
    revenue: 100000,
    tickets: 1,
  });
  assert.deepEqual(body.days[14], {
    date: "2026-08-15",
    revenue: 180000,
    tickets: 2,
  });
  assert.deepEqual(body.days[30], {
    date: "2026-08-31",
    revenue: 0,
    tickets: 0,
  });
  assert.equal(body.revenue, 280000);
  assert.equal(body.tickets, 3);
  const leap = await admin
    .get("/api/admin/stats/revenue?month=2028-02")
    .expect(200);
  assert.equal(leap.body.days.length, 29);
  const current = await admin.get("/api/admin/stats/revenue").expect(200);
  assert.equal(
    current.body.month,
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" })
      .format(new Date())
      .slice(0, 7),
  );
  const bad = await admin
    .get("/api/admin/stats/revenue?month=2026-13")
    .expect(400);
  assert.equal(bad.body.message, "Tháng không hợp lệ.");
  await request(app).get("/api/admin/stats/revenue").expect(401);
  await Booking.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
});

test("admin can create, edit and deactivate every catalog resource; settings are public", async () => {
  const entries = {
    rooms: {
      name: "CRUD room",
      description: "A room",
      branch: "ABC",
      active: true,
    },
    packages: {
      name: "CRUD package",
      description: "A package",
      price: 60000,
      duration: 10,
      shots: 4,
      prints: 2,
      active: true,
    },
    frames: {
      name: "CRUD frame",
      image: "data:image/png;base64,iVBORw0KGgo=",
      slots: [{ x: 0.1, y: 0.1, w: 0.8, h: 0.4 }],
      active: true,
    },
    users: {
      name: "CRUD staff",
      email: "crud@test.local",
      password: "StaffPassword!123",
      role: "staff",
      active: true,
    },
  };
  for (const [resource, body] of Object.entries(entries)) {
    const created = await admin
      .post(`/api/admin/${resource}`)
      .send(body)
      .expect(200);
    assert.ok(created.body._id);
    assert.equal(created.body.password, undefined);
    const changed = {
      ...body,
      name: body.name + " updated",
    };
    if (resource === "users") delete changed.password;
    await admin
      .put(`/api/admin/${resource}/${created.body._id}`)
      .send(changed)
      .expect(200);
    const list = await admin.get(`/api/admin/${resource}`).expect(200);
    assert.ok(list.body.some((item) => item._id === created.body._id));
    await admin
      .delete(`/api/admin/${resource}/${created.body._id}`)
      .expect(200);
    const disabled = await admin.get(`/api/admin/${resource}`).expect(200);
    const after = disabled.body.find((item) => item._id === created.body._id);
    if (resource === "frames") assert.equal(after, undefined);
    else assert.equal(after.active, false);
  }
  const designed = { ...entries.frames, name: "Canva frame" };
  const frame = await admin
    .post("/api/admin/frames")
    .send(designed)
    .expect(200);
  assert.deepEqual(frame.body.slots, designed.slots);
  await admin
    .post("/api/admin/frames")
    .send({ ...designed, slots: [] })
    .expect(400);
  await admin
    .post("/api/admin/frames")
    .send({ ...designed, image: "https://example.com/x.png" })
    .expect(400);
  await admin
    .post("/api/admin/frames")
    .send({ name: "Old color frame", color: "#294f3d", active: true })
    .expect(400);
  const catalog = await request(app).get("/api/catalog").expect(200);
  // Catalog không nhúng base64: ảnh khung là địa chỉ riêng, cache lâu dài, đổi ảnh thì đổi ?v=.
  const imageUrl = catalog.body.frames.find(
    (f) => f._id === frame.body._id,
  ).image;
  assert.match(
    imageUrl,
    new RegExp(`^/api/frames/${frame.body._id}/image\\?v=[a-f0-9]{12}$`),
  );
  assert.ok(!JSON.stringify(catalog.body).includes("base64"));
  const served = await request(app).get(imageUrl).expect(200);
  assert.equal(served.headers["content-type"], "image/png");
  assert.match(served.headers["cache-control"], /max-age=31536000, immutable/);
  assert.deepEqual(
    served.body,
    Buffer.from(designed.image.split(",")[1], "base64"),
  );
  await request(app)
    .get(imageUrl)
    .set("If-None-Match", served.headers.etag)
    .expect(304);
  assert.equal(
    (await request(app).get(imageUrl.split("?")[0]).expect(200)).headers[
      "cache-control"
    ],
    "no-cache",
    "không có ?v thì luôn hỏi lại, tránh giữ ảnh khung cũ",
  );
  await request(app).get("/api/frames/not-an-id/image").expect(400);
  // Danh sách quản trị cũng nhẹ (không base64); mở sửa mới lấy đủ ảnh của đúng khung đó.
  const adminList = (await admin.get("/api/admin/frames").expect(200)).body;
  assert.equal(adminList.find((f) => f._id === frame.body._id).image, imageUrl);
  assert.ok(!JSON.stringify(adminList).includes("base64"));
  const full = await admin
    .get(`/api/admin/frames/${frame.body._id}`)
    .expect(200);
  assert.equal(full.body.image, designed.image);
  await staff.get(`/api/admin/frames/${frame.body._id}`).expect(403);
  await admin.get("/api/admin/frames/000000000000000000000000").expect(404);
  // Đổi tên (không đổi ảnh) giữ nguyên ?v nên khách không phải tải lại ảnh khung.
  await admin
    .put(`/api/admin/frames/${frame.body._id}`)
    .send({ ...designed, name: "Canva frame renamed" })
    .expect(200);
  const renamed = (await request(app).get("/api/catalog")).body.frames.find(
    (f) => f._id === frame.body._id,
  );
  assert.equal(renamed.image, imageUrl);
  // Đổi ảnh thì ?v đổi.
  await admin
    .put(`/api/admin/frames/${frame.body._id}`)
    .send({ ...designed, image: "data:image/png;base64,iVBORw0KGgoAAAA=" })
    .expect(200);
  const swapped = (await request(app).get("/api/catalog")).body.frames.find(
    (f) => f._id === frame.body._id,
  );
  assert.notEqual(swapped.image, imageUrl);
  // Khung đang tắt không hiện cho khách nhưng quản trị vẫn xem được ảnh trong danh sách.
  await admin
    .put(`/api/admin/frames/${frame.body._id}`)
    .send({ ...designed, active: false })
    .expect(200);
  assert.ok(
    !(await request(app).get("/api/catalog")).body.frames.some(
      (f) => f._id === frame.body._id,
    ),
  );
  await request(app).get(swapped.image).expect(200);
  await admin.delete(`/api/admin/frames/${frame.body._id}`).expect(200);
  await request(app).get(imageUrl).expect(404);
  const studio = {
    name: "NXC",
    address: "ABC",
    phone: "0836663285",
    bank: "",
    bankAccount: "",
    bankOwner: "",
    bankQrImage: "https://example.com/bank-qr.png",
  };
  await admin.put("/api/admin/settings").send(studio).expect(200);
  assert.deepEqual(
    (await request(app).get("/api/catalog")).body.settings,
    studio,
  );
  await request(app).get("/api/studio/qr").expect(404);
  // Mã QR tải lên (base64) cũng tách khỏi catalog thành ảnh riêng.
  const uploadedQr = "data:image/png;base64,iVBORw0KGgo=";
  await admin
    .put("/api/admin/settings")
    .send({ ...studio, bankQrImage: uploadedQr })
    .expect(200);
  const qrSettings = (await request(app).get("/api/catalog")).body.settings;
  assert.match(qrSettings.bankQrImage, /^\/api\/studio\/qr\?v=[a-f0-9]{12}$/);
  const qr = await request(app).get(qrSettings.bankQrImage).expect(200);
  assert.equal(qr.headers["content-type"], "image/png");
  assert.deepEqual(qr.body, Buffer.from("iVBORw0KGgo=", "base64"));
  // Trang quản trị vẫn nhận nguyên ảnh để xem trước / sửa.
  assert.equal(
    (await admin.get("/api/admin/settings").expect(200)).body.bankQrImage,
    uploadedQr,
  );
  await admin.put("/api/admin/settings").send(studio).expect(200);
  const owner = await User.findOne({ email: "admin@test.local" });
  // Quản trị viên không tự sửa / tự ngừng tài khoản đang đăng nhập.
  const selfOff = await admin
    .delete(`/api/admin/users/${owner._id}`)
    .expect(403);
  assert.match(selfOff.body.message, /Không thể tự ngừng hoạt động/);
  const selfEdit = await admin
    .put(`/api/admin/users/${owner._id}`)
    .send({
      name: "Đổi tên",
      email: "admin@test.local",
      role: "admin",
      active: true,
    })
    .expect(403);
  assert.match(
    selfEdit.body.message,
    /Không thể tự sửa tài khoản đang đăng nhập/,
  );
  assert.equal((await User.findById(owner._id)).name, owner.name);
  // Tài khoản nhân viên do quản trị viên tạo thì sửa và ngừng hoạt động bình thường.
  const created = await admin
    .post("/api/admin/users")
    .send({
      name: "Lễ tân tạm",
      email: "tam@test.local",
      password: "LeTanTam!2026",
      role: "staff",
      active: true,
    })
    .expect(200);
  await admin
    .put(`/api/admin/users/${created.body._id}`)
    .send({
      name: "Lễ tân tạm 2",
      email: "tam@test.local",
      role: "staff",
      active: true,
    })
    .expect(200);
  await admin.delete(`/api/admin/users/${created.body._id}`).expect(200);
  assert.equal((await User.findById(created.body._id)).active, false);
  // Tạo nhân viên trùng email: báo rõ bằng tiếng Việt.
  const duplicate = await admin
    .post("/api/admin/users")
    .send({
      name: "Trùng email",
      email: "Admin@Test.Local",
      password: "Duplicate!12345",
      role: "staff",
      active: true,
    })
    .expect(409);
  assert.equal(
    duplicate.body.message,
    "Email này đã có tài khoản. Vui lòng dùng email khác.",
  );
  await admin
    .post("/api/admin/packages")
    .send({ ...entries.packages, duration: 31 })
    .expect(400);
});

test("admin can save and edit frames with thirteen or fourteen slots for larger collages", async () => {
  const slots = (count) =>
    Array.from({ length: count }, (_, i) => ({
      x: (i % 4) / 4,
      y: Math.floor(i / 4) / Math.ceil(count / 4),
      w: 0.2,
      h: 0.8 / Math.ceil(count / 4),
    }));
  const frame = {
    name: "Khung ghép nhiều ảnh",
    image: "data:image/png;base64,iVBORw0KGgo=",
    active: true,
    slots: slots(13),
  };
  const created = await admin.post("/api/admin/frames").send(frame).expect(200);
  assert.equal(created.body.slots.length, 13);
  const updated = await admin
    .put(`/api/admin/frames/${created.body._id}`)
    .send({ ...frame, slots: slots(14) })
    .expect(200);
  assert.equal(updated.body.slots.length, 14);
  const excessive = await admin
    .put(`/api/admin/frames/${created.body._id}`)
    .send({ ...frame, slots: slots(41) })
    .expect(400);
  assert.match(excessive.body.message, /tối đa 40 ô/);
  const publicFrames = (await request(app).get("/api/catalog")).body.frames;
  assert.equal(
    publicFrames.find((item) => item._id === created.body._id).slots.length,
    14,
  );
  await admin.delete(`/api/admin/frames/${created.body._id}`).expect(200);
});

test("password changes invalidate other sessions and retain the current session", async () => {
  const one = request.agent(app),
    two = request.agent(app);
  for (const agent of [one, two])
    await agent
      .post("/api/auth/login")
      .send({ email: "staff@test.local", password: "TestPassword!123" })
      .expect(200);
  await one
    .post("/api/auth/password")
    .send({ current: "Wrong", password: "NewPassword!123" })
    .expect(400);
  await one
    .post("/api/auth/password")
    .send({ current: "TestPassword!123", password: "NewPassword!123" })
    .expect(200);
  await one.get("/api/auth/me").expect(200);
  await two.get("/api/auth/me").expect(401);
  await request(app)
    .post("/api/auth/login")
    .send({ email: "staff@test.local", password: "TestPassword!123" })
    .expect(401);
  await request(app)
    .post("/api/auth/login")
    .send({ email: "staff@test.local", password: "NewPassword!123" })
    .expect(200);
});

test("login abuse does not block kiosks on the same network", async () => {
  for (let i = 0; i < 26; i++)
    await request(app)
      .post("/api/auth/login")
      .send({ email: "missing@test.local", password: "wrong" });
  await request(app)
    .post("/api/auth/login")
    .send({ email: "missing@test.local", password: "wrong" })
    .expect(429);
  // Máy chụp trong phòng vẫn nhận mã bình thường (giới hạn chống dò mã tách riêng).
  // (Phiên "staff" đã hết hiệu lực sau bài test đổi mật khẩu nên dùng admin.)
  const { body: b } = await admin
    .post("/api/admin/tickets")
    .send(bookingData())
    .expect(201);
  const { body: d } = await admin
    .post(`/api/admin/rooms/${room._id}/device`)
    .expect(200);
  await request(app)
    .post("/api/kiosk/claim")
    .send({ code: b.code, device: d.token })
    .expect(200);
  await Booking.deleteOne({ _id: b._id });
});

test("validation errors are friendly Vietnamese messages with field names", async () => {
  const user = await admin
    .post("/api/admin/users")
    .send({
      name: "",
      email: "abc",
      password: "123",
      role: "boss",
      active: true,
    })
    .expect(400);
  assert.match(user.body.message, /Tên: không được để trống/);
  assert.match(user.body.message, /Email: không đúng định dạng email/);
  assert.match(user.body.message, /Mật khẩu: tối thiểu 10 ký tự/);
  const pack = await admin
    .post("/api/admin/packages")
    .send({
      name: "Gói lỗi",
      description: "",
      price: -1,
      duration: 5,
      prints: 1,
      active: true,
    })
    .expect(400);
  assert.match(pack.body.message, /Giá: phải từ 0 trở lên/);
  // Giá gõ thiếu số 0 (60 thay vì 60.000) bị chặn; 0 (miễn phí) vẫn được.
  const typo = await admin
    .post("/api/admin/packages")
    .send({
      name: "Gói gõ thiếu",
      description: "",
      price: 60,
      duration: 5,
      prints: 1,
      active: true,
    })
    .expect(400);
  assert.match(typo.body.message, /Giá tối thiểu 1\.000 đ/);
  // Trùng tên phòng / gói đang dùng (không phân biệt hoa thường).
  const roomA = await admin
    .post("/api/admin/rooms")
    .send({ name: "Phòng Trùng", description: "", branch: "HN", active: true })
    .expect(200);
  const dupRoom = await admin
    .post("/api/admin/rooms")
    .send({
      name: "  phòng trùng ",
      description: "",
      branch: "HN",
      active: true,
    })
    .expect(409);
  assert.equal(
    dupRoom.body.message,
    "Đã có phòng tên “Phòng Trùng”. Vui lòng đặt tên khác.",
  );
  await admin
    .put(`/api/admin/rooms/${roomA.body._id}`)
    .send({
      name: "Phòng Trùng",
      description: "Sửa mô tả",
      branch: "HN",
      active: true,
    })
    .expect(200);
  await admin.delete(`/api/admin/rooms/${roomA.body._id}`).expect(200);
  // Cài đặt: số điện thoại, số tài khoản, đủ thông tin chuyển khoản, giá in thêm.
  const base = {
    name: "NXC",
    address: "ABC",
    phone: "0836663285",
    bank: "",
    bankAccount: "",
    bankOwner: "",
  };
  const settingsError = async (patch, pattern) => {
    const r = await admin
      .put("/api/admin/settings")
      .send({ ...base, ...patch })
      .expect(400);
    assert.match(r.body.message, pattern);
  };
  await settingsError({ phone: "abc" }, /Số điện thoại không hợp lệ/);
  await settingsError(
    { bank: "BIDV", bankAccount: "39501-ABC", bankOwner: "NXC" },
    /Số tài khoản chỉ gồm chữ số/,
  );
  await settingsError(
    { bank: "BIDV", bankAccount: "3950175888", bankOwner: "" },
    /nhập đủ tên ngân hàng, số tài khoản và chủ tài khoản/,
  );
  await settingsError({ extraPrintPrice: 20 }, /Giá tối thiểu 1\.000 đ/);
  await admin
    .put("/api/admin/settings")
    .send({
      ...base,
      bank: "BIDV",
      bankAccount: "3950175888",
      bankOwner: "NGUYEN XUAN CHIEN",
      extraPrintPrice: 20000,
    })
    .expect(200);
  const claim = await request(app)
    .post("/api/kiosk/claim")
    .send({ code: "12", device: "x" })
    .expect(400);
  assert.equal(claim.body.message, "Mã vé gồm 6 chữ số.");
  const ticket = await admin
    .post("/api/admin/tickets")
    .send({ ...bookingData(), paymentReceived: false })
    .expect(400);
  assert.equal(
    ticket.body.message,
    "Vui lòng xác nhận đã nhận đủ tiền của khách.",
  );
  const internal = await request(app)
    .post("/api/kiosk/photo")
    .send({
      captureToken: "x",
      image: "data:image/jpeg;base64,AA==",
      clientKey: "a",
    })
    .expect(400);
  assert.match(internal.body.message, /^Yêu cầu không hợp lệ/);
  for (const body of [
    user.body,
    pack.body,
    claim.body,
    ticket.body,
    internal.body,
  ])
    assert.doesNotMatch(body.message, /expected|Invalid|Too (small|big)/);
});
