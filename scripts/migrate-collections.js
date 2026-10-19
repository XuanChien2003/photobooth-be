import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { migrateCollectionNames } from '../src/migrations/collection-names.js';

try {
  await mongoose.connect(config.mongo, { serverSelectionTimeoutMS: 10000 });
  const results = await migrateCollectionNames(mongoose.connection.db);
  console.table(results);
  console.log(results.length ? 'Đã đổi tên collection và kiểm tra số bản ghi, index.' : 'Không có collection cũ cần chuyển đổi.');
} catch (error) {
  console.error('Migration thất bại:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
