# Login Page — Compliance Copy Rewording

**Status:** Working document. v1.0, drafted 2026-05-22.
**Purpose:** Replacement copy for the four compliance references on the login page (HIPAA, PCI-DSS, ISO 28000, AML/KYC). The current copy reads as if the platform itself holds these certifications. The platform does not. This document gives reworded alternatives that frame the references as *what the platform helps clients address*, not *what the platform is certified as*.

**Companion to:** `STOPGAP_EXECUTION.md` task D.

---

## The rewording principle

Every line answers the question **"what does the platform help the client do under this framework?"** It does not answer **"what is the platform certified as?"**

Verbs that work: *supports, helps you, helps your team, designed for, built to accommodate, provides building blocks for, aligns with.*

Verbs that lie: *is, certified, compliant, accredited, audited, attested.*

A short disclaimer beneath the four references makes the framing explicit so a careful reader cannot misread the claim.

---

## Three options, by visual constraint

The right option depends on how much room the current login page has for copy. Option A is the safest default and the lightest paste. Options B and C give more space to the framing if the current design supports them.

### Option A — Single-line, framework names only (recommended default)

Replace whatever currently sits as the compliance line / badge row with:

> Supports client workflows aligned with HIPAA, PCI-DSS, ISO 28000, and AML/KYC obligations.

Add this disclaimer directly beneath (smaller font, muted colour, but readable):

> Framework references describe the obligations the platform helps clients address, not certifications the platform itself holds.

**When to use:** the current login page has one line or one badge-row for compliance copy and no obvious room to expand. This is the smallest defensible replacement.

### Option B — One short sentence per framework (recommended when there's room)

Replace whatever currently sits as the compliance copy with four short lines:

> - **HIPAA** — supports audit logging, scoped access, and encryption patterns for workflows that handle protected health information.
> - **PCI-DSS** — designed to help merchant workflows scope cardholder data via tokenization and access boundaries.
> - **ISO 28000** — accommodates supply-chain security practices with traceability and chain-of-custody primitives.
> - **AML/KYC** — provides building blocks (identity verification hooks, risk-scoring fields, audit trails) for compliance programs configured by your team.

Add the same disclaimer directly beneath:

> Framework references describe the obligations the platform helps clients address, not certifications the platform itself holds.

**When to use:** the current login page has a panel, sidebar, or footer section that fits four short lines. This option gives the reader a concrete sense of what the platform actually contributes under each framework, which is more useful than a name-only list.

### Option C — Prose paragraph (use only if the existing design is prose-oriented)

Replace whatever currently sits with:

> The platform provides workflow primitives — audit logging, scoped access controls, encryption in transit and at rest, identity verification hooks, traceability and chain-of-custody fields, and tokenization patterns — that help your team operate under frameworks such as HIPAA, PCI-DSS, ISO 28000, and AML/KYC. The platform itself is not certified under any of these frameworks; its role is to give your compliance program the building blocks it needs to be configured to your jurisdiction and your obligations.

**When to use:** the login page is text-heavy (rare for a login page), or you want a single prose block instead of a list. The downside is that it reads as more of a marketing paragraph, which is heavier than most login pages want.

---

## What to remove alongside the rewording

While editing the login page file, also remove or fix:

1. **Any third-party badges or shields that imply certification.** SVG/PNG shields for HIPAA, PCI-DSS, ISO, etc. — if they're rendering as official-looking seals, take them out. A line of plain text is honest; a shield-with-checkmark is not.
2. **Demo credentials line.** Covered by `STOPGAP_EXECUTION.md` task C — the line that displays an email / password example. Remove the entire line, not just the credentials.
3. **Privacy policy and Terms of Service links** — if they point at routes that don't resolve to actual documents (the gap map marks these as ❓), either remove the links until the documents exist, or have a placeholder page that says "in preparation" rather than a 404. A broken legal link on a login page is its own credibility problem.

---

## Where to apply this

The edit is to the login page file located via:

```bash
grep -rn "HIPAA\|PCI-DSS\|PCI DSS\|ISO 28000\|AML/KYC\|AML KYC" src/ 2>/dev/null
```

If the compliance copy is in a shared footer component used on other pages, the rewording applies wherever that footer renders, not only on the login page. The same discipline applies — the platform does not hold these certifications anywhere it claims them.

---

## Verification after deploying

Two checks:

1. **Read the login page as a hostile prospect.** Read every line aloud, and after each, ask: "is the platform claiming this is what it is, or what it helps me do?" Every line should land cleanly on the second. If a line could be read either way, rewrite it.
2. **`view-source:` check.** Open the login page in a browser, view source, and search for the four framework names. Confirm there are no leftover `alt="HIPAA Certified"` attributes, no badge image filenames containing "certified", "compliant", "accredited". Stragglers in image alt text are the most common leak.

---

## Change log

- **2026-05-22** — v1.0 initial draft. Three options provided; project lead chooses A / B / C based on the current login page's visual constraints.
