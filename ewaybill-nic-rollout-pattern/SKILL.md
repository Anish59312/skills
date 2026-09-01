---
name: ewaybill-nic-rollout-pattern
description: >-
  Explains and reuses the pattern india_compliance follows when NIC (the e-waybill portal) rolls out
  a new or changed API field/behavior ahead of a fixed production date, using the shipToGSTIN /
  shipToTradeName addition (PR #4342) as the worked example. Use this skill whenever a task involves:
  adding a new field to the e-waybill request/response payload, gating e-waybill behavior by a NIC
  rollout date, sandbox-vs-production differences for the e-waybill API, e-waybill transactionType
  (1/2/3/4, Regular / Bill To-Ship To / Bill From-Dispatch From / Combination), shipToGSTIN,
  shipToTradeName, or the "URP" unregistered-GSTIN convention. Reach for this before writing new
  e-waybill payload logic in india_compliance/gst_india/utils/e_waybill.py or
  india_compliance/gst_india/constants/e_waybill.py, so the date-gating and test patterns stay
  consistent with existing NIC-change implementations.
---

# E-Waybill NIC Change Rollout Pattern (india_compliance)

NIC periodically changes the e-waybill API contract (new mandatory/optional fields, new validation).
These changes are typically **live in the sandbox environment before production**, with NIC announcing
a fixed production go-live date. india_compliance encodes this as a **date-gated feature flag** rather
than a settings toggle, so the same code correctly serves both pre- and post-rollout behavior without
manual intervention on go-live day.

Worked example: **shipToGSTIN / shipToTradeName** (PR
[resilient-tech/india-compliance#4342](https://github.com/resilient-tech/india-compliance/pull/4342)).
NIC began requiring the e-waybill payload to carry the Ship-To party's GSTIN and trade name whenever
the consignee differs from the buyer — sandbox already enforced it while production would only start
on 2026-08-01.

## The gating pattern

1. **Constant** — `india_compliance/gst_india/constants/e_waybill.py`:
   ```python
   from frappe.utils import getdate

   # Date from which NIC requires shipToGSTIN/shipToTradeName in production
   # (already live in sandbox)
   E_WAYBILL_CHANGES_APPLICABLE_DATE = getdate("2026-08-01")
   ```
2. **Helper** — `india_compliance/gst_india/utils/e_waybill.py`:
   ```python
   def is_e_waybill_changes_applicable(settings=None):
       # changes are live in sandbox and apply in production from E_WAYBILL_CHANGES_APPLICABLE_DATE
       if not settings:
           settings = frappe.get_cached_doc("GST Settings")
       return settings.sandbox_mode or getdate() >= E_WAYBILL_CHANGES_APPLICABLE_DATE
   ```
3. **Call site** — guard the new payload keys with both the date gate *and* the semantic condition
   that determines whether the field is relevant at all (here, transaction type):
   ```python
   if (
       is_e_waybill_changes_applicable(self.settings)
       and self.transaction_details.transaction_type in SHIP_TO_TRANSACTION_TYPES
   ):
       data.update({
           "shipToGSTIN": self.ship_to.gstin,
           "shipToTradeName": self.ship_to.legal_name,
       })
   ```

This keeps the rollout binary and centrally controlled by one constant — bump the date (or update it
if NIC slips) and every call site follows, with zero settings/UI changes needed.

## Transaction types — when Ship-To even applies

The e-waybill `transactionType` field (`india_compliance/gst_india/constants/e_waybill.py`) has 4
values, and only two of them have a Ship-To party distinct from Bill-To:

| Code | Name | Ship-To ≠ Bill-To? |
|---|---|---|
| 1 | Regular | No |
| 2 | Bill To - Ship To | **Yes** |
| 3 | Bill From - Dispatch From | No |
| 4 | Combination of 2 and 3 | **Yes** |

```python
TRANSPORT_TYPES = {
    1: "Regular",
    2: "Bill To - Ship To",
    3: "Bill From - Dispatch From",
    4: "Combination of 2 and 3",
}
# transaction types where goods are shipped to an address different from Bill To
SHIP_TO_TRANSACTION_TYPES = (2, 4)
```

`transaction_type` itself is derived in `set_party_address_details` (`utils/e_waybill.py`) by comparing
the document's shipping/dispatch addresses against its billing addresses — check "both differ" (→ 4)
before the single-difference cases (→ 2 or 3), otherwise a type-4 transaction gets misclassified.

## Deriving the new field's value correctly

Don't just copy an existing party's fields — a new field like `shipToTradeName` needs its own
resolution rule. Here, the rule is: if the Ship-To GSTIN equals the Bill-To GSTIN (same legal entity,
different address), reuse the Bill-To party name; otherwise use the ship-to address's own title:

```python
self.ship_to.legal_name = (
    self.bill_to.legal_name
    if self.ship_to.gstin == self.bill_to.gstin
    else self.ship_to.address_title
)
```

This must run **after** `self.bill_to.legal_name` is resolved (party name vs address title logic),
since it depends on that value.

## URP convention

An unregistered consignee's GSTIN is sent as the literal string `"URP"` (Unregistered Person) — this
is an existing e-waybill-wide convention (also used for `toGstin`), not something invented for this
field. When a new party-like field is added, check whether it needs the same URP fallback.

## Sandbox GSTIN substitution

The sandbox environment uses whitelisted fake GSTINs, not real ones. Any new party field that carries
a GSTIN must also be routed through the existing sandbox substitution helper, or sandbox test calls
will send prod GSTINs to NIC's sandbox and fail:
```python
if self.ship_to.gstin:
    self.ship_to.gstin = _get_sandbox_gstin(self.ship_to, 1)
```

## Testing the rollout gate

Use `time_machine.travel` to freeze time on either side of the rollout date, and check the field is
*absent* before and *present* on/after — for both the live API payload and the offline JSON export
(`for_json=True`), since they can diverge:
```python
day_before_rollout = get_datetime(add_to_date(E_WAYBILL_CHANGES_APPLICABLE_DATE, days=-1))
rollout_date = get_datetime(E_WAYBILL_CHANGES_APPLICABLE_DATE)

with time_machine.travel(day_before_rollout, tick=True):
    data = EWaybillData(si).get_data()
    self.assertNotIn("shipToGSTIN", data)

with time_machine.travel(rollout_date, tick=False):
    data = EWaybillData(si).get_data()
    self.assertTrue(data.get("shipToGSTIN"))
```
Also cover: the field absent for transaction type 1 (Regular), present with a real GSTIN for type 2,
`"URP"` for an unregistered consignee, and mandatory-present for type 4 — see
`india_compliance/gst_india/utils/test_e_waybill.py::TestEWaybill` (search `ship_to_gstin` /
`E_WAYBILL_CHANGES_APPLICABLE_DATE`) for the full set.