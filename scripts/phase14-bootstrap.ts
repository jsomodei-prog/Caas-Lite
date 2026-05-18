import "dotenv/config";
import Database from "better-sqlite3";
import path from "path";

const dbPath = process.env.DB_PATH ?? "./data/caas_evidence.db";
const resolved = path.resolve(dbPath);
console.log(`[bootstrap] Opening ${resolved}`);

const db = new Database(resolved);
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS regulatory_frameworks (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    framework_code     TEXT    NOT NULL UNIQUE,
    framework_name     TEXT    NOT NULL,
    region_code        TEXT    NOT NULL,
    region_name        TEXT    NOT NULL,
    regulator_name     TEXT,
    version            TEXT    NOT NULL,
    description        TEXT,
    source_url         TEXT,
    effective_date     TEXT,
    is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    metadata           TEXT    NOT NULL DEFAULT '{}',
    created_by_user_id TEXT,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reg_frameworks_region_active ON regulatory_frameworks(region_code, is_active);
  CREATE INDEX IF NOT EXISTS idx_reg_frameworks_code          ON regulatory_frameworks(framework_code);

  CREATE TABLE IF NOT EXISTS regulatory_field_rules (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    framework_id     INTEGER NOT NULL REFERENCES regulatory_frameworks(id) ON DELETE CASCADE,
    field_key        TEXT    NOT NULL,
    field_label      TEXT    NOT NULL,
    data_type        TEXT    NOT NULL CHECK (data_type IN ('string','number','boolean','date','email','phone','identifier')),
    is_required      INTEGER NOT NULL DEFAULT 0 CHECK (is_required  IN (0,1)),
    is_sensitive     INTEGER NOT NULL DEFAULT 0 CHECK (is_sensitive IN (0,1)),
    min_length       INTEGER,
    max_length       INTEGER,
    validation_regex TEXT,
    regex_flags      TEXT    NOT NULL DEFAULT '',
    error_message    TEXT,
    allowed_values   TEXT,
    constraints      TEXT    NOT NULL DEFAULT '{}',
    display_order    INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (framework_id, field_key)
  );
  CREATE INDEX IF NOT EXISTS idx_reg_field_rules_framework ON regulatory_field_rules(framework_id);

  CREATE TABLE IF NOT EXISTS regulatory_consent_purposes (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    framework_id              INTEGER NOT NULL REFERENCES regulatory_frameworks(id) ON DELETE CASCADE,
    purpose_code              TEXT    NOT NULL,
    purpose_label             TEXT    NOT NULL,
    description               TEXT,
    lawful_basis              TEXT,
    requires_explicit_consent INTEGER NOT NULL DEFAULT 0 CHECK (requires_explicit_consent IN (0,1)),
    retention_days            INTEGER,
    created_at                TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (framework_id, purpose_code)
  );
  CREATE INDEX IF NOT EXISTS idx_reg_consent_purposes_framework ON regulatory_consent_purposes(framework_id);
`);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'regulatory_%' ORDER BY name")
  .all() as { name: string }[];

console.log(`[bootstrap] Tables now present:`);
for (const t of tables) console.log(`  ✓ ${t.name}`);

db.close();
console.log(`[bootstrap] Done.`);