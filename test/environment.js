// Tests never use a production R2 account, even when .env enables R2 locally.
process.env.MEDIA_STORAGE_PROVIDER = "gridfs";
for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"])
  process.env[key] = "";
