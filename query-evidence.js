const Database = require('better-sqlite3');
const db = new Database('caas_evidence.db');
const row = db.prepare('SELECT * FROM evidence WHERE id = 2').get();
const batch = JSON.parse(row.batchData);
console.log('OUTCOME:', batch.overallOutcome);
console.log('ALERTS:', batch.alerts.length);
batch.verificationResults.forEach(r => {
  console.log(' -', r.policyId, '|', r.outcome);
});
db.close();
