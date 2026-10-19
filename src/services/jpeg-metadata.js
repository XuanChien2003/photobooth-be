// Remove private JPEG metadata without decoding/re-encoding its pixels. Keep
// the colour profile and only the EXIF orientation needed by image decoders.
export function cleanJpegMetadata(buffer, orientation) {
  if (buffer.readUInt16BE(0) !== 0xffd8) throw new Error("Invalid JPEG");
  const parts = [buffer.subarray(0, 2)];
  if (orientation >= 2 && orientation <= 8) {
    const exif = Buffer.from("ffe1002245786966000049492a0008000000010012010300010000000100000000000000", "hex");
    exif.writeUInt16LE(orientation, 28);
    parts.push(exif);
  }
  let at = 2;
  let changed = orientation >= 2 && orientation <= 8;
  let ended = false;
  while (at < buffer.length) {
    const start = at;
    if (buffer[at++] !== 0xff) throw new Error("Invalid JPEG marker");
    while (buffer[at] === 0xff) at++;
    const marker = buffer[at++];
    if (marker === 0xd9) {
      parts.push(buffer.subarray(start, at));
      ended = true;
      if (at !== buffer.length) changed = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(buffer.subarray(start, at)); continue;
    }
    if (at + 2 > buffer.length) throw new Error("Incomplete JPEG");
    const length = buffer.readUInt16BE(at), end = at + length;
    if (length < 2 || end > buffer.length) throw new Error("Incomplete JPEG segment");
    const app = marker >= 0xe0 && marker <= 0xef;
    const icc = marker === 0xe2 && buffer.toString("ascii", at + 2, at + 14) === "ICC_PROFILE\0";
    const jfif = marker === 0xe0 && buffer.toString("ascii", at + 2, at + 7) === "JFIF\0";
    // Adobe APP14 specifies RGB/YCbCr/YCCK interpretation; stripping it can
    // change decoded colours even though the compressed scan is untouched.
    const adobe = marker === 0xee && length === 14 && buffer.toString("ascii", at + 2, at + 7) === "Adobe";
    if ((!app && marker !== 0xfe) || icc || jfif || adobe) parts.push(buffer.subarray(start, end));
    else changed = true;
    at = end;
    if (marker === 0xda) {
      const entropy = at;
      while (at < buffer.length) {
        if (buffer[at] !== 0xff) { at++; continue; }
        let next = at + 1;
        while (buffer[next] === 0xff) next++;
        const code = buffer[next];
        if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) { at = next + 1; continue; }
        break;
      }
      parts.push(buffer.subarray(entropy, at));
    }
  }
  if (!ended) throw new Error("Incomplete JPEG");
  return changed ? Buffer.concat(parts) : buffer;
}

// The header of a camera JPEG the booth cleaned itself (same rules as cleanJpegMetadata) before
// uploading it straight to storage: up to the first scan there may only be JFIF, the colour
// profile, Adobe colour info and the minimal orientation EXIF this file writes. Returns false
// for anything else, or when the header does not fit in the bytes read.
const MINIMAL_EXIF = Buffer.from("ffe1002245786966000049492a0008000000010012010300010000000100000000000000", "hex");
export function isCleanJpegHeader(head) {
  if (head.length < 4 || head.readUInt16BE(0) !== 0xffd8) return false;
  let at = 2;
  while (at + 4 <= head.length) {
    if (head[at] !== 0xff) return false;
    let next = at + 1;
    while (head[next] === 0xff) next++;
    const marker = head[next];
    const start = next + 1;
    if (start + 2 > head.length) return false;
    const length = head.readUInt16BE(start), end = start + length;
    if (length < 2 || end > head.length) return false;
    if (marker === 0xda) return true; // first scan: everything before it was checked
    const app = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xfe) return false;
    if (app) {
      const icc = marker === 0xe2 && head.toString("ascii", start + 2, start + 14) === "ICC_PROFILE\0";
      const jfif = marker === 0xe0 && head.toString("ascii", start + 2, start + 7) === "JFIF\0";
      const adobe = marker === 0xee && length === 14 && head.toString("ascii", start + 2, start + 7) === "Adobe";
      const orientation = marker === 0xe1 && end - at === MINIMAL_EXIF.length &&
        head.subarray(at, at + 28).equals(MINIMAL_EXIF.subarray(0, 28)) &&
        head.subarray(at + 30, end).equals(MINIMAL_EXIF.subarray(30));
      if (!icc && !jfif && !adobe && !orientation) return false;
    }
    at = end;
  }
  return false;
}
