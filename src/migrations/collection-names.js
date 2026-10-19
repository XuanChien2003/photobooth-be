const collectionNames = [
  "users",
  "rooms",
  "packages",
  "frames",
  "poses",
  "events",
  "coupons",
  "settings",
  "bookings",
];

// Run with the application stopped. Renaming preserves documents, IDs and indexes.
export async function migrateCollectionNames(db) {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      (c) => c.name,
    ),
  );
  const pending = collectionNames.filter((name) => existing.has(`hf_${name}`));
  const conflicts = pending.filter((name) => existing.has(name));
  if (conflicts.length)
    throw new Error(
      `Collection đích đã tồn tại: ${conflicts.join(", ")}. Không ghi đè dữ liệu; chưa đổi tên collection nào.`,
    );

  const results = [];
  for (const name of pending) {
    const source = db.collection(`hf_${name}`);
    const beforeCount = await source.countDocuments();
    const beforeIndexes = await source.indexes();
    const target = await source.rename(name, { dropTarget: false });
    const afterCount = await target.countDocuments();
    const afterIndexes = await target.indexes();
    if (
      beforeCount !== afterCount ||
      JSON.stringify(beforeIndexes) !== JSON.stringify(afterIndexes)
    ) {
      throw new Error(
        `Kiểm tra collection ${name} không khớp sau khi đổi tên. Dừng migration để kiểm tra.`,
      );
    }
    results.push({
      from: `hf_${name}`,
      to: name,
      documents: afterCount,
      indexes: afterIndexes.length,
    });
  }
  return results;
}
