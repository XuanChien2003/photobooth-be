import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInstaxPrinter, instaxStatus, printInstaxJob } from "../scripts/instax-printer.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-instax-bridge.mjs");
// The print agent runs `python -I instax-bridge.py`; the test runs the fake bridge with Node instead.
function printer(env = {}) {
  const printed = [];
  const instax = createInstaxPrinter({
    address: "88:B4:36:00:00:01",
    spawnProcess: (command, args, options) => {
      assert.deepEqual(args.slice(0, 1), ["-I"]);
      assert.equal(options.env.INSTAX_ADDRESS, "88:B4:36:00:00:01");
      const child = spawn(process.execPath, [fake], { ...options, env: { ...options.env, ...env } });
      child.stderr.on("data", (data) => printed.push(...data.toString().trim().split("\n").map((l) => l.slice(8))));
      return child;
    },
  });
  return { instax, printed };
}

test("an Instax job prints every piece in order and reports the film left", async () => {
  const { instax, printed } = printer({ FAKE_FILM: "5" });
  try {
    assert.deepEqual(await printInstaxJob(instax, ["a.jpg", "b.jpg"]), { printed: 2, film: 3 });
    assert.deepEqual(printed, ["a.jpg", "b.jpg"]);
    assert.deepEqual(await instaxStatus(instax), { connected: true, film: 3, battery: 80, charging: false, message: "" });
  } finally {
    instax.close();
  }
});

test("too little film refuses the whole job before anything prints", async () => {
  const { instax, printed } = printer({ FAKE_FILM: "1" });
  try {
    await assert.rejects(printInstaxJob(instax, ["a.jpg", "b.jpg"]), /còn 1 tấm phim, lệnh cần 2 tấm — thay phim rồi bấm In lại/);
    assert.deepEqual(printed, []);
  } finally {
    instax.close();
  }
});

test("an unconfirmed print stops the job and is never resent", async () => {
  const { instax, printed } = printer({ FAKE_FILM: "10", FAKE_MODE: "uncertain-2" });
  try {
    await assert.rejects(printInstaxJob(instax, ["a.jpg", "b.jpg", "c.jpg"]),
      /Đã in 1\/3 tấm\. Không xác nhận được tấm thứ 2 — xem khay máy Instax/);
    assert.deepEqual(printed, ["a.jpg"], "the third piece is not sent after an uncertain one");
  } finally {
    instax.close();
  }
});

test("an unreachable printer reports not connected instead of throwing", async () => {
  const { instax } = printer({ FAKE_MODE: "offline" });
  try {
    const status = await instaxStatus(instax);
    assert.equal(status.connected, false);
    assert.match(status.message, /Không kết nối được máy Instax — bật máy in, kiểm tra Bluetooth\. TransportError/);
    await assert.rejects(printInstaxJob(instax, ["a.jpg"]), /Không kết nối được máy Instax/);
  } finally {
    instax.close();
  }
});

test("a missing Python or bridge fails the request with a setup hint", async () => {
  const instax = createInstaxPrinter({ address: "x", python: path.join(path.dirname(fake), "no-such-python.exe") });
  await assert.rejects(instax.status(), /Chương trình in Instax đã dừng .*INSTAX_PYTHON/);
  instax.close();
});
