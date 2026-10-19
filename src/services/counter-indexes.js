import { Booking } from "../models/index.js";

// Only remove the obsolete slot constraint. Keep ticket and retry-key uniqueness.
export async function migrateCounterIndexes() {
  try {
    await Booking.collection.dropIndex("room_1_date_1_time_1");
  } catch (error) {
    if (![26, 27].includes(error.code)) throw error;
  }
}
