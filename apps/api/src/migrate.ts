import { makeSql, migrate } from './db.js';
const sql = makeSql(process.env.DATABASE_URL!);
console.log('Applied:', (await migrate(sql)).join(', ') || 'nothing new');
await sql.end();
