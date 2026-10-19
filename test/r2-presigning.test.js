import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { r2Storage } from "../src/services/r2.js";

test("real SDK signs a single R2 GET locally with bounded TTL and print response headers", async () => {
  config.r2 = { accountId: "a".repeat(32), bucket: "test-media", prefix: "media/",
    accessKeyId: "test-only-access", secretAccessKey: "test-only-secret" };
  const url = new URL(await r2Storage.signedGet("r2:media/native-print.png", 123, {
    ResponseContentType: "image/png", ResponseCacheControl: "private, max-age=123",
    ResponseContentDisposition: 'attachment; filename="print.png"',
  }));
  assert.equal(url.protocol, "https:");
  assert.ok(url.hostname.endsWith(".r2.cloudflarestorage.com"));
  assert.ok(url.pathname.endsWith("/media/native-print.png"));
  assert.equal(url.searchParams.get("X-Amz-Expires"), "123");
  assert.ok(url.searchParams.get("X-Amz-Signature"));
  assert.equal(url.searchParams.get("response-content-type"), "image/png");
  assert.equal(url.searchParams.get("response-cache-control"), "private, max-age=123");
  assert.equal(url.searchParams.get("response-content-disposition"), 'attachment; filename="print.png"');
});

test("links signed in the same window are identical, so browsers can reuse cached images", async () => {
  config.r2 = { accountId: "a".repeat(32), bucket: "test-media", prefix: "media/",
    accessKeyId: "test-only-access", secretAccessKey: "test-only-secret" };
  const windowStart = new Date(Math.floor(Date.now() / 120000) * 120000);
  const sign = () => r2Storage.signedGet("r2:media/thumb.jpg", 300,
    { ResponseContentType: "image/jpeg", ResponseCacheControl: "private, max-age=300" }, windowStart);
  const [first, second] = [await sign(), await sign()];
  assert.equal(first, second);
  const url = new URL(first);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(url.searchParams.get("X-Amz-Date"),
    windowStart.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""));
});

test("the fast signer produces exactly the SDK's presigned URL", async () => {
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  config.r2 = { accountId: "0123456789ABCDEF0123456789abcdef", bucket: "test-media", prefix: "media/",
    accessKeyId: "test-only-access", secretAccessKey: "test/only+secret" };
  const keys = ["media/a.jpg", "media/abc def+ü.jpg", "media/x(1)!*'.thumb.jpg", "media/ảnh~_-.preview.jpg"];
  const responses = [{}, { ResponseContentType: "image/jpeg", ResponseCacheControl: "private, max-age=300" },
    { ResponseContentType: "image/png", ResponseCacheControl: "private, max-age=12",
      ResponseContentDisposition: 'attachment; filename="NXC-12-to-01.png"' }];
  for (const key of keys)
    for (const response of responses)
      for (const date of [new Date("2026-10-17T05:20:00Z"), new Date("2026-12-31T23:59:59.999Z")]) {
        const sdk = await getSignedUrl(r2Storage.client(), new GetObjectCommand({
          Bucket: config.r2.bucket, Key: key, ...response }), { expiresIn: 300, signingDate: date });
        assert.equal(await r2Storage.signedGet("r2:" + key, 300, response, date), sdk);
      }
});
