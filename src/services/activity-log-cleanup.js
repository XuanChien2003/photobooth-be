import mongoose from "mongoose";

// Activity logs only: current collection and the name used by the older app.
export const ACTIVITY_LOG_COLLECTIONS = Object.freeze(["audits", "hf_audits"]);

export async function removeActivityLogs(db = mongoose.connection.db) {
  const removed = [];
  for (const name of ACTIVITY_LOG_COLLECTIONS) {
    const [existing] = await db
      .listCollections({ name }, { nameOnly: true })
      .toArray();
    if (!existing) continue;
    const collection = db.collection(name);
    const documents = await collection.countDocuments();
    try {
      await collection.drop();
      removed.push({ collection: name, documents });
    } catch (error) {
      // A concurrent app startup may have already removed this collection.
      if (error.code !== 26) throw error;
    }
  }
  return {
    removed,
    deletedDocuments: removed.reduce(
      (total, item) => total + item.documents,
      0,
    ),
  };
}
