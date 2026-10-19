import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";
import { presignGetObject } from "./r2-presign.js";

const signedLinks = new Map();
const MAX_SIGNED_LINKS = 3000;

export const R2_REF = "r2:";
export const BYTES_PER_GB = 1_000_000_000;
export const isR2File = (file) =>
  typeof file === "string" && file.startsWith(R2_REF);
export const r2Configured = () =>
  Boolean(
    config.r2.accountId &&
    config.r2.accessKeyId &&
    config.r2.secretAccessKey &&
    config.r2.bucket,
  );

export function validateR2Config() {
  if (!r2Configured())
    throw new Error(
      "R2 chưa cấu hình đủ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY và R2_BUCKET.",
    );
  if (!/^[a-f0-9]{32}$/i.test(config.r2.accountId))
    throw new Error("R2_ACCOUNT_ID không hợp lệ.");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.r2.bucket))
    throw new Error("R2_BUCKET không hợp lệ.");
  if (
    !config.r2.prefix ||
    config.r2.prefix.startsWith("/") ||
    config.r2.prefix.includes("\\") ||
    config.r2.prefix.split("/").includes("..")
  )
    throw new Error("R2_PREFIX không hợp lệ.");
}

export function validateMediaStorage() {
  if (!["gridfs", "r2"].includes(config.mediaStorageProvider))
    throw new Error("MEDIA_STORAGE_PROVIDER phải là gridfs hoặc r2.");
  if (config.mediaStorageProvider === "r2") validateR2Config();
}

export function mediaReference(file) {
  validateMediaStorage();
  if (isR2File(file) || config.mediaStorageProvider === "gridfs") return file;
  const prefix = config.r2.prefix.replace(/\/?$/, "/");
  return `${R2_REF}${prefix}${file}`;
}

const missing = (error) =>
  error?.$metadata?.httpStatusCode === 404 ||
  ["NoSuchKey", "NotFound"].includes(error?.name);
let cachedClient;
let clientSignature;
let inventoryCache;
let pendingInventory;
let generation = 0;
export function invalidateR2Inventory() {
  generation++;
  inventoryCache = undefined;
}

// One SDK client per configuration. This object also lets tests supply an S3
// transport without real credentials, a production account, or network writes.
export const r2Storage = {
  client() {
    validateR2Config();
    const signature = JSON.stringify(config.r2);
    if (signature !== clientSignature) {
      cachedClient?.destroy();
      cachedClient = new S3Client({
        region: "auto",
        endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: config.r2.accessKeyId,
          secretAccessKey: config.r2.secretAccessKey,
        },
        maxAttempts: 2,
        requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
      clientSignature = signature;
      invalidateR2Inventory();
    }
    return cachedClient;
  },
  async send(Command, file, options = {}, sendOptions) {
    return this.client().send(
      new Command({
        Bucket: config.r2.bucket,
        ...(file && { Key: file.slice(R2_REF.length) }),
        ...options,
      }),
      sendOptions,
    );
  },
  async save(file, buffer, contentType) {
    invalidateR2Inventory();
    try {
      await this.send(PutObjectCommand, file, {
        Body: buffer,
        ContentType: contentType,
        ContentLength: buffer.length,
      });
    } finally {
      invalidateR2Inventory();
    }
  },
  async head(file) {
    try {
      return await this.send(HeadObjectCommand, file);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  },
  async get(file, range) {
    try {
      return await this.send(
        GetObjectCommand,
        file,
        range ? { Range: range } : {},
      );
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  },
  async read(file) {
    const result = await this.get(file);
    return result
      ? Buffer.from(await result.Body.transformToByteArray())
      : null;
  },
  async signedGet(file, expiresIn, response = {}, signingDate) {
    validateR2Config();
    const key = file.slice(R2_REF.length);
    // A dotted bucket makes the SDK switch to path-style URLs; keep the SDK for that case.
    if (config.r2.bucket.includes("."))
      return getSignedUrl(this.client(), new GetObjectCommand({
        Bucket: config.r2.bucket, Key: key, ...response,
      }), { expiresIn, ...(signingDate && { signingDate }) });
    if (!signingDate) return presignGetObject(config.r2, key, expiresIn, response);
    // Window-signed links repeat for every album poll and image request in that window.
    const id = [+signingDate, expiresIn, key, response.ResponseContentType,
      response.ResponseCacheControl, response.ResponseContentDisposition,
      config.r2.accountId, config.r2.bucket, config.r2.accessKeyId, config.r2.secretAccessKey].join("\n");
    let url = signedLinks.get(id);
    if (!url) {
      url = presignGetObject(config.r2, key, expiresIn, response, signingDate);
      if (signedLinks.size >= MAX_SIGNED_LINKS) signedLinks.delete(signedLinks.keys().next().value);
      signedLinks.set(id, url);
    }
    return url;
  },
  // A browser upload straight to storage: the URL is valid only for this key, a JPEG and
  // exactly this many bytes (both headers are signed), for a short while.
  signedPut(file, expiresIn, contentType, contentLength) {
    validateR2Config();
    return getSignedUrl(this.client(), new PutObjectCommand({
      Bucket: config.r2.bucket,
      Key: file.slice(R2_REF.length),
      ContentType: contentType,
      ContentLength: contentLength,
    }), { expiresIn, signableHeaders: new Set(["content-type", "content-length"]) });
  },
  async delete(file) {
    invalidateR2Inventory();
    try {
      await this.send(DeleteObjectCommand, file);
    } finally {
      invalidateR2Inventory();
    }
  },
  async deleteMany(files) {
    invalidateR2Inventory();
    try {
      for (let offset = 0; offset < files.length; offset += 1000) {
        const result = await this.send(DeleteObjectsCommand, null, {
          Delete: {
            Objects: files
              .slice(offset, offset + 1000)
              .map((file) => ({ Key: file.slice(R2_REF.length) })),
            Quiet: true,
          },
        });
        if (result.Errors?.length)
          throw new Error(
            "Chưa xóa được một số tệp R2. Hệ thống giữ tham chiếu để thử lại.",
          );
      }
    } finally {
      invalidateR2Inventory();
    }
  },
  async list() {
    const files = [];
    const cursors = new Set();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let cursor;
    try {
      do {
        const page = await this.send(
          ListObjectsV2Command,
          null,
          {
            Prefix: config.r2.prefix.replace(/\/?$/, "/"),
            ...(cursor && { ContinuationToken: cursor }),
          },
          { abortSignal: controller.signal },
        );
        for (const item of page.Contents || []) {
          if (!item.Key || !Number.isSafeInteger(item.Size) || item.Size < 0)
            throw new Error("R2 trả thống kê tệp không hợp lệ.");
          files.push({
            filename: `${R2_REF}${item.Key}`,
            length: item.Size,
            ...(item.LastModified && { modified: new Date(item.LastModified).getTime() }),
          });
        }
        const next = page.IsTruncated ? page.NextContinuationToken : null;
        if (page.IsTruncated && (!next || cursors.has(next)))
          throw new Error("Không đọc đủ danh sách tệp R2.");
        if (next) cursors.add(next);
        cursor = next;
      } while (cursor);
      return files;
    } finally {
      clearTimeout(timer);
    }
  },
};

// Share/cache metadata reads across staff and polling. Never download image
// payloads to measure storage; invalidate on writes/deletes, including failures.
export async function readR2Inventory({ fresh = false } = {}) {
  const signature = JSON.stringify(config.r2);
  if (
    !fresh &&
    inventoryCache?.signature === signature &&
    Date.now() - inventoryCache.checkedAt < 30000
  )
    return inventoryCache.files;
  if (
    !fresh &&
    pendingInventory?.signature === signature &&
    pendingInventory.generation === generation
  )
    return pendingInventory.promise;
  const revision = generation;
  const promise = r2Storage.list().then((files) => {
    if (revision === generation)
      inventoryCache = { files, signature, checkedAt: Date.now() };
    return files;
  });
  const pending = { signature, generation: revision, promise };
  pendingInventory = pending;
  try {
    return await promise;
  } finally {
    if (pendingInventory === pending) pendingInventory = undefined;
  }
}
