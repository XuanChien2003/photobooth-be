import { Booking } from "../models/index.js";

// Only remove the obsolete slot constraint. Keep ticket and retry-key uniqueness.
export async function migrateCounterIndexes() {
  try {
    await Booking.collection.dropIndex("room_1_date_1_time_1");
  } catch (error) {
    if (![26, 27].includes(error.code)) throw error;
  }
  // Older deployments had a non-sparse unique code index. MongoDB allows only
  // one document without a code under that index, which blocks unpaid drafts.
  const indexes = await Booking.collection.indexes().catch((error) => {
    if (error.code === 26) return [];
    throw error;
  });
  for (const field of ["code", "accessToken"]) {
    const name = `${field}_1`;
    const existing = indexes.find((entry) => entry.name === name);
    if (existing && !existing.sparse) await Booking.collection.dropIndex(name);
    await Booking.collection.createIndex({ [field]: 1 }, { name, unique: true, sparse: true });
  }
}
