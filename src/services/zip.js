import zlib from "node:zlib";

// Tạo file ZIP (không nén — ảnh JPEG vốn đã nén) để khách tải toàn bộ ảnh gốc một lần.
const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

// Node's built-in CRC-32 (Node 20.15+/22.2+) is ~8x faster than this loop: about 1 s less CPU
// per 15 MB photo on the free server's tenth of a CPU. The loop stays for older Node versions.
export function crc32(buffer) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buffer);
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Ảnh gốc ~15 MB: từ khoảng 270 ảnh trở lên vị trí tệp vượt 4 GB, giới hạn của ZIP thường. Khi đó
// mục danh mục ghi vị trí 64 bit (ZIP64) để tệp tải về vẫn mở được; album nhỏ giữ đúng ZIP cũ.
const ZIP64 = 0xffffffff;

function dosTime(date) {
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date:
      ((date.getFullYear() - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

// Phần đầu của một tệp trong ZIP (local header) và mục tương ứng trong danh mục cuối (central).
// Mỗi ảnh nhỏ hơn 4 GB nên chỉ vị trí tệp có thể cần trường ZIP64 (extra 0x0001).
function entryHeaders(name, data, offset, { time, date }, zip64From = ZIP64) {
  const far = offset >= zip64From;
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // tên file UTF-8
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46 + (far ? 12 : 0));
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(far ? 45 : 20, 4);
  central.writeUInt16LE(far ? 45 : 20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(far ? 12 : 0, 30);
  central.writeUInt32LE(far ? ZIP64 : offset, 42);
  // Trường mở rộng nằm sau tên tệp trong danh mục: tách riêng để ghi theo thứ tự đó.
  let extra = Buffer.alloc(0);
  if (far) {
    extra = Buffer.alloc(12);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(8, 2);
    extra.writeBigUInt64LE(BigInt(offset), 4);
  }
  return { nameBuf, local, central: central.subarray(0, 46), extra,
    size: 30 + nameBuf.length + data.length };
}

function endOfArchive(count, centralSize, offset, zip64From = ZIP64) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const large = offset >= zip64From || centralSize >= zip64From || count >= 0xffff;
  // Like Python zipfile: only a value that does not fit becomes the ZIP64 marker.
  end.writeUInt16LE(Math.min(count, 0xffff), 8);
  end.writeUInt16LE(Math.min(count, 0xffff), 10);
  end.writeUInt32LE(centralSize >= zip64From ? ZIP64 : centralSize, 12);
  end.writeUInt32LE(offset >= zip64From ? ZIP64 : offset, 16);
  if (!large) return end;
  // Bản ghi kết thúc ZIP64 (56 byte) + bộ định vị (20 byte) đứng ngay trước bản ghi kết thúc thường.
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(centralSize), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + centralSize), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([record, locator, end]);
}

// Chờ luồng ghi xả bớt hàng đợi; false nếu người tải đã ngắt kết nối giữa chừng.
const drained = (out) =>
  new Promise((resolve) => {
    if (out.destroyed) return resolve(false);
    const finish = (ok) => {
      out.off("drain", onDrain);
      out.off("close", onClose);
      out.off("error", onClose);
      resolve(ok);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    out.once("drain", onDrain).once("close", onClose).once("error", onClose);
  });

// Gửi ZIP làm tệp tải về, ghi dần từng tệp: bộ nhớ chỉ giữ một ảnh và danh mục tệp thay vì gom
// cả album (hàng chục MB mỗi lượt tải) — máy chủ miễn phí chỉ có 512 MB RAM.
// files: iterable (có thể bất đồng bộ) của { name, data: Buffer }. Trả false, chưa ghi gì, nếu
// không có tệp nào để người gọi báo lỗi 404; khi đã bắt đầu ghi mà lỗi thì ngắt kết nối để trình
// duyệt báo tải lỗi thay vì lưu một ZIP cụt trông như hợp lệ.
// zip64From: chỉ để test ép định dạng ZIP64 với tệp nhỏ.
export async function sendZip(res, filename, files, now = new Date(), { zip64From = ZIP64 } = {}) {
  const iterator = files[Symbol.asyncIterator]
    ? files[Symbol.asyncIterator]()
    : files[Symbol.iterator]();
  let next = await iterator.next();
  if (next.done) return false;
  res.set("Cache-Control", "private, no-store");
  res.attachment(filename);
  res.type("application/zip");
  const stamp = dosTime(now);
  const centrals = [];
  let offset = 0;
  let count = 0;
  const write = async (chunk) =>
    !res.destroyed && (res.write(chunk) || (await drained(res)));
  try {
    while (!next.done) {
      const { name, data } = next.value;
      const entry = entryHeaders(name, data, offset, stamp, zip64From);
      for (const part of [entry.local, entry.nameBuf, data])
        if (!(await write(part))) return true;
      centrals.push(entry.central, entry.nameBuf, entry.extra);
      offset += entry.size;
      count++;
      next = await iterator.next();
    }
  } finally {
    // Dừng sớm (khách đóng trang / lỗi): để bộ sinh tệp dọn dẹp, không đọc tiếp ảnh còn lại.
    if (!next.done) await iterator.return?.();
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  res.end(
    Buffer.concat([...centrals, endOfArchive(count, centralSize, offset, zip64From)]),
  );
  return true;
}
