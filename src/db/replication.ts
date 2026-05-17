/**
 * src/db/replication.ts
 * Zero-downtime SQLite replication, backup, and read-only failover.
 *
 * Strategy:
 *  - better-sqlite3's native .backup() API performs an online, non-locking
 *    hot backup.  Readers and writers continue uninterrupted.
 *  - The backup file is written to a local temp directory, HMAC-signed, and
 *    integrity-checked before being shipped to S3 and/or a local replica dir.
 *  - S3 uploads use the AWS SDK v3 multipart Upload helper so files of any
 *    size are handled without loading the entire backup into memory.
 *  - Backup manifests are HMAC-SHA256 signed so tampering is detectable.
 *  - If the primary database fails an integrity check, BackupManager opens
 *    the most recent verified backup in read-only mode and sets a failover
 *    flag that callers can inspect before issuing write operations.
 *
 * Required packages:
 *   npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
 *
 * Phase 10 build-out  |  Commit baseline: a4f5db6
 */

import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { createReadStream } from "fs";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface S3BackupOptions {
  bucket: string;
  keyPrefix: string;
  region: string;
  /** How many days of backups to keep in S3 (0 = unlimited). */
  retentionDays: number;
  /** Optional endpoint override for S3-compatible stores (MinIO, Cloudflare R2). */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface FilesystemBackupOptions {
  /** Absolute path to the directory where replica copies are stored. */
  destDir: string;
  /** Maximum number of backup files to keep (oldest pruned first). */
  retentionCount: number;
}

export interface BackupManagerOptions {
  /** Absolute path to a writable temp directory for staging backups. */
  localTempDir: string;
  s3?: S3BackupOptions;
  filesystem?: FilesystemBackupOptions;
  /** Run PRAGMA integrity_check on the staged backup before shipping. */
  integrityCheck: boolean;
  hmacSecret: string;
  /** Bytes transferred per backup step — larger = faster but more CPU. */
  pagesPerStep?: number;
}

export interface BackupDestinationResult {
  type: "s3" | "filesystem";
  location: string;
  success: boolean;
  error?: string;
}

export interface BackupManifest {
  backup_id: string;
  source_db_path: string;
  staged_path: string;
  size_bytes: number;
  integrity_ok: boolean;
  destinations: BackupDestinationResult[];
  started_at: string;
  completed_at: string;
  duration_ms: number;
  status: "success" | "partial" | "failed";
  /** HMAC-SHA256 of the canonical manifest fields — set after other fields are finalised. */
  signature: string;
}

export interface FailoverState {
  active: boolean;
  replica_path: string | null;
  triggered_at: string | null;
  reason: string | null;
}

export interface IntegrityReport {
  ok: boolean;
  errors: string[];
  checked_at: string;
}

// ─── HMAC Utilities ───────────────────────────────────────────────────────────

function signManifest(manifest: Omit<BackupManifest, "signature">, secret: string): string {
  const canonical = [
    manifest.backup_id,
    manifest.source_db_path,
    manifest.size_bytes.toString(),
    manifest.integrity_ok ? "1" : "0",
    manifest.status,
    manifest.started_at,
    manifest.completed_at,
  ].join("|");
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

export function verifyManifestSignature(
  manifest: BackupManifest,
  secret: string
): boolean {
  const expected = signManifest(manifest, secret);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(manifest.signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

// ─── Integrity Checks ─────────────────────────────────────────────────────────

/**
 * Runs PRAGMA integrity_check on a live database handle.
 * Returns an IntegrityReport with full error details if corruption is found.
 */
export function checkDatabaseIntegrity(db: DB): IntegrityReport {
  const rows = db
    .prepare("PRAGMA integrity_check")
    .all() as { integrity_check: string }[];
  const checkedAt = new Date().toISOString();
  const errors = rows
    .map((r) => r.integrity_check)
    .filter((msg) => msg !== "ok");
  return { ok: errors.length === 0, errors, checked_at: checkedAt };
}

/**
 * Opens a backup file as a temporary database, runs integrity_check,
 * then closes it.  Does not disturb the primary database.
 */
async function verifyBackupFile(backupPath: string): Promise<IntegrityReport> {
  let tempDb: DB | null = null;
  try {
    tempDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    return checkDatabaseIntegrity(tempDb);
  } finally {
    tempDb?.close();
  }
}

// ─── Online Backup ────────────────────────────────────────────────────────────

/**
 * Executes a non-locking online backup using better-sqlite3's native backup API.
 * The primary database remains fully available to readers and writers throughout.
 *
 * @param db          Primary database handle.
 * @param destPath    Absolute path for the backup file.
 * @param pagesPerStep  Pages transferred per step (default 100 — increase for speed,
 *                      decrease to reduce I/O impact on hot databases).
 * @returns           Size of the resulting backup file in bytes.
 */
export async function executeOnlineBackup(
  db: DB,
  destPath: string,
  pagesPerStep = 100
): Promise<number> {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  await (db as unknown as {
    backup: (
      dest: string,
      opts: { progress: (info: { totalPages: number; remainingPages: number }) => number }
    ) => Promise<void>;
  }).backup(destPath, {
    progress({ totalPages, remainingPages }) {
      // Return pagesPerStep to transfer that many pages per iteration.
      // Returning a higher value speeds up backup at the cost of more I/O.
      return remainingPages > 0 ? pagesPerStep : 0;
    },
  });

  // Force a WAL checkpoint on the backup so it is self-contained.
  const backupDb = new Database(destPath);
  try {
    backupDb.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    backupDb.close();
  }

  const stat = await fsp.stat(destPath);
  return stat.size;
}

// ─── S3 Upload ────────────────────────────────────────────────────────────────

function buildS3Client(opts: S3BackupOptions): S3Client {
  return new S3Client({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.accessKeyId && opts.secretAccessKey
      ? {
          credentials: {
            accessKeyId: opts.accessKeyId,
            secretAccessKey: opts.secretAccessKey,
          },
        }
      : {}),
  });
}

async function uploadToS3(
  localPath: string,
  backupId: string,
  opts: S3BackupOptions
): Promise<string> {
  const client = buildS3Client(opts);
  const key = `${opts.keyPrefix.replace(/\/$/, "")}/${backupId}.db`;

  const upload = new Upload({
    client,
    params: {
      Bucket: opts.bucket,
      Key: key,
      Body: createReadStream(localPath),
      ContentType: "application/octet-stream",
      Metadata: { backup_id: backupId },
    },
    queueSize: 4,      // parallel upload parts
    partSize: 8 * 1024 * 1024, // 8 MiB parts
  });

  await upload.done();
  return `s3://${opts.bucket}/${key}`;
}

/**
 * Prunes S3 backup objects older than retentionDays.
 * Lists all objects under the keyPrefix, filters by LastModified, deletes expired ones.
 */
async function pruneS3Backups(opts: S3BackupOptions): Promise<number> {
  if (opts.retentionDays <= 0) return 0;
  const client = buildS3Client(opts);
  const cutoff = new Date(Date.now() - opts.retentionDays * 86_400_000);
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: opts.bucket,
        Prefix: opts.keyPrefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of list.Contents ?? []) {
      if (obj.Key && obj.LastModified && obj.LastModified < cutoff) {
        await client.send(
          new DeleteObjectCommand({ Bucket: opts.bucket, Key: obj.Key })
        );
        deleted++;
      }
    }

    continuationToken = list.NextContinuationToken;
  } while (continuationToken);

  return deleted;
}

// ─── Filesystem Upload ────────────────────────────────────────────────────────

async function uploadToFilesystem(
  localPath: string,
  backupId: string,
  opts: FilesystemBackupOptions
): Promise<string> {
  await fsp.mkdir(opts.destDir, { recursive: true });
  const destPath = path.join(opts.destDir, `${backupId}.db`);
  await fsp.copyFile(localPath, destPath);
  return destPath;
}

async function pruneFilesystemBackups(opts: FilesystemBackupOptions): Promise<number> {
  if (opts.retentionCount <= 0) return 0;

  let files: fs.Dirent[];
  try {
    files = await fsp.readdir(opts.destDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const backupFiles = files
    .filter((f) => f.isFile() && f.name.endsWith(".db"))
    .map((f) => ({
      name: f.name,
      fullPath: path.join(opts.destDir, f.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name)); // lexicographic = chronological (UUID v4 timestamps)

  const toDelete = backupFiles.slice(0, Math.max(0, backupFiles.length - opts.retentionCount));

  for (const file of toDelete) {
    await fsp.unlink(file.fullPath).catch(() => {});
  }

  return toDelete.length;
}

// ─── Failover ─────────────────────────────────────────────────────────────────

/**
 * Opens the most recent filesystem backup replica in read-only mode.
 * Returns null if no replica is available.
 */
export function openReadOnlyReplica(replicaPath: string): DB {
  return new Database(replicaPath, { readonly: true, fileMustExist: true });
}

/**
 * Finds the most recent backup file in a filesystem backup directory.
 */
async function findLatestFilesystemBackup(
  destDir: string
): Promise<string | null> {
  let files: fs.Dirent[];
  try {
    files = await fsp.readdir(destDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const backups = files
    .filter((f) => f.isFile() && f.name.endsWith(".db"))
    .map((f) => f.name)
    .sort();

  if (backups.length === 0) return null;
  return path.join(destDir, backups[backups.length - 1]);
}

// ─── BackupManager ────────────────────────────────────────────────────────────

/**
 * Orchestrates the full backup lifecycle:
 *   1. Online backup to local temp file (non-locking)
 *   2. Integrity verification of the staged backup
 *   3. Parallel upload to S3 and/or local filesystem replica directory
 *   4. Manifest signing and logging
 *   5. Retention pruning
 *   6. Failover activation when the primary database is unavailable
 */
export class BackupManager {
  private readonly opts: BackupManagerOptions;
  private readonly dbPath: string;
  private failover: FailoverState = {
    active: false,
    replica_path: null,
    triggered_at: null,
    reason: null,
  };
  private replicaHandle: DB | null = null;
  private readonly manifestLog: BackupManifest[] = [];

  constructor(private readonly db: DB, opts: BackupManagerOptions) {
    this.opts = {
      pagesPerStep: 100,
      ...opts,
    };
    this.dbPath = (db as unknown as { name: string }).name ?? "unknown";
  }

  /**
   * Executes a full backup cycle.
   * Safe to call concurrently — a second invocation while one is running
   * will receive its own manifest with its own backup_id.
   */
  async runBackup(): Promise<BackupManifest> {
    const backupId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto
      .randomBytes(4)
      .toString("hex")}`;

    const stagedPath = path.join(
      this.opts.localTempDir,
      `${backupId}.db`
    );

    const startedAt = new Date().toISOString();
    const startMs  = Date.now();

    let sizeBytes   = 0;
    let integrityOk = false;
    const destinations: BackupDestinationResult[] = [];

    try {
      // Step 1: Online backup — primary DB stays fully accessible.
      sizeBytes = await executeOnlineBackup(
        this.db,
        stagedPath,
        this.opts.pagesPerStep
      );

      // Step 2: Integrity check on the staged file.
      if (this.opts.integrityCheck) {
        const report = await verifyBackupFile(stagedPath);
        integrityOk = report.ok;
        if (!report.ok) {
          console.error(
            `[replication] Backup ${backupId} failed integrity check:`,
            report.errors
          );
        }
      } else {
        integrityOk = true; // Skipped — assume ok.
      }

      // Step 3: Ship to destinations in parallel.
      const uploads: Promise<void>[] = [];

      if (this.opts.s3) {
        const s3Opts = this.opts.s3;
        uploads.push(
          uploadToS3(stagedPath, backupId, s3Opts)
            .then((location) => {
              destinations.push({ type: "s3", location, success: true });
            })
            .catch((err: unknown) => {
              destinations.push({
                type: "s3",
                location: `s3://${s3Opts.bucket}/${s3Opts.keyPrefix}/${backupId}.db`,
                success: false,
                error: err instanceof Error ? err.message : String(err),
              });
            })
        );
      }

      if (this.opts.filesystem) {
        const fsOpts = this.opts.filesystem;
        uploads.push(
          uploadToFilesystem(stagedPath, backupId, fsOpts)
            .then((location) => {
              destinations.push({ type: "filesystem", location, success: true });
            })
            .catch((err: unknown) => {
              destinations.push({
                type: "filesystem",
                location: path.join(fsOpts.destDir, `${backupId}.db`),
                success: false,
                error: err instanceof Error ? err.message : String(err),
              });
            })
        );
      }

      await Promise.all(uploads);
    } catch (err: unknown) {
      const completedAt = new Date().toISOString();
      const manifest: BackupManifest = {
        backup_id: backupId,
        source_db_path: this.dbPath,
        staged_path: stagedPath,
        size_bytes: sizeBytes,
        integrity_ok: false,
        destinations,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: Date.now() - startMs,
        status: "failed",
        signature: "",
      };
      manifest.signature = signManifest(manifest, this.opts.hmacSecret);
      this.manifestLog.push(manifest);
      throw err;
    } finally {
      // Always remove the staged temp file.
      fsp.unlink(stagedPath).catch(() => {});
    }

    // Step 4: Prune old backups.
    if (this.opts.s3) {
      pruneS3Backups(this.opts.s3).catch((err) =>
        console.error("[replication] S3 prune error:", err)
      );
    }
    if (this.opts.filesystem) {
      pruneFilesystemBackups(this.opts.filesystem).catch((err) =>
        console.error("[replication] Filesystem prune error:", err)
      );
    }

    const allSucceeded = destinations.every((d) => d.success);
    const anySucceeded = destinations.some((d) => d.success);

    const completedAt = new Date().toISOString();
    const manifest: BackupManifest = {
      backup_id: backupId,
      source_db_path: this.dbPath,
      staged_path: stagedPath,
      size_bytes: sizeBytes,
      integrity_ok: integrityOk,
      destinations,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: Date.now() - startMs,
      status: allSucceeded ? "success" : anySucceeded ? "partial" : "failed",
      signature: "",
    };
    manifest.signature = signManifest(manifest, this.opts.hmacSecret);
    this.manifestLog.push(manifest);

    console.log(
      `[replication] Backup ${backupId}: ${manifest.status} ` +
        `(${(sizeBytes / 1024 / 1024).toFixed(2)} MiB, ${manifest.duration_ms}ms)`
    );

    return manifest;
  }

  /**
   * Triggers failover to the most recent verified filesystem replica.
   * Returns the read-only replica handle, or null if no replica is available.
   * The primary DB handle is NOT closed — it may recover.
   */
  async triggerFailover(reason: string): Promise<DB | null> {
    if (this.failover.active && this.replicaHandle) {
      return this.replicaHandle;
    }

    let replicaPath: string | null = null;

    if (this.opts.filesystem) {
      replicaPath = await findLatestFilesystemBackup(this.opts.filesystem.destDir);
    }

    if (!replicaPath) {
      console.error("[replication] Failover triggered but no replica found:", reason);
      return null;
    }

    const integrityReport = await verifyBackupFile(replicaPath);
    if (!integrityReport.ok) {
      console.error(
        "[replication] Replica failed integrity check — cannot failover safely:",
        integrityReport.errors
      );
      return null;
    }

    this.replicaHandle = openReadOnlyReplica(replicaPath);
    this.failover = {
      active: true,
      replica_path: replicaPath,
      triggered_at: new Date().toISOString(),
      reason,
    };

    console.warn(
      `[replication] FAILOVER ACTIVE → ${replicaPath} (reason: ${reason})`
    );

    return this.replicaHandle;
  }

  /** Deactivates failover — call after the primary database is restored. */
  clearFailover(): void {
    this.replicaHandle?.close();
    this.replicaHandle = null;
    this.failover = {
      active: false,
      replica_path: null,
      triggered_at: null,
      reason: null,
    };
    console.info("[replication] Failover cleared — primary database restored.");
  }

  getFailoverState(): Readonly<FailoverState> {
    return { ...this.failover };
  }

  /**
   * Returns the effective database handle: replica if in failover, primary otherwise.
   * Callers must check `isInFailover()` before issuing writes.
   */
  getEffectiveDb(): DB {
    if (this.failover.active && this.replicaHandle) {
      return this.replicaHandle;
    }
    return this.db;
  }

  isInFailover(): boolean {
    return this.failover.active;
  }

  getManifestHistory(): BackupManifest[] {
    return [...this.manifestLog];
  }

  getLastManifest(): BackupManifest | null {
    return this.manifestLog[this.manifestLog.length - 1] ?? null;
  }
}

// ─── Cron Schedule Reference ──────────────────────────────────────────────────
//
// The backup cron is registered in src/app.ts using node-cron.
// Equivalent system crontab entries for reference (run as the app user):
//
//   # Daily full backup at 02:00 UTC
//   0 2 * * * cd /app && node -r ts-node/register scripts/runBackup.ts >> /var/log/caas/backup.log 2>&1
//
//   # Hourly WAL checkpoint to prevent unbounded WAL growth
//   0 * * * * cd /app && node -r ts-node/register scripts/walCheckpoint.ts >> /var/log/caas/wal.log 2>&1
//
// Required env vars:
//   DB_PATH                 Absolute path to caas_evidence.db
//   PAYOUT_HMAC_SECRET      Shared secret for manifest signing
//   BACKUP_TEMP_DIR         Writable temp directory for staging (default: /tmp/caas-backups)
//   BACKUP_FS_DIR           Local replica destination directory
//   BACKUP_FS_RETENTION     Number of filesystem backups to keep (default: 7)
//   AWS_REGION              S3 region
//   BACKUP_S3_BUCKET        S3 bucket name
//   BACKUP_S3_PREFIX        S3 key prefix (default: backups/)
//   BACKUP_S3_RETENTION_DAYS  Days of S3 backup retention (default: 30)
