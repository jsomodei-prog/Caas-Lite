import Database from 'better-sqlite3';

const db = new Database('caas_evidence.db');
const rows = db.prepare('SELECT id, timestamp FROM evidence').all();
console.table(rows);
db.close();