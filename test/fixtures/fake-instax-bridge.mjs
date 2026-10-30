// Máy Instax giả cho test: nói cùng giao thức JSON từng dòng với scripts/instax-bridge.py.
// FAKE_FILM: số tấm phim; FAKE_MODE: "offline" (không kết nối) | "uncertain-2" (tấm thứ 2 không
// xác nhận) | "silent" (không trả lời). Mỗi lần in ghi một dòng "printed <file>" ra stderr.
import readline from "node:readline";

let film = Number(process.env.FAKE_FILM ?? 10);
let prints = 0;
const mode = process.env.FAKE_MODE || "";
const reply = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.cmd === "quit") process.exit(0);
  if (mode === "silent") return;
  if (mode === "offline")
    return reply({ id: request.id, ok: false, connected: false, error: "TransportError: printer unreachable" });
  if (request.cmd === "status")
    return reply({ id: request.id, ok: true, connected: true, film, battery: 80, charging: false });
  if (request.cmd === "print") {
    prints++;
    if (mode === "uncertain-2" && prints === 2)
      return reply({ id: request.id, ok: true, outcome: "uncertain", reason: "not_confirmed", film });
    if (!film) return reply({ id: request.id, ok: true, outcome: "refused", reason: "no_film", film });
    film--;
    process.stderr.write(`printed ${request.file}\n`);
    return reply({ id: request.id, ok: true, outcome: "printed", reason: "ok", film });
  }
});
