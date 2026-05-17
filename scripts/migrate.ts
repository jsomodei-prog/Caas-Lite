import { openDatabase, getMigrationHistory, getCurrentVersion } from "../src/db/migrate";
const db = openDatabase();
console.log(`\nSchema version: ${getCurrentVersion(db)}\n`);
console.table(getMigrationHistory(db));
db.close();
