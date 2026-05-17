/**
 * src/config/countryRequirements.ts
 * Per-country payout configuration covering:
 *  - Local currency and supported payout methods
 *  - Regulatory reporting thresholds
 *  - KYC tier requirements
 *  - Withholding tax rates
 *  - Minimum / maximum single-payout limits in local currency
 *  - Central bank / regulatory authority metadata
 *
 * All monetary limits expressed in local currency units.
 * USD hard cap enforced upstream in payout.ts before this config is consulted.
 *
 * Commit baseline: a4f5db6  |  Phase 9 build-out
 */

import type { PayoutMethod } from "../services/payout";

// ─── Types ────────────────────────────────────────────────────────────────────

export type KycTier = "basic" | "standard" | "enhanced";

/** Regulatory reporting requirement triggered when a single payout breaches
 *  a threshold. Authorities must be notified within the stated window. */
export interface ReportingThreshold {
  /** Amount in local currency that triggers mandatory reporting. */
  amount_local: number;
  /** Regulatory body that must receive the report. */
  authority: string;
  /** Maximum hours from transaction to filing. */
  report_within_hours: number;
  /** Legal citation or reference. */
  legal_ref: string;
}

export interface PayoutMethodConfig {
  method: PayoutMethod;
  /** Provider gateway identifier used in this country. */
  gateway: string;
  /** Minimum payout amount in local currency. */
  min_local: number;
  /** Maximum payout amount per single transaction in local currency. */
  max_local: number;
  /** Additional fields the agent record must supply for this method. */
  required_agent_fields: string[];
}

export interface CountryRequirement {
  /** ISO 3166-1 alpha-2 country code. */
  country_code: string;
  country_name: string;
  /** ISO 4217 local currency code. */
  local_currency: string;
  /** ISO 4217 codes of other accepted settlement currencies (besides local). */
  accepted_currencies: string[];
  supported_methods: PayoutMethodConfig[];
  /**
   * Minimum KYC tier the agent must hold before any payout is processed.
   * basic     — name + phone verified
   * standard  — government ID verified
   * enhanced  — ID + proof-of-address + source-of-funds declaration
   */
  min_kyc_tier: KycTier;
  /**
   * Withholding tax rate on payouts (0–1 fraction).
   * Platform deducts this before remitting to the agent.
   */
  withholding_tax_rate: number;
  /**
   * Whether payouts require an explicit regulatory receipt / acknowledgement
   * from the central bank or payment regulator before settlement is finalised.
   */
  requires_regulatory_receipt: boolean;
  reporting_thresholds: ReportingThreshold[];
  /**
   * Central bank or primary financial regulator name.
   */
  regulator: string;
  /**
   * ISO 8601 time zone identifier — used when evaluating business-hour rules.
   */
  iana_timezone: string;
  /**
   * Whether the country is under FATF enhanced monitoring or an equivalent
   * grey / black list.  When true, all payouts trigger anomaly scoring.
   */
  fatf_enhanced_monitoring: boolean;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const COUNTRY_REQUIREMENTS: Record<string, CountryRequirement> = {

  // ── Africa ──────────────────────────────────────────────────────────────────

  GH: {
    country_code: "GH",
    country_name: "Ghana",
    local_currency: "GHS",
    accepted_currencies: ["GHS", "USD"],
    supported_methods: [
      {
        method: "momo",
        gateway: "mtn_momo",
        min_local: 1,
        max_local: 10_000,
        required_agent_fields: ["momo_number", "momo_provider"],
      },
      {
        method: "card",
        gateway: "paystack",
        min_local: 5,
        max_local: 50_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 10_000,
        authority: "Financial Intelligence Centre (FIC)",
        report_within_hours: 24,
        legal_ref: "Anti-Money Laundering Act 2020 (Act 1044) §41",
      },
    ],
    regulator: "Bank of Ghana (BoG)",
    iana_timezone: "Africa/Accra",
    fatf_enhanced_monitoring: false,
  },

  NG: {
    country_code: "NG",
    country_name: "Nigeria",
    local_currency: "NGN",
    accepted_currencies: ["NGN", "USD"],
    supported_methods: [
      {
        method: "momo",
        gateway: "mtn_momo_ng",
        min_local: 100,
        max_local: 1_000_000,
        required_agent_fields: ["momo_number"],
      },
      {
        method: "card",
        gateway: "paystack",
        min_local: 500,
        max_local: 5_000_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0.10, // 10 % WHT on commissions/fees per FIRS
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 5_000_000,
        authority: "Nigerian Financial Intelligence Unit (NFIU)",
        report_within_hours: 24,
        legal_ref: "Money Laundering (Prevention and Prohibition) Act 2022 §10",
      },
    ],
    regulator: "Central Bank of Nigeria (CBN)",
    iana_timezone: "Africa/Lagos",
    fatf_enhanced_monitoring: false,
  },

  KE: {
    country_code: "KE",
    country_name: "Kenya",
    local_currency: "KES",
    accepted_currencies: ["KES", "USD"],
    supported_methods: [
      {
        method: "momo",
        gateway: "mpesa",
        min_local: 10,
        max_local: 150_000,
        required_agent_fields: ["momo_number"],
      },
      {
        method: "card",
        gateway: "paystack",
        min_local: 50,
        max_local: 500_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0.05, // 5 % WHT on digital service payments
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 1_000_000,
        authority: "Financial Reporting Centre (FRC)",
        report_within_hours: 24,
        legal_ref: "Proceeds of Crime and Anti-Money Laundering Act (POCAMLA) §44",
      },
    ],
    regulator: "Central Bank of Kenya (CBK)",
    iana_timezone: "Africa/Nairobi",
    fatf_enhanced_monitoring: false,
  },

  ZA: {
    country_code: "ZA",
    country_name: "South Africa",
    local_currency: "ZAR",
    accepted_currencies: ["ZAR", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "peach_payments",
        min_local: 10,
        max_local: 500_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: true,
    reporting_thresholds: [
      {
        amount_local: 24_999,
        authority: "Financial Intelligence Centre (FIC)",
        report_within_hours: 5 * 24, // 5 business days
        legal_ref: "Financial Intelligence Centre Act 38 of 2001 §28",
      },
    ],
    regulator: "South African Reserve Bank (SARB)",
    iana_timezone: "Africa/Johannesburg",
    fatf_enhanced_monitoring: false,
  },

  UG: {
    country_code: "UG",
    country_name: "Uganda",
    local_currency: "UGX",
    accepted_currencies: ["UGX", "USD"],
    supported_methods: [
      {
        method: "momo",
        gateway: "mtn_momo",
        min_local: 500,
        max_local: 5_000_000,
        required_agent_fields: ["momo_number"],
      },
    ],
    min_kyc_tier: "basic",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 20_000_000,
        authority: "Financial Intelligence Authority (FIA)",
        report_within_hours: 24,
        legal_ref: "Anti-Money Laundering (Amendment) Act 2022 §6",
      },
    ],
    regulator: "Bank of Uganda (BoU)",
    iana_timezone: "Africa/Kampala",
    fatf_enhanced_monitoring: false,
  },

  TZ: {
    country_code: "TZ",
    country_name: "Tanzania",
    local_currency: "TZS",
    accepted_currencies: ["TZS", "USD"],
    supported_methods: [
      {
        method: "momo",
        gateway: "vodacom_mpesa_tz",
        min_local: 500,
        max_local: 10_000_000,
        required_agent_fields: ["momo_number"],
      },
    ],
    min_kyc_tier: "basic",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 10_000_000,
        authority: "Financial Intelligence Unit (FIU)",
        report_within_hours: 48,
        legal_ref: "Anti-Money Laundering Act 2006 (Cap 423) §16",
      },
    ],
    regulator: "Bank of Tanzania (BoT)",
    iana_timezone: "Africa/Dar_es_Salaam",
    fatf_enhanced_monitoring: false,
  },

  RW: {
    country_code: "RW",
    country_name: "Rwanda",
    local_currency: "RWF",
    accepted_currencies: ["RWF", "USD"],
    supported_methods: [
      {
        method: "momo",
        gateway: "mtn_momo",
        min_local: 100,
        max_local: 3_000_000,
        required_agent_fields: ["momo_number"],
      },
    ],
    min_kyc_tier: "basic",
    withholding_tax_rate: 0.15,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 5_000_000,
        authority: "Financial Intelligence Unit (FIU Rwanda)",
        report_within_hours: 24,
        legal_ref: "Law No 47/2008 Relating to Prevention and Penalisation of Money Laundering §14",
      },
    ],
    regulator: "National Bank of Rwanda (BNR)",
    iana_timezone: "Africa/Kigali",
    fatf_enhanced_monitoring: false,
  },

  SN: {
    country_code: "SN",
    country_name: "Senegal",
    local_currency: "XOF",
    accepted_currencies: ["XOF", "EUR", "USD"],
    supported_methods: [
      {
        method: "momo",
        gateway: "orange_money",
        min_local: 100,
        max_local: 1_500_000,
        required_agent_fields: ["momo_number"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 5_000_000,
        authority: "Cellule Nationale de Traitement des Informations Financières (CENTIF)",
        report_within_hours: 24,
        legal_ref: "UEMOA Directive No 02/2015/CM/UEMOA",
      },
    ],
    regulator: "Banque Centrale des États de l'Afrique de l'Ouest (BCEAO)",
    iana_timezone: "Africa/Dakar",
    fatf_enhanced_monitoring: false,
  },

  ZM: {
    country_code: "ZM",
    country_name: "Zambia",
    local_currency: "ZMW",
    accepted_currencies: ["ZMW", "USD"],
    supported_methods: [
      {
        method: "momo",
        gateway: "mtn_momo",
        min_local: 5,
        max_local: 50_000,
        required_agent_fields: ["momo_number"],
      },
    ],
    min_kyc_tier: "basic",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 100_000,
        authority: "Financial Intelligence Centre (FIC Zambia)",
        report_within_hours: 48,
        legal_ref: "Financial Intelligence Centre Act 2010 §38",
      },
    ],
    regulator: "Bank of Zambia (BoZ)",
    iana_timezone: "Africa/Lusaka",
    fatf_enhanced_monitoring: false,
  },

  EG: {
    country_code: "EG",
    country_name: "Egypt",
    local_currency: "EGP",
    accepted_currencies: ["EGP", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "paymob",
        min_local: 10,
        max_local: 500_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "enhanced",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: true,
    reporting_thresholds: [
      {
        amount_local: 200_000,
        authority: "Egyptian Money Laundering and Terrorist Financing Combating Unit (EMLCU)",
        report_within_hours: 24,
        legal_ref: "AML Law No 80 of 2002 (as amended 2014) §12",
      },
    ],
    regulator: "Central Bank of Egypt (CBE)",
    iana_timezone: "Africa/Cairo",
    fatf_enhanced_monitoring: false,
  },

  // ── Europe ───────────────────────────────────────────────────────────────────

  GB: {
    country_code: "GB",
    country_name: "United Kingdom",
    local_currency: "GBP",
    accepted_currencies: ["GBP", "EUR", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "stripe",
        min_local: 1,
        max_local: 250_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 10_000,
        authority: "National Crime Agency (NCA) — Suspicious Activity Report",
        report_within_hours: 24 * 7, // 7 days
        legal_ref: "Proceeds of Crime Act 2002 (POCA) §330",
      },
    ],
    regulator: "Financial Conduct Authority (FCA)",
    iana_timezone: "Europe/London",
    fatf_enhanced_monitoring: false,
  },

  DE: {
    country_code: "DE",
    country_name: "Germany",
    local_currency: "EUR",
    accepted_currencies: ["EUR", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "stripe",
        min_local: 1,
        max_local: 250_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 10_000,
        authority: "Financial Intelligence Unit Germany (FIU)",
        report_within_hours: 24,
        legal_ref: "Geldwäschegesetz (GwG) §43",
      },
    ],
    regulator: "Bundesanstalt für Finanzdienstleistungsaufsicht (BaFin)",
    iana_timezone: "Europe/Berlin",
    fatf_enhanced_monitoring: false,
  },

  FR: {
    country_code: "FR",
    country_name: "France",
    local_currency: "EUR",
    accepted_currencies: ["EUR", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "stripe",
        min_local: 1,
        max_local: 250_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 10_000,
        authority: "Traitement du Renseignement et Action Contre les Circuits Financiers Clandestins (TRACFIN)",
        report_within_hours: 24,
        legal_ref: "Code Monétaire et Financier L561-15",
      },
    ],
    regulator: "Autorité de Contrôle Prudentiel et de Résolution (ACPR)",
    iana_timezone: "Europe/Paris",
    fatf_enhanced_monitoring: false,
  },

  // ── North America ─────────────────────────────────────────────────────────

  US: {
    country_code: "US",
    country_name: "United States",
    local_currency: "USD",
    accepted_currencies: ["USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "stripe",
        min_local: 1,
        max_local: 50_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "enhanced",
    withholding_tax_rate: 0.28, // US backup withholding rate
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 10_000,
        authority: "Financial Crimes Enforcement Network (FinCEN)",
        report_within_hours: 15 * 24, // 15 days
        legal_ref: "Bank Secrecy Act 31 USC §5313 — Currency Transaction Report (CTR)",
      },
    ],
    regulator: "Consumer Financial Protection Bureau (CFPB) / FinCEN",
    iana_timezone: "America/New_York",
    fatf_enhanced_monitoring: false,
  },

  CA: {
    country_code: "CA",
    country_name: "Canada",
    local_currency: "CAD",
    accepted_currencies: ["CAD", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "stripe",
        min_local: 1,
        max_local: 50_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 10_000,
        authority: "Financial Transactions and Reports Analysis Centre of Canada (FINTRAC)",
        report_within_hours: 24,
        legal_ref: "Proceeds of Crime (Money Laundering) and Terrorist Financing Act §7",
      },
    ],
    regulator: "Financial Consumer Agency of Canada (FCAC) / FINTRAC",
    iana_timezone: "America/Toronto",
    fatf_enhanced_monitoring: false,
  },

  MX: {
    country_code: "MX",
    country_name: "Mexico",
    local_currency: "MXN",
    accepted_currencies: ["MXN", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "conekta",
        min_local: 10,
        max_local: 100_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 100_000,
        authority: "Unidad de Inteligencia Financiera (UIF)",
        report_within_hours: 24,
        legal_ref: "Ley Federal para la Prevención e Identificación de Operaciones con Recursos de Procedencia Ilícita §17",
      },
    ],
    regulator: "Comisión Nacional Bancaria y de Valores (CNBV)",
    iana_timezone: "America/Mexico_City",
    fatf_enhanced_monitoring: false,
  },

  // ── Latin America ─────────────────────────────────────────────────────────

  BR: {
    country_code: "BR",
    country_name: "Brazil",
    local_currency: "BRL",
    accepted_currencies: ["BRL", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "pagar_me",
        min_local: 1,
        max_local: 50_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0.15,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 10_000,
        authority: "Conselho de Controle de Atividades Financeiras (COAF)",
        report_within_hours: 24,
        legal_ref: "Lei 9.613/1998 (Lei de Lavagem de Dinheiro) §11",
      },
    ],
    regulator: "Banco Central do Brasil (BCB)",
    iana_timezone: "America/Sao_Paulo",
    fatf_enhanced_monitoring: false,
  },

  CO: {
    country_code: "CO",
    country_name: "Colombia",
    local_currency: "COP",
    accepted_currencies: ["COP", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "wompi",
        min_local: 1_000,
        max_local: 30_000_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 10_000_000,
        authority: "Unidad de Información y Análisis Financiero (UIAF)",
        report_within_hours: 24,
        legal_ref: "Ley 526 de 1999 §16",
      },
    ],
    regulator: "Superintendencia Financiera de Colombia (SFC)",
    iana_timezone: "America/Bogota",
    fatf_enhanced_monitoring: false,
  },

  // ── Asia-Pacific ──────────────────────────────────────────────────────────

  IN: {
    country_code: "IN",
    country_name: "India",
    local_currency: "INR",
    accepted_currencies: ["INR", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "razorpay",
        min_local: 100,
        max_local: 500_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0.10, // TDS on payments to agents
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 1_000_000,
        authority: "Financial Intelligence Unit – India (FIU-IND)",
        report_within_hours: 7 * 24,
        legal_ref: "Prevention of Money Laundering Act 2002 §12",
      },
    ],
    regulator: "Reserve Bank of India (RBI)",
    iana_timezone: "Asia/Kolkata",
    fatf_enhanced_monitoring: false,
  },

  PH: {
    country_code: "PH",
    country_name: "Philippines",
    local_currency: "PHP",
    accepted_currencies: ["PHP", "USD"],
    supported_methods: [
      {
        method: "momo",
        gateway: "gcash",
        min_local: 50,
        max_local: 100_000,
        required_agent_fields: ["momo_number"],
      },
      {
        method: "card",
        gateway: "paymongo",
        min_local: 100,
        max_local: 500_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 500_000,
        authority: "Anti-Money Laundering Council (AMLC)",
        report_within_hours: 5 * 24,
        legal_ref: "Republic Act 9160 (AMLA) §9",
      },
    ],
    regulator: "Bangko Sentral ng Pilipinas (BSP)",
    iana_timezone: "Asia/Manila",
    fatf_enhanced_monitoring: false,
  },

  ID: {
    country_code: "ID",
    country_name: "Indonesia",
    local_currency: "IDR",
    accepted_currencies: ["IDR", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "midtrans",
        min_local: 10_000,
        max_local: 500_000_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 500_000_000,
        authority: "Pusat Pelaporan dan Analisis Transaksi Keuangan (PPATK)",
        report_within_hours: 24,
        legal_ref: "UU No 8 Tahun 2010 Tentang Pencegahan dan Pemberantasan TPPU §23",
      },
    ],
    regulator: "Otoritas Jasa Keuangan (OJK) / Bank Indonesia",
    iana_timezone: "Asia/Jakarta",
    fatf_enhanced_monitoring: false,
  },

  SG: {
    country_code: "SG",
    country_name: "Singapore",
    local_currency: "SGD",
    accepted_currencies: ["SGD", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "stripe",
        min_local: 1,
        max_local: 100_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "enhanced",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 20_000,
        authority: "Suspicious Transaction Reporting Office (STRO) / Commercial Affairs Department",
        report_within_hours: 72,
        legal_ref: "Corruption, Drug Trafficking and Other Serious Crimes (Confiscation of Benefits) Act §39",
      },
    ],
    regulator: "Monetary Authority of Singapore (MAS)",
    iana_timezone: "Asia/Singapore",
    fatf_enhanced_monitoring: false,
  },

  AU: {
    country_code: "AU",
    country_name: "Australia",
    local_currency: "AUD",
    accepted_currencies: ["AUD", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "stripe",
        min_local: 1,
        max_local: 100_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "standard",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: false,
    reporting_thresholds: [
      {
        amount_local: 10_000,
        authority: "Australian Transaction Reports and Analysis Centre (AUSTRAC)",
        report_within_hours: 10 * 24, // 10 business days
        legal_ref: "Anti-Money Laundering and Counter-Terrorism Financing Act 2006 §43",
      },
    ],
    regulator: "Australian Prudential Regulation Authority (APRA) / AUSTRAC",
    iana_timezone: "Australia/Sydney",
    fatf_enhanced_monitoring: false,
  },

  // ── Middle East ───────────────────────────────────────────────────────────

  AE: {
    country_code: "AE",
    country_name: "United Arab Emirates",
    local_currency: "AED",
    accepted_currencies: ["AED", "USD"],
    supported_methods: [
      {
        method: "card",
        gateway: "network_international",
        min_local: 10,
        max_local: 200_000,
        required_agent_fields: ["card_token"],
      },
    ],
    min_kyc_tier: "enhanced",
    withholding_tax_rate: 0,
    requires_regulatory_receipt: true,
    reporting_thresholds: [
      {
        amount_local: 55_000, // AED 55k ≈ USD 15k (UAE threshold)
        authority: "Financial Intelligence Unit (FIU UAE) / CBUAE",
        report_within_hours: 48,
        legal_ref: "Federal Decree-Law No 20 of 2018 on AML §15",
      },
    ],
    regulator: "Central Bank of the UAE (CBUAE)",
    iana_timezone: "Asia/Dubai",
    fatf_enhanced_monitoring: false,
  },

};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the CountryRequirement for a given ISO 3166-1 alpha-2 country code.
 * Throws if the country is not supported.
 */
export function getCountryRequirement(countryCode: string): CountryRequirement {
  const req = COUNTRY_REQUIREMENTS[countryCode.toUpperCase()];
  if (!req) {
    throw new Error(
      `Country "${countryCode}" is not supported. Supported codes: ${Object.keys(COUNTRY_REQUIREMENTS).join(", ")}`
    );
  }
  return req;
}

/**
 * Returns the PayoutMethodConfig for a specific method in a country.
 * Throws if the method is not supported there.
 */
export function getMethodConfig(
  countryCode: string,
  method: PayoutMethod
): PayoutMethodConfig {
  const req = getCountryRequirement(countryCode);
  const config = req.supported_methods.find((m) => m.method === method);
  if (!config) {
    throw new Error(
      `Payout method "${method}" is not supported in ${req.country_name} (${countryCode}). ` +
        `Supported: ${req.supported_methods.map((m) => m.method).join(", ")}`
    );
  }
  return config;
}

/**
 * Returns the list of all supported country codes.
 */
export function listSupportedCountries(): string[] {
  return Object.keys(COUNTRY_REQUIREMENTS);
}

/**
 * Returns all reporting thresholds breached by the given local-currency amount.
 */
export function getBreachedThresholds(
  countryCode: string,
  localAmount: number
): ReportingThreshold[] {
  const req = getCountryRequirement(countryCode);
  return req.reporting_thresholds.filter((t) => localAmount >= t.amount_local);
}

/**
 * Validates that the agent's KYC tier meets the country's minimum requirement.
 * tier ordering: basic < standard < enhanced.
 */
export function meetsKycRequirement(
  agentKycTier: KycTier,
  countryCode: string
): boolean {
  const order: Record<KycTier, number> = { basic: 0, standard: 1, enhanced: 2 };
  const req = getCountryRequirement(countryCode);
  return order[agentKycTier] >= order[req.min_kyc_tier];
}
