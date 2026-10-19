import crypto from "node:crypto";

// AWS Signature V4 query signing for one R2 GetObject, producing exactly the URL the AWS SDK's
// getSignedUrl makes (test/r2-presigning.test.js compares them). The SDK path costs ~0.4 ms of
// CPU per link; this is plain HMAC (~0.05 ms), so an album can hand out links for every photo
// in one request on the free server's tenth of a CPU.
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
// RFC 3986: encodeURIComponent leaves !'()* alone, SigV4 encodes them.
const encode = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

let cachedKey = { id: "", key: null };
function signingKey(secret, date) {
  const id = `${date}|${secret}`;
  if (cachedKey.id !== id) {
    const kDate = hmac("AWS4" + secret, date);
    cachedKey = { id, key: hmac(hmac(hmac(kDate, "auto"), "s3"), "aws4_request") };
  }
  return cachedKey.key;
}

// response: { ResponseCacheControl, ResponseContentDisposition, ResponseContentType } as for the SDK.
export function presignGetObject(
  { accountId, bucket, accessKeyId, secretAccessKey },
  key,
  expiresIn,
  response = {},
  signingDate = new Date(),
) {
  const amzDate = signingDate.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/auto/s3/aws4_request`;
  const host = `${bucket}.${accountId}.r2.cloudflarestorage.com`.toLowerCase();
  const path = "/" + key.split("/").map(encode).join("/");
  const params = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"],
    ["X-Amz-Credential", `${accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresIn)],
    ["X-Amz-SignedHeaders", "host"],
    ["response-cache-control", response.ResponseCacheControl],
    ["response-content-disposition", response.ResponseContentDisposition],
    ["response-content-type", response.ResponseContentType],
    ["x-id", "GetObject"],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  const query = (list) => list
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = ["GET", path, query(params), `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signature = hmac(signingKey(secretAccessKey, date), toSign).toString("hex");
  return `https://${host}${path}?${query([...params, ["X-Amz-Signature", signature]])}`;
}
