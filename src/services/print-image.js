import sharp from "sharp";

export const printExtension = (file) => /\.png$/i.test(file) ? "png" : "jpg";
export const printContentType = (file) => printExtension(file) === "png" ? "image/png" : "image/jpeg";

// Saved attempts from older kiosks contain 10×15 cm JPEG sheets. New clients
// send 4×6 inch PNG sheets; validate both without changing their bytes/pixels.
// An Instax mini print is one 600 × 800 px image (the mini Link 3 exposes 800 × 600 dots).
export async function validatePrintImage(buffer, contentType, printSize = "full") {
  const input = sharp(buffer, { failOn: "warning", limitInputPixels: 5_000_000 });
  const metadata = await input.metadata();
  const { width, height, format } = metadata;
  if ((format !== "png" && format !== "jpeg") ||
      contentType !== `image/${format}` ||
      (metadata.pages || 1) !== 1 ||
      (metadata.orientation && metadata.orientation !== 1))
    throw new Error("Ảnh in phải là PNG hoặc JPEG một trang, không xoay bằng metadata.");
  const short = Math.min(width, height), long = Math.max(width, height);
  if (printSize === "instax") {
    if (width !== 600 || height !== 800)
      throw new Error("Tấm Instax phải là ảnh dọc 600 × 800 px.");
  } else if (!((short === 1200 && long === 1800) || (short === 1181 && long === 1772)))
    throw new Error("Tờ ảnh phải là 1200 × 1800 px hoặc 1181 × 1772 px (dọc hoặc ngang).");
  // Reading just metadata accepts a valid header with missing/corrupt pixel data.
  await input.raw().toBuffer();
  return { width, height, extension: format === "png" ? "png" : "jpg" };
}
