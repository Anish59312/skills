---
name: gst-isd-distribution
description: >-
  Apply the business logic of India's GST Input Service Distributor (ISD) mechanism — the rules for
  distributing common Input Tax Credit (ITC) on input services from a head office to branch GSTINs
  under the same PAN. Use this skill whenever a task involves ISD, ITC distribution, common credit
  allocation, the C1 = (t1/T) × C turnover formula, CGST/SGST/IGST conversion across states, Rule 39
  or Section 20 of the CGST Act, GSTR-6 / GSTR-6A filing, ISD invoices, or RCM credit distribution —
  AND when building, reviewing, or debugging software, ERP modules, spreadsheets, or accounting logic
  that computes ISD distribution, even if the user only describes the workflow ("split shared audit
  fees across branches by turnover") without naming ISD explicitly. Reach for this skill before
  computing or coding any ITC split so the tax-head conversion and attribution rules are applied
  correctly, since errors here cause ITC recovery with interest.
---

# GST Input Service Distributor (ISD) — Distribution Logic

The ISD mechanism lets a single office (usually the head office) receive vendor invoices for
**common input services** and pass the resulting Input Tax Credit (ITC) to the branch registrations
("recipients" / "distinct persons") that actually benefit. Mandatory from **1 April 2025**.

This skill encodes the computational rules so distributions are correct whether you are advising a
practitioner, filling GSTR-6, or implementing the logic in code. It is **not** legal advice: tax law
changes, so when statutory specifics (notification numbers, effective dates, the latest Rule 39 text)
matter to the output, verify against the current CBIC position rather than relying on memory.

## Scope — what ISD does and does not cover

- **Only input *services*.** ITC on goods (inputs) and capital goods is **never** distributed via ISD;
  the branch that uses them claims it directly. If a task tries to distribute goods/capital-goods ITC
  through ISD, flag it as out of scope.
- **Recipients share one PAN, different GSTINs.** Credit cannot go to outsourced vendors or third
  parties, only to distinct persons under Section 25.
- **RCM credit is included.** ITC on services under reverse charge (CGST §9(3)/9(4), IGST §5(3)/5(4))
  is distributable through ISD. The ISD itself cannot *pay* tax — a regular GSTIN in the ISD's state
  pays the RCM, raises an invoice (Rule 54(1A)) transferring the credit to the ISD, which then
  distributes it like any other inward credit. See `references/rule39-legal-reference.md`.
- **ISD vs cross-charge.** ISD is for **externally procured** common services. Internally generated
  inter-branch services use **cross-charge** (a taxable supply, not ISD). Do not mix the two.

## The distribution algorithm

Run this for each inward credit (each invoice's ITC). Process **eligible** and **ineligible** ITC
separately, and process each **tax head** (CGST, SGST/UTGST, IGST) separately — never merge them
before the conversion step.

### Step 1 — Determine attribution (who the credit goes to)

| Service is used by… | Distribute to |
|---|---|
| Exactly one recipient | That recipient only — the **whole** amount, no turnover split |
| Some recipients (not all) | Those recipients, pro-rata by turnover |
| All recipients | All recipients, pro-rata by turnover |

Let **R** = the set of recipients the service is attributable to. Critically, **R includes recipients
who make exempt supplies and recipients who are unregistered** — their share is still computed (it
just may not be claimable by them). Excluding them inflates everyone else's share and is a common bug.

### Step 2 — Pro-rata split (Rule 39(1)(f))

For each recipient **R1** in **R**, for each tax head, the credit is:

```
C1 = (t1 / T) × C
```

- **C1** = ITC allotted to recipient R1 (for this tax head)
- **t1** = turnover of R1 in the *relevant period*
- **T** = aggregate turnover of all recipients in **R** during the relevant period
- **C** = total credit (of this tax head) being distributed

If R has only one recipient, the share is 1 (skip the formula).

**Relevant period** for turnover:
- Default: the **financial year preceding** the year of distribution (if every recipient in R had
  turnover then).
- Fallback: if some/all recipients had no turnover in that FY, use the **last quarter** before the
  distribution month for which turnover of *all* recipients is available.

**Turnover** here is turnover in the State/UT, reduced by non-GST levies (Constitution Seventh
Schedule: List I entries 84 & 92A — excise/customs; List II entries 51 & 54 — petroleum/State VAT).

### Step 3 — Convert by tax head and recipient location (the error-prone part)

After computing each recipient's share, convert based on whether the recipient is in the **same**
State/UT as the ISD or a **different** one:

| Credit at ISD | Recipient location | Distributed as |
|---|---|---|
| IGST | Same **or** different State/UT | **IGST** (always — IGST is never converted) |
| CGST | Same State/UT as ISD | CGST |
| SGST / UTGST | Same State/UT as ISD | SGST / UTGST |
| CGST **+** SGST/UTGST | **Different** State/UT | **IGST** = (CGST share + SGST/UTGST share), combined |

Mnemonic: *IGST stays IGST; CGST+SGST stays put only for same-state recipients, otherwise it fuses
into IGST.* (Note: Section 20 phrases IGST distribution as "integrated tax or central tax", but
Rule 39 operationalises it as IGST to every recipient — follow Rule 39.)

### Step 4 — Validate and reconcile

- **Conservation:** total distributed must equal total available; it must **never exceed** it
  (Rule 39(1)(b)). Excess/wrongly distributed credit is recovered from the recipient **with interest**
  under §73/74/74A — so over-distribution is a hard error, not a rounding nicety.
- **Rounding:** distribute to the working precision (paise / 2 decimals), then assign the leftover
  residual (available − sum of allotted) to one recipient — conventionally the largest by turnover —
  so the totals reconcile exactly. Do this per tax head.
- **Timing:** credit available in a month must be distributed **in that same month**; deferral is not
  permitted. Reported via the monthly ISD invoice and GSTR-6.
- **Credit notes:** a supplier credit note that reduces ITC is apportioned to recipients in the **same
  ratio** as the original distribution; if the reduction exceeds a recipient's available credit, the
  excess is added to that recipient's output tax liability. Debit notes add ITC, distributed in the
  month they appear in GSTR-6.

## Worked example

ISD in **Maharashtra**. Common legal service invoice with **CGST ₹9,000 + SGST ₹9,000** (intra-state
to the ISD). Used by all three branches. Preceding-FY turnover → shares: Maharashtra 25%, Karnataka
40%, Gujarat 35%.

- **Maharashtra (same State as ISD):** CGST 9,000×25% = ₹2,250 and SGST = ₹2,250 → stays **CGST ₹2,250
  + SGST ₹2,250**.
- **Karnataka (different State):** CGST 3,600 + SGST 3,600 → fuse → **IGST ₹7,200**.
- **Gujarat (different State):** CGST 3,150 + SGST 3,150 → fuse → **IGST ₹6,300**.

Check: 2,250+2,250+7,200+6,300 = ₹18,000 = total available. ✔

If the same invoice had been **IGST ₹18,000**, every branch would receive **IGST** (4,500 / 7,200 /
6,300) regardless of location.

## Reference implementation

`scripts/isd_distribute.py` is a clean, dependency-free Python implementation of Steps 1–4 (pro-rata
split, same/different-state conversion, eligible/ineligible separation, rounding reconciliation, and
the conservation check). Read it when building or reviewing distribution code — adapt it rather than
re-deriving the conversion logic from scratch. Run `python scripts/isd_distribute.py` to see it
reproduce the worked example above.

## Implementation note — the ISD invoice is split into two documents (india_compliance)

In the `india_compliance` (Frappe/ERPNext) app the older single **ISD Invoice** doctype has been
re-architected into **two** submittable documents that share a base controller `ISDController`
(`gst_india/controllers/isd_controller.py`, holding the common address / GSTIN / turnover / account /
tax-row validations). This mirrors the real flow: credit *leaves* one registration and is *received*
by another, so each side is its own document. The Rule 39 conversion helpers live in
`gst_india/utils/isd.py` (`calculate_distribution`, `is_inter_state_distribution`, `get_source_head_itc`).

- **ISD Distribution Invoice** — the **distributor / head-office (ISD)** side. Sourced from a Purchase
  Invoice (one that is `is_isd_applicable`, i.e. billed to an ISD-category address). It carries the
  turnover ratio (`branch_turnover / total_turnover`), a child table **ISD Source Item** (one row per
  Purchase Invoice item, holding `total_<head>` = the PI item's ITC and `distributed_<head>` = the
  amount allotted to the recipient), and an **ISD Tax Item** table booking the credit being reduced.
  `calculate_distribution()` applies the Step 3 conversion into the `distributed_*` fields, and
  `validate_distribution_limits()` enforces the conservation rule (Rule 39(1)(b)) across every
  distribution of the same PI (credit notes carry a negative ratio and may not over-reverse).
- **ISD Recipient Invoice** — the **recipient / branch** side. Books the credit *received*
  (`distributed_<head>`). It may reference the originating Distribution Invoice via
  `isd_distribution_invoice_reference`; when it does, `reconcile_distributed_amounts()` checks the
  received amounts match, per tax head, what was distributed (GSTINs, PAN, and credit-note status must
  also agree). Without a reference it is a standalone manual entry.

### The two workflows differ only in which side "owns" the tax-head conversion

Step 3 (IGST stays IGST; CGST+SGST stays put same-state, fuses to IGST different-state) is computed on
the **Distribution** side and stored in the Source Item `distributed_<head>` fields; the **Recipient**
side simply receives those figures. So the same PI produces different head splits on each side
depending on the recipient's location:

| Source (PI) credit | Distributor ↔ recipient state | Distributor books (Tax Item = source heads) | Recipient receives (`distributed_*` = converted heads) |
|---|---|---|---|
| IGST | same **or** different | IGST | **IGST** |
| CGST + SGST | **same** state | CGST + SGST | **CGST + SGST** |
| CGST + SGST | **different** state | CGST + SGST (unchanged) | **IGST** (CGST+SGST fused) |

Key point when coding or reviewing: the **distributor's** Tax Item always reflects the *source* heads
being reduced, while the **recipient's** `distributed_*` reflects the *converted* heads. They match
head-for-head only for same-state distributions; for different-state distributions the distributor
still shows CGST+SGST but the recipient shows IGST. Conservation must still hold: the recipient's fused
IGST equals the distributor's CGST + SGST for that row.

## Compliance touchpoints (so generated advice/UX is complete)

- **ISD invoice** under Rule 54(1) for every distribution; for RCM-credit transfer, Rule 54(1A).
- **GSTR-6** filed monthly by the **13th** of the following month; **no annual return** (no GSTR-9).
- Recipients see distributed credit auto-populated in **GSTR-6A** and must actively claim it in their
  **GSTR-3B** — it is **not** transferred automatically.
- Separate ISD registration (Serial 14 of REG-01); a GSTIN registration alone cannot distribute credit.

## When details must be exact

For statutory citations, current notification numbers, effective dates, penalty quantum, or any
edge case the user will rely on for filing, consult `references/rule39-legal-reference.md` and then
**verify against the live CBIC source**, because amendments are frequent in this area. State the
assumption (e.g., which relevant period or turnover figures you used) alongside any computed result.
