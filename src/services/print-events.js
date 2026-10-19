import { EventEmitter } from "node:events";

// Phát sự kiện "có lệnh in mới" tới các màn hình quản trị đang mở (Server-Sent Events).
export const printEvents = new EventEmitter();
printEvents.setMaxListeners(200);
