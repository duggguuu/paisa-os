// Re-seed the demo book of the (single) user. Never touches the real book.
import { makeSql } from './db.js';
import { seedDemo } from './seed-demo-data.js';
const sql = makeSql(process.env.DATABASE_URL!);
const [book] = await sql<{ id: string }[]>`select id from book where is_demo limit 1`;
if (!book) { console.error('No demo book yet: finish setup in the app first.'); process.exit(1); }
console.log(await seedDemo(sql, book.id, { reset: true }));
await sql.end();
