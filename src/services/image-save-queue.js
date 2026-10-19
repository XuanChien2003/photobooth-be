// Bound large image processing/writes across all booths and phone imports on
// the existing small server. Each booth can overlap uploads without running
// six full-resolution decoders/writes at once.
const waiting = [];
let active = 0;
const MAX_SAVES = 3;

// True while any photo is being saved or waits to be: background work yields to it.
export const isSaveQueueBusy = () => active > 0 || waiting.length > 0;

// Thời gian một ảnh chờ + xử lý + lưu, để trả về header Server-Timing (xem ở tab Network của
// trình duyệt hoặc trong chẩn đoán máy chụp): biết ảnh lưu chậm ở khâu nào.
export const timed = async (res, name, promise) => {
  const started = performance.now();
  try {
    return await promise;
  } finally {
    const ms = (performance.now() - started).toFixed(0);
    const previous = res.getHeader("Server-Timing");
    res.set("Server-Timing", [previous, `${name};dur=${ms}`].filter(Boolean).join(", "));
  }
};

export async function saveImageTask(action) {
  if (active >= MAX_SAVES) await new Promise(resolve => waiting.push(resolve));
  else active++;
  try {
    return await action();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
