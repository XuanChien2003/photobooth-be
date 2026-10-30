"""Cầu nối print agent ↔ máy in Instax mini Link 3 (Bluetooth Classic, Windows 11).

Dùng thư viện nguồn mở instax-sdk (https://github.com/arahe-dev/instax-sdk, MIT), cài trong một
virtualenv riêng; print-agent.js chạy script này bằng python của virtualenv đó (INSTAX_PYTHON).
Giữ kết nối với máy in giữa các lệnh. Mỗi dòng stdin là một lệnh JSON, mỗi dòng stdout là một
trả lời JSON cùng "id":

  {"id": 1, "cmd": "status"}
    → {"id": 1, "ok": true, "connected": true, "film": 7, "battery": 80, "charging": false}
  {"id": 2, "cmd": "print", "file": "C:\\...\\0.jpg"}
    → {"id": 2, "ok": true, "outcome": "printed", "reason": "ok", "film": 6}
  {"id": 3, "cmd": "quit"}

outcome theo instax-sdk: printed (đã in, phim giảm 1), refused (chưa in — in lại được),
uncertain (đã gửi lệnh in nhưng không xác nhận — KHÔNG tự in lại). Lỗi kết nối trả ok: false.
"""

import asyncio
import inspect
import json
import os
import sys
import threading

from instax.client import InstaxPrinter
from instax.imaging import prepare_jpeg
from instax.rfcomm import RfcommTransport


def make_transport(address):
    return RfcommTransport(address)


async def maybe(value):
    return await value if inspect.isawaitable(value) else value


def text(value):
    return None if value is None else str(getattr(value, "value", value))


class Bridge:
    def __init__(self, address):
        self.address = address
        self.printer = None

    async def ensure(self):
        if self.printer is None:
            printer = InstaxPrinter(make_transport(self.address))
            await maybe(printer.connect())
            self.printer = printer
        else:
            await maybe(self.printer.ensure_connected())
        return self.printer

    async def drop(self):
        printer, self.printer = self.printer, None
        if printer is not None:
            try:
                await maybe(printer.close())
            except Exception:
                pass

    async def status(self):
        printer = await self.ensure()
        state = await maybe(printer.status())
        battery = None
        try:
            battery = (await maybe(printer.battery())).percent
        except Exception:
            battery = None
        return {
            "connected": True,
            "film": state.film_left,
            "battery": battery,
            "charging": bool(state.charging),
            "printState": state.print_state,
        }

    async def print(self, path):
        printer = await self.ensure()
        with open(path, "rb") as handle:
            data = handle.read()
        info = printer.info
        jpeg = prepare_jpeg(data, info.width, info.height, printer.max_jpeg_bytes,
                            flip_vertical=printer.profile.flip_vertical)
        outcome = await maybe(printer.print_jpeg(jpeg))
        return {
            "outcome": text(outcome.outcome),
            "reason": text(outcome.reason),
            "film": outcome.film_after,
        }

    async def handle(self, request):
        command = request.get("cmd")
        if command == "status":
            return await self.status()
        if command == "print":
            return await self.print(request["file"])
        raise ValueError(f"Lệnh không hợp lệ: {command}")


def reply(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


async def serve(address):
    loop = asyncio.get_running_loop()
    lines = asyncio.Queue()

    # Đọc stdin trong luồng riêng (Windows không có stdin bất đồng bộ cho asyncio).
    def read():
        for line in sys.stdin:
            loop.call_soon_threadsafe(lines.put_nowait, line)
        loop.call_soon_threadsafe(lines.put_nowait, None)

    threading.Thread(target=read, daemon=True).start()
    bridge = Bridge(address)
    try:
        while True:
            line = await lines.get()
            if line is None:
                return
            if not line.strip():
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue
            if request.get("cmd") == "quit":
                return
            try:
                reply({"id": request.get("id"), "ok": True, **await bridge.handle(request)})
            except Exception as error:  # mất Bluetooth, máy tắt, sai địa chỉ…
                await bridge.drop()
                reply({"id": request.get("id"), "ok": False, "connected": False,
                       "error": f"{type(error).__name__}: {error}"[:300]})
    finally:
        await bridge.drop()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    address = os.environ.get("INSTAX_ADDRESS", "").strip()
    if not address:
        reply({"id": None, "ok": False, "error": "Thiếu INSTAX_ADDRESS (địa chỉ Bluetooth Classic của máy Instax)."})
        return 2
    asyncio.run(serve(address))
    return 0


if __name__ == "__main__":
    sys.exit(main())
