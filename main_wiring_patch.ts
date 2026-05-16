// ─── 1. Import ────────────────────────────────────────────────────────────────
import { EvidenceDb } from "./evidenceDb";

// ─── 2. Initialize once (top of file / after other singletons) ────────────────
const evidenceDb = new EvidenceDb(); // defaults to "caas_evidence.db"
// or: new EvidenceDb("path/to/custom.db")

// ─── 3. Graceful shutdown ─────────────────────────────────────────────────────
process.on("exit",    () => evidenceDb.close());
process.on("SIGINT",  () => { evidenceDb.close(); process.exit(0); });
process.on("SIGTERM", () => { evidenceDb.close(); process.exit(0); });

// ─── 4. Replace the TODO comment ──────────────────────────────────────────────
//
//  BEFORE:
//    // TODO: wire evidenceDb.append()
//
//  AFTER (inside your Phase 2 verified-batch handler):
//
async function handleVerifiedBatch(verifiedBatch: unknown) {
  // ... your existing verification logic ...

  await evidenceDb.append(verifiedBatch); // ← replaces the TODO
}
