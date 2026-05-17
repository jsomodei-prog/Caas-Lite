/**
 * src/services/taxReceipt.ts
 * Automated regulatory PDF tax receipt generation.
 *
 * Generates signed, downloadable compliance records for:
 *   - Withholding tax (WHT) deductions per payout
 *   - Bulk WHT statements (monthly / per-period)
 *   - Regulatory filing receipts (threshold breach confirmations)
 *
 * Each PDF is:
 *   - HMAC-SHA256 signed with a receipt_id embedded in the document
 *   - Written to the configured receipts directory
 *   - Indexed in the receipt_log SQLite table
 *
 * Required packages:
 *   npm install pdfkit
 *   npm install @types/pdfkit --save-dev
 *
 * Required env vars:
 *   RECEIPTS_DIR       — Directory to write PDF files (default: data/receipts)
 *   PAYOUT_HMAC_SECRET — Used for receipt signing
 *
 * Phase 11 build-out | Commit baseline: a4f5db6
 */

import crypto   from "crypto";
import fs       from "fs";
import fsp      from "fs/promises";
import path     from "path";
import PDFDocument from "pdfkit";
import type { Database as DB } from "better-sqlite3";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PayoutReceiptData {
  payout_log_id: string;
  agent_id: string;
  agent_name: string;
  tenant_id: string;
  country_code: string;
  country_name: string;
  regulator: string;
  amount_usd: number;
  local_amount: number;
  local_currency: string;
  fx_mid_rate: number;
  fx_effective_rate: number;
  withholding_tax_local: number;
  withholding_tax_rate: number;
  net_disbursed_local: number;
  method: string;
  provider_reference: string | null;
  payout_date: string;
  generated_at?: string;
}

export interface BulkWHTStatement {
  tenant_id: string;
  period_start: string;
  period_end: string;
  country_code: string;
  country_name: string;
  regulator: string;
  local_currency: string;
  total_gross_local: number;
  total_wht_local: number;
  total_net_local: number;
  withholding_tax_rate: number;
  payout_count: number;
  payouts: PayoutReceiptData[];
}

export interface ReceiptLogRow {
  id: string;
  receipt_type: "payout_wht" | "bulk_wht_statement" | "regulatory_filing";
  payout_log_id: string | null;
  tenant_id: string;
  country_code: string;
  file_path: string;
  file_size_bytes: number;
  signature: string;
  generated_at: string;
  period_start: string | null;
  period_end: string | null;
}

// ─── Configuration ─────────────────────────────────────────────────────────────

const RECEIPTS_DIR = process.env.RECEIPTS_DIR ?? path.join("data", "receipts");
const HMAC_SECRET  = process.env.PAYOUT_HMAC_SECRET ?? "dev_hmac_secret";
const PLATFORM_NAME = process.env.PLATFORM_NAME ?? "CaaS-Lite Platform";

// ─── Signature ────────────────────────────────────────────────────────────────

function signReceipt(receiptId: string, filePath: string, generatedAt: string): string {
  return crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(`${receiptId}|${filePath}|${generatedAt}`)
    .digest("hex");
}

// ─── DB Bootstrap ─────────────────────────────────────────────────────────────

export function ensureReceiptLogTable(db: DB): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS receipt_log (
      id               TEXT PRIMARY KEY,
      receipt_type     TEXT NOT NULL,
      payout_log_id    TEXT REFERENCES payout_logs(id),
      tenant_id        TEXT NOT NULL,
      country_code     TEXT NOT NULL,
      file_path        TEXT NOT NULL,
      file_size_bytes  INTEGER NOT NULL DEFAULT 0,
      signature        TEXT NOT NULL,
      generated_at     TEXT NOT NULL,
      period_start     TEXT,
      period_end       TEXT
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_receipt_log_tenant
    ON receipt_log (tenant_id, generated_at DESC)
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_receipt_log_payout
    ON receipt_log (payout_log_id)
  `).run();
}

// ─── PDF Helpers ──────────────────────────────────────────────────────────────

function drawHRule(doc: PDFKit.PDFDocument, y: number, color = "#2d3a50"): void {
  doc.moveTo(50, y).lineTo(545, y).strokeColor(color).lineWidth(0.5).stroke();
}

function sectionHeader(doc: PDFKit.PDFDocument, text: string, y: number): void {
  doc.rect(50, y, 495, 22).fill("#0d1117");
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#00d4aa")
    .text(text.toUpperCase(), 58, y + 7);
  doc.fillColor("#e2e8f0");
}

function labelValue(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  x: number,
  y: number,
  valueColor = "#e2e8f0"
): void {
  doc.font("Helvetica").fontSize(8).fillColor("#4a5568").text(label, x, y);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(valueColor).text(value, x, y + 12);
}

// ─── Payout WHT Receipt PDF ───────────────────────────────────────────────────

async function generatePayoutWHTReceiptPDF(
  data: PayoutReceiptData,
  outputPath: string
): Promise<void> {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  const receiptId  = crypto.randomUUID();
  const generatedAt = data.generated_at ?? new Date().toISOString();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      info: {
        Title:    `WHT Receipt — ${data.payout_log_id.slice(0, 8)}`,
        Author:   PLATFORM_NAME,
        Subject:  "Withholding Tax Receipt",
        Keywords: "withholding tax, compliance, payout",
      },
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // ── Header bar ──
    doc.rect(0, 0, 595, 80).fill("#080b10");
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#00d4aa")
      .text(PLATFORM_NAME, 50, 22);
    doc.font("Helvetica").fontSize(9).fillColor("#4a5568")
      .text("WITHHOLDING TAX RECEIPT", 50, 50);
    doc.font("Helvetica").fontSize(8).fillColor("#4a5568")
      .text(`Receipt ID: ${receiptId}`, 350, 28, { align: "right", width: 195 });
    doc.font("Helvetica").fontSize(8).fillColor("#4a5568")
      .text(`Generated: ${new Date(generatedAt).toLocaleString()}`, 350, 42, { align: "right", width: 195 });

    doc.fillColor("#e2e8f0").font("Helvetica").fontSize(9);
    let y = 100;

    // ── Regulatory Authority ──
    sectionHeader(doc, "Regulatory Authority", y); y += 32;
    labelValue(doc, "Authority", data.regulator, 50, y);
    labelValue(doc, "Country", `${data.country_name} (${data.country_code})`, 250, y);
    labelValue(doc, "WHT Rate", `${(data.withholding_tax_rate * 100).toFixed(1)}%`, 420, y);
    y += 40; drawHRule(doc, y); y += 12;

    // ── Agent Details ──
    sectionHeader(doc, "Agent Details", y); y += 32;
    labelValue(doc, "Agent Name", data.agent_name, 50, y);
    labelValue(doc, "Agent ID", data.agent_id.slice(0, 8) + "…", 250, y);
    labelValue(doc, "Tenant", data.tenant_id, 420, y);
    y += 40; drawHRule(doc, y); y += 12;

    // ── Payout Details ──
    sectionHeader(doc, "Payout Details", y); y += 32;
    labelValue(doc, "Payout Date", new Date(data.payout_date).toLocaleDateString(), 50, y);
    labelValue(doc, "Method", data.method.toUpperCase(), 200, y);
    labelValue(doc, "Reference", data.provider_reference ?? "Pending", 340, y);
    y += 40;

    labelValue(doc, "USD Amount", `$${data.amount_usd.toFixed(2)}`, 50, y);
    labelValue(doc, "FX Mid Rate", data.fx_mid_rate.toFixed(4), 200, y);
    labelValue(doc, "Effective Rate", data.fx_effective_rate.toFixed(4), 340, y);
    labelValue(doc, "Currency", data.local_currency, 480, y);
    y += 40; drawHRule(doc, y); y += 12;

    // ── WHT Calculation ──
    sectionHeader(doc, "Withholding Tax Calculation", y); y += 32;

    // Table header
    doc.rect(50, y, 495, 18).fill("#1c2230");
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#4a5568");
    doc.text("Description", 58, y + 5);
    doc.text("Local Amount", 350, y + 5, { width: 185, align: "right" });
    y += 22;

    const rows = [
      ["Gross Disbursement (local)",         data.local_amount + data.withholding_tax_local],
      [`WHT Deduction (${(data.withholding_tax_rate*100).toFixed(1)}%)`, -data.withholding_tax_local],
      ["Net Amount Disbursed",               data.net_disbursed_local],
    ];

    rows.forEach(([label, amount], i) => {
      const isTotal = i === rows.length - 1;
      if (isTotal) {
        doc.rect(50, y - 2, 495, 22).fill("#0d1117");
        drawHRule(doc, y - 2, "#00d4aa");
      }
      doc.font(isTotal ? "Helvetica-Bold" : "Helvetica")
        .fontSize(isTotal ? 10 : 9)
        .fillColor(isTotal ? "#00d4aa" : (Number(amount) < 0 ? "#ef4444" : "#e2e8f0"))
        .text(String(label), 58, y + (isTotal ? 4 : 2));
      doc.text(
        `${data.local_currency} ${Math.abs(Number(amount)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        50, y + (isTotal ? 4 : 2),
        { width: 495, align: "right" }
      );
      y += isTotal ? 26 : 18;
    });

    y += 20; drawHRule(doc, y); y += 20;

    // ── Legal declaration ──
    doc.font("Helvetica").fontSize(8).fillColor("#4a5568")
      .text(
        `This receipt confirms that withholding tax of ${data.local_currency} ` +
        `${data.withholding_tax_local.toLocaleString(undefined, { minimumFractionDigits: 2 })} ` +
        `has been deducted from the above payout in accordance with the tax regulations of ${data.country_name}. ` +
        `This document should be retained by the payee for tax filing purposes.`,
        50, y, { width: 495, align: "justify" }
      );

    y += 50;

    // ── Signature block ──
    const sig = signReceipt(receiptId, outputPath, generatedAt);
    doc.rect(50, y, 495, 50).fill("#0d1117");
    doc.font("Helvetica").fontSize(7).fillColor("#4a5568")
      .text("DIGITAL SIGNATURE (HMAC-SHA256)", 58, y + 8);
    doc.font("Courier").fontSize(7).fillColor("#00d4aa")
      .text(sig, 58, y + 20, { width: 479 });

    // ── Footer ──
    doc.rect(0, 780, 595, 62).fill("#080b10");
    doc.font("Helvetica").fontSize(7).fillColor("#4a5568")
      .text(
        `${PLATFORM_NAME} · Phase 11 · This document is system-generated and digitally signed. ` +
        `Payout Log ID: ${data.payout_log_id}`,
        50, 790, { width: 495, align: "center" }
      );

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// ─── Bulk WHT Statement PDF ───────────────────────────────────────────────────

async function generateBulkWHTStatementPDF(
  stmt: BulkWHTStatement,
  outputPath: string
): Promise<void> {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  const receiptId   = crypto.randomUUID();
  const generatedAt = new Date().toISOString();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // Header
    doc.rect(0, 0, 595, 80).fill("#080b10");
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#00d4aa").text(PLATFORM_NAME, 50, 22);
    doc.font("Helvetica").fontSize(9).fillColor("#4a5568").text("WITHHOLDING TAX STATEMENT", 50, 50);
    doc.font("Helvetica").fontSize(8).fillColor("#4a5568")
      .text(`Period: ${new Date(stmt.period_start).toLocaleDateString()} – ${new Date(stmt.period_end).toLocaleDateString()}`, 350, 28, { align: "right", width: 195 })
      .text(`Country: ${stmt.country_name} (${stmt.country_code})`, 350, 42, { align: "right", width: 195 });

    let y = 100;

    sectionHeader(doc, "Statement Summary", y); y += 32;
    labelValue(doc, "Tenant", stmt.tenant_id, 50, y);
    labelValue(doc, "Regulator", stmt.regulator, 200, y);
    labelValue(doc, "WHT Rate", `${(stmt.withholding_tax_rate * 100).toFixed(1)}%`, 450, y);
    y += 40;
    labelValue(doc, "Gross Disbursed", `${stmt.local_currency} ${stmt.total_gross_local.toLocaleString(undefined,{minimumFractionDigits:2})}`, 50, y);
    labelValue(doc, "Total WHT", `${stmt.local_currency} ${stmt.total_wht_local.toLocaleString(undefined,{minimumFractionDigits:2})}`, 200, y, "#ef4444");
    labelValue(doc, "Net Disbursed", `${stmt.local_currency} ${stmt.total_net_local.toLocaleString(undefined,{minimumFractionDigits:2})}`, 380, y, "#00d4aa");
    y += 40; drawHRule(doc, y); y += 12;

    sectionHeader(doc, `Individual Payouts (${stmt.payout_count})`, y); y += 22;

    // Table header
    doc.rect(50, y, 495, 16).fill("#1c2230");
    doc.font("Helvetica-Bold").fontSize(7).fillColor("#4a5568");
    ["Date", "Agent", "Gross", "WHT", "Net", "Ref"].forEach((h, i) => {
      doc.text(h, 50 + [0, 70, 190, 270, 350, 430][i], y + 5, { width: 80 });
    });
    y += 18;

    for (const p of stmt.payouts) {
      if (y > 720) {
        doc.addPage();
        y = 50;
      }
      doc.font("Helvetica").fontSize(7).fillColor("#e2e8f0");
      doc.text(new Date(p.payout_date).toLocaleDateString(), 50, y);
      doc.text(p.agent_name.slice(0, 14), 120, y);
      doc.text(`${p.local_currency} ${(p.local_amount + p.withholding_tax_local).toLocaleString(undefined,{maximumFractionDigits:0})}`, 190, y);
      doc.text(`${p.local_currency} ${p.withholding_tax_local.toLocaleString(undefined,{maximumFractionDigits:0})}`, 270, y, { fillColor: "#ef4444" });
      doc.fillColor("#e2e8f0");
      doc.text(`${p.local_currency} ${p.net_disbursed_local.toLocaleString(undefined,{maximumFractionDigits:0})}`, 350, y);
      doc.text((p.provider_reference ?? "Pending").slice(0, 12), 430, y);
      y += 14;
      drawHRule(doc, y, "#1c2230"); y += 2;
    }

    y += 20;
    const sig = signReceipt(receiptId, outputPath, generatedAt);
    doc.rect(50, y, 495, 50).fill("#0d1117");
    doc.font("Helvetica").fontSize(7).fillColor("#4a5568").text("DIGITAL SIGNATURE", 58, y + 8);
    doc.font("Courier").fontSize(7).fillColor("#00d4aa").text(sig, 58, y + 20, { width: 479 });

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generates a signed WHT receipt PDF for a single payout and logs it to the DB.
 * Returns the absolute file path and receipt log row ID.
 */
export async function generatePayoutReceipt(
  db: DB,
  data: PayoutReceiptData
): Promise<{ file_path: string; receipt_id: string }> {
  ensureReceiptLogTable(db);

  const receiptId   = crypto.randomUUID();
  const generatedAt = new Date().toISOString();
  const fileName    = `wht_receipt_${data.payout_log_id.slice(0, 8)}_${Date.now()}.pdf`;
  const filePath    = path.resolve(RECEIPTS_DIR, data.tenant_id, fileName);

  data.generated_at = generatedAt;
  await generatePayoutWHTReceiptPDF(data, filePath);

  const stat = await fsp.stat(filePath);
  const sig  = signReceipt(receiptId, filePath, generatedAt);

  db.prepare(`
    INSERT INTO receipt_log
      (id, receipt_type, payout_log_id, tenant_id, country_code,
       file_path, file_size_bytes, signature, generated_at, period_start, period_end)
    VALUES (?, 'payout_wht', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(receiptId, data.payout_log_id, data.tenant_id, data.country_code, filePath, stat.size, sig, generatedAt);

  return { file_path: filePath, receipt_id: receiptId };
}

/**
 * Generates a bulk WHT statement for a period and logs it to the DB.
 */
export async function generateBulkStatement(
  db: DB,
  stmt: BulkWHTStatement
): Promise<{ file_path: string; receipt_id: string }> {
  ensureReceiptLogTable(db);

  const receiptId   = crypto.randomUUID();
  const generatedAt = new Date().toISOString();
  const fileName    = `wht_statement_${stmt.country_code}_${stmt.period_start.slice(0,7)}_${Date.now()}.pdf`;
  const filePath    = path.resolve(RECEIPTS_DIR, stmt.tenant_id, fileName);

  await generateBulkWHTStatementPDF(stmt, filePath);

  const stat = await fsp.stat(filePath);
  const sig  = signReceipt(receiptId, filePath, generatedAt);

  db.prepare(`
    INSERT INTO receipt_log
      (id, receipt_type, payout_log_id, tenant_id, country_code,
       file_path, file_size_bytes, signature, generated_at, period_start, period_end)
    VALUES (?, 'bulk_wht_statement', NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(receiptId, stmt.tenant_id, stmt.country_code, filePath, stat.size, sig, generatedAt, stmt.period_start, stmt.period_end);

  return { file_path: filePath, receipt_id: receiptId };
}

/**
 * Returns all receipts for a tenant, newest first.
 */
export function getReceiptLog(db: DB, tenantId: string, limit = 50): ReceiptLogRow[] {
  ensureReceiptLogTable(db);
  return db
    .prepare("SELECT * FROM receipt_log WHERE tenant_id = ? ORDER BY generated_at DESC LIMIT ?")
    .all(tenantId, limit) as ReceiptLogRow[];
}

/**
 * Resolves the bulk WHT statement data from the DB for a given period.
 */
export function buildBulkStatementFromDB(
  db: DB,
  tenantId: string,
  countryCode: string,
  periodStart: string,
  periodEnd: string
): BulkWHTStatement | null {
  const rows = db.prepare(`
    SELECT
      pl.id as payout_log_id,
      a.id as agent_id,
      a.name as agent_name,
      pl.tenant_id,
      a.country_code,
      pl.local_amount,
      pl.local_currency,
      pl.fx_mid_rate,
      pl.fx_effective_rate,
      pl.withholding_tax_local,
      pl.amount_usd,
      pl.method,
      pl.provider_reference,
      pl.created_at as payout_date
    FROM payout_logs pl
    JOIN agents a ON a.id = pl.agent_id
    WHERE pl.tenant_id = ?
      AND a.country_code = ?
      AND pl.created_at >= ?
      AND pl.created_at <= ?
      AND pl.status IN ('success','processing')
      AND pl.withholding_tax_local > 0
    ORDER BY pl.created_at ASC
  `).all(tenantId, countryCode, periodStart, periodEnd) as (PayoutReceiptData & { agent_name: string })[];

  if (rows.length === 0) return null;

  const { local_currency } = rows[0];
  const whtRate = rows[0].withholding_tax_local / (rows[0].local_amount || 1);

  const totalGross = rows.reduce((s, r) => s + r.local_amount + r.withholding_tax_local, 0);
  const totalWHT   = rows.reduce((s, r) => s + r.withholding_tax_local, 0);
  const totalNet   = rows.reduce((s, r) => s + r.local_amount, 0);

  return {
    tenant_id:             tenantId,
    period_start:          periodStart,
    period_end:            periodEnd,
    country_code:          countryCode,
    country_name:          rows[0].country_code,
    regulator:             "",
    local_currency,
    total_gross_local:     totalGross,
    total_wht_local:       totalWHT,
    total_net_local:       totalNet,
    withholding_tax_rate:  whtRate,
    payout_count:          rows.length,
    payouts:               rows.map(r => ({
      ...r,
      net_disbursed_local: r.local_amount,
      withholding_tax_rate: whtRate,
    })),
  };
}
