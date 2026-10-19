import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { cleanJpegMetadata } from "../src/services/jpeg-metadata.js";
import { prepareImages } from "../src/services/capture.js";

const width = 173, height = 117;
const raw = Buffer.alloc(width * height * 3);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    raw[offset] = (x * 13 + y * 3) % 256;
    raw[offset + 1] = (x * 2 + y * 11) % 256;
    raw[offset + 2] = x < width / 3 ? 240 : (y * 7) % 256;
  }
const image = () => sharp(raw, { raw: { width, height, channels: 3 } });
const decode = (buffer, upright = false) => {
  const input = sharp(buffer);
  return (upright ? input.rotate() : input).raw().toBuffer();
};
const segment = (marker, payload) => {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
};
const inject = (jpeg, ...segments) =>
  Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
const privateExif = {
  IFD0: { Copyright: "private copyright", Artist: "private photographer" },
  IFD3: {
    GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 123/100",
    GPSLongitudeRef: "E", GPSLongitude: "10/1 20/1 30/1",
  },
};

for (const progressive of [false, true]) {
  test(`JPEG ${progressive ? "progressive" : "baseline"}: stripping private headers leaves every compressed scan and decoded pixel unchanged`, async () => {
    const original = await image().jpeg({ quality: 96, progressive }).toBuffer();
    const tagged = inject(original,
      segment(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0private xmp")),
      segment(0xed, Buffer.from("Photoshop 3.0\0private iptc")),
      segment(0xe3, Buffer.from("private custom application data")),
      segment(0xfe, Buffer.from("private comment")),
    );
    const cleaned = cleanJpegMetadata(tagged);
    assert.deepEqual(cleaned, original, "all original coding tables, scans and entropy bytes survive exactly");
    assert.deepEqual(await decode(cleaned), await decode(tagged));
    assert.equal((await sharp(cleaned).metadata()).isProgressive, progressive);
  });
}

test("progressive JPEG metadata between scans and after the final scan is removed without touching entropy", async () => {
  const original = await image().jpeg({ quality: 96, progressive: true }).toBuffer();
  const firstScan = original.indexOf(Buffer.from([0xff, 0xda]));
  const secondScan = original.indexOf(Buffer.from([0xff, 0xda]), firstScan + 2);
  assert.ok(secondScan > firstScan, "fixture uses multiple progressive scans");
  const privateComment = segment(0xfe, Buffer.from("private comment between scans"));
  const tagged = Buffer.concat([
    original.subarray(0, secondScan), privateComment,
    original.subarray(secondScan, original.length - 2), privateComment,
    original.subarray(original.length - 2),
  ]);
  const cleaned = cleanJpegMetadata(tagged);
  assert.deepEqual(cleaned, original);
  assert.deepEqual(await decode(cleaned), await decode(tagged));
});

test("Adobe APP14 colour interpretation survives removal of private EXIF", async () => {
  const original = await image().withExif(privateExif).jpeg({ quality: 96 }).toBuffer();
  const adobeRgb = segment(0xee, Buffer.from("41646f626500640000000000", "hex"));
  const tagged = inject(original, adobeRgb);
  const prepared = await prepareImages(tagged);
  assert.ok(prepared.jpeg.includes(adobeRgb), "APP14 is required to interpret JPEG colour components");
  assert.equal((await sharp(prepared.jpeg).metadata()).exif, undefined);
  assert.deepEqual(await decode(prepared.jpeg), await decode(tagged), "removing private metadata must not change the interpreted colours");
});

for (let orientation = 1; orientation <= 8; orientation++) {
  test(`JPEG orientation ${orientation}: original pixels and colour profile survive; thumbnails display upright and mirror once`, async () => {
    const original = await image()
      .withMetadata({ orientation })
      .withExifMerge(privateExif)
      .jpeg({ quality: 96, progressive: orientation % 2 === 0 })
      .toBuffer();
    const originalMeta = await sharp(original).metadata();
    assert.ok(originalMeta.icc?.length, "fixture contains a real ICC colour profile");
    assert.ok(originalMeta.exif.includes(Buffer.from("private copyright")));
    for (const mirrored of [false, true]) {
      const prepared = await prepareImages(original, mirrored);
      const meta = await sharp(prepared.jpeg).metadata();
      assert.deepEqual([meta.width, meta.height], [width, height], "source is not resampled or reoriented destructively");
      assert.equal(meta.orientation, orientation === 1 ? undefined : orientation);
      assert.deepEqual(meta.icc, originalMeta.icc, "original ICC profile is retained byte for byte");
      assert.deepEqual(await decode(prepared.jpeg), await decode(original), "sensor-orientation decoded pixels are identical");
      assert.deepEqual(await decode(prepared.jpeg, true), await decode(original, true), "upright decoded pixels are identical too");
      assert.equal(meta.xmp, undefined);
      assert.equal(meta.iptc, undefined);
      if (orientation === 1) assert.equal(meta.exif, undefined);
      else {
        assert.equal(meta.exif.length, 32, "only the minimal orientation EXIF block survives");
        assert.equal(meta.exif.readUInt16LE(16), 0x0112, "the sole IFD entry is orientation");
      }
      assert.equal(prepared.jpeg.includes(Buffer.from("private copyright")), false);
      assert.equal(prepared.jpeg.includes(Buffer.from("private photographer")), false);
      const expectedThumb = await sharp(original).rotate().flop(mirrored)
        .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 78 }).toBuffer();
      assert.deepEqual(prepared.thumbnail, expectedThumb);
      const thumbnailMeta = await sharp(prepared.thumbnail).metadata();
      assert.deepEqual([thumbnailMeta.width, thumbnailMeta.height], orientation >= 5 ? [height, width] : [width, height]);
      assert.equal(thumbnailMeta.exif, undefined);
    }
  });
}

test("JPEG sanitizing keeps multipart ICC chunks, JFIF density and restart/fill markers intact", async () => {
  const original = await image().jpeg({ quality: 96 }).toBuffer();
  const jfif = segment(0xe0, Buffer.from("4a46494600010101012c012c0000", "hex"));
  // ICC chunks are kept verbatim without interpreting or recompressing them.
  const icc1 = segment(0xe2, Buffer.concat([Buffer.from("ICC_PROFILE\0"), Buffer.from([1, 2]), Buffer.from("profile first half")]));
  const icc2 = segment(0xe2, Buffer.concat([Buffer.from("ICC_PROFILE\0"), Buffer.from([2, 2]), Buffer.from("profile second half")]));
  const tagged = inject(original, jfif, icc1, segment(0xfe, Buffer.from("private comment")), icc2);
  assert.deepEqual(cleanJpegMetadata(tagged), inject(original, jfif, icc1, icc2));
  const withFill = Buffer.concat([original.subarray(0, 2), Buffer.from([0xff]), original.subarray(2)]);
  assert.deepEqual(cleanJpegMetadata(withFill), withFill);
  const withStandalone = inject(original, Buffer.from([0xff, 0x01, 0xff, 0xd0]));
  assert.deepEqual(cleanJpegMetadata(withStandalone), withStandalone);
});

test("malformed JPEG marker lengths are rejected and full capture decoding rejects damaged compressed scans", async () => {
  for (const malformed of [
    Buffer.from([]), Buffer.from([0xff]), Buffer.from([0, 0]),
    Buffer.from([0xff, 0xd8, 0x11]),
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 1]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 20, 1, 2]),
  ]) assert.throws(() => cleanJpegMetadata(malformed));
  const valid = await image().jpeg({ quality: 96 }).toBuffer();
  await assert.rejects(prepareImages(valid.subarray(0, Math.floor(valid.length / 2))));
  await assert.rejects(prepareImages(Buffer.from("not an image")));
});

test("clean source JPEGs keep their original byte buffer, dimensions and quality while thumbnails remain separate", async () => {
  const original = await image().jpeg({ quality: 98, chromaSubsampling: "4:4:4" }).toBuffer();
  const prepared = await prepareImages(original, true);
  assert.equal(prepared.jpeg, original);
  assert.deepEqual(await decode(prepared.jpeg), await decode(original));
  assert.notDeepEqual(prepared.thumbnail, original);
  const meta = await sharp(prepared.jpeg).metadata();
  assert.deepEqual([meta.width, meta.height], [width, height]);
});

test("COM-only and unknown APP metadata plus trailing bytes are stripped on the capture path", async () => {
  const original = await image().jpeg({ quality: 96 }).toBuffer();
  const tagged = Buffer.concat([
    inject(original,
      segment(0xfe, Buffer.from("private comment")),
      segment(0xe3, Buffer.from("private application data")),
    ),
    Buffer.from("private data after JPEG end"),
  ]);
  const prepared = await prepareImages(tagged);
  assert.deepEqual(prepared.jpeg, original);
  assert.deepEqual(await decode(prepared.jpeg), await decode(original));
});
