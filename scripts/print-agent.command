#!/bin/bash
# Chương trình in tự động tại quầy (macOS): nhận lệnh in từ web và in ra máy DNP DS-RX1.
# Cần Node.js 20+ và driver DNP DS-RX1 cho Mac (máy in đã thêm trong Cài đặt hệ thống → Máy in & Máy quét).
# Điền PRINT_AGENT_API_URL, PRINT_AGENT_BRANCH, PRINT_AGENT_TOKEN, DNP_PRINTER_NAME (và DNP_STRIP_PRINTER_NAME)
# vào file .env của thư mục photobooth-be (xem .env.example). Bấm đúp file này trong Finder; muốn tự chạy khi bật
# máy: Cài đặt hệ thống → Cài đặt chung → Mục đăng nhập → bấm + và chọn file này.
cd "$(dirname "$0")/.." || exit 1
[ -d node_modules ] || npm install --omit=dev
while true; do
  node scripts/print-agent.js
  echo "Chương trình in đã dừng - tự chạy lại sau 5 giây..."
  sleep 5
done
