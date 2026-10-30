import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "instax-bridge.py");
// Một tấm: tải ảnh ~2 giây + máy chiếu sáng và đẩy phim ~15 giây; chờ rộng tay khi Bluetooth chậm.
const PRINT_TIMEOUT_MS = 180_000;
const STATUS_TIMEOUT_MS = 45_000;

const REASONS = {
  no_film: "Máy Instax hết phim.",
  busy: "Máy Instax đang bận in tấm khác.",
  printer_error: "Máy Instax báo lỗi — kiểm tra nắp hộp phim.",
  printer_stuck: "Máy Instax bị kẹt — tắt mở lại máy in.",
  disconnected: "Mất kết nối Bluetooth với máy Instax.",
  timeout: "Máy Instax không trả lời.",
  no_reply: "Máy Instax không trả lời.",
  rejected: "Máy Instax không nhận ảnh.",
  not_prepared: "Ảnh chưa tải lên máy Instax.",
  not_confirmed: "Máy Instax không xác nhận đã in.",
};

// Chạy instax-bridge.py (instax-sdk trong virtualenv riêng) một lần và giữ kết nối với máy in.
// Lệnh và trả lời là JSON từng dòng; chương trình dừng thì lần gọi sau tự chạy lại.
export function createInstaxPrinter({ address, python = "python", script = BRIDGE, spawnProcess = spawn }) {
  let child = null;
  let next = 1;
  let lastError = "";
  const waiting = new Map();
  const failAll = (error) => {
    for (const { reject, timer } of waiting.values()) {
      clearTimeout(timer);
      reject(error);
    }
    waiting.clear();
  };
  function start() {
    const proc = spawnProcess(python, ["-I", script], {
      env: { ...process.env, INSTAX_ADDRESS: address },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = proc;
    // Không tìm thấy python / chương trình vừa dừng: lỗi báo qua "error" / "exit" bên dưới.
    proc.stdin.on("error", () => {});
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === null && message.error) lastError = message.error;
      const entry = waiting.get(message.id);
      if (!entry) return;
      waiting.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    });
    proc.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) lastError = text.split("\n").at(-1).slice(0, 300);
    });
    const stopped = (reason) => {
      if (child === proc) child = null;
      failAll(new Error(`Chương trình in Instax đã dừng (${reason})${lastError ? `: ${lastError}` : ""}. Kiểm tra INSTAX_PYTHON và instax-sdk.`));
    };
    proc.on("error", (error) => stopped(error.message));
    proc.on("exit", (code) => stopped(`mã ${code}`));
  }
  function request(cmd, extra, timeout) {
    if (!child) start();
    const proc = child;
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        // Không biết máy in đang ở bước nào: dừng hẳn, lần sau kết nối lại từ đầu.
        proc.kill();
        reject(new Error("Máy Instax không trả lời."));
      }, timeout);
      waiting.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ id, cmd, ...extra }) + "\n");
    });
  }
  return {
    status: () => request("status", {}, STATUS_TIMEOUT_MS),
    print: (file) => request("print", { file }, PRINT_TIMEOUT_MS),
    close() {
      const proc = child;
      child = null;
      if (!proc) return;
      proc.stdin.end(JSON.stringify({ cmd: "quit" }) + "\n");
      setTimeout(() => proc.kill(), 3000).unref();
    },
  };
}

// Tình trạng gửi lên máy chủ (máy chụp chỉ bán khổ Instax khi máy in sẵn sàng).
export async function instaxStatus(printer) {
  try {
    const status = await printer.status();
    if (!status.ok) return { connected: false, film: null, battery: null, charging: false, message: friendly(status.error) };
    return {
      connected: true,
      film: Number.isInteger(status.film) ? status.film : null,
      battery: Number.isInteger(status.battery) ? Math.max(0, Math.min(100, status.battery)) : null,
      charging: Boolean(status.charging),
      message: "",
    };
  } catch (error) {
    return { connected: false, film: null, battery: null, charging: false, message: friendly(error.message) };
  }
}
const friendly = (error = "") =>
  `Không kết nối được máy Instax — bật máy in, kiểm tra Bluetooth. ${error}`.trim().slice(0, 300);

// In các tấm của một lệnh: kiểm tra đủ phim trước tấm đầu (hết phim giữa chừng thì phải in lại cả
// lệnh). Tấm nào không chắc đã in (uncertain) thì dừng, không tự in lại — tránh in trùng.
export async function printInstaxJob(printer, files) {
  const status = await printer.status();
  if (!status.ok)
    throw new Error(friendly(status.error));
  if (Number.isInteger(status.film) && status.film < files.length)
    throw new Error(status.film
      ? `Máy Instax còn ${status.film} tấm phim, lệnh cần ${files.length} tấm — thay phim rồi bấm In lại.`
      : "Máy Instax hết phim — thay phim rồi bấm In lại.");
  let printed = 0;
  let film = status.film;
  for (const file of files) {
    const result = await printer.print(file);
    if (result.ok && result.outcome === "printed") {
      printed++;
      if (Number.isInteger(result.film)) film = result.film;
      continue;
    }
    const done = printed ? `Đã in ${printed}/${files.length} tấm. ` : "";
    if (!result.ok || result.outcome === "uncertain")
      throw new Error(`${done}Không xác nhận được tấm thứ ${printed + 1} — xem khay máy Instax trước khi in lại.`);
    throw new Error(`${done}${REASONS[result.reason] || "Máy Instax từ chối in."}`);
  }
  return { printed, film };
}
