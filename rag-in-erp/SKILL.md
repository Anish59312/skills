---
name: rag-in-erp
description: >-
  Explains how retrieval-augmented generation is actually built inside a Frappe/ERPNext bench in
  the rfq_intelligence app: hybrid BM25 (frappe's FTS5 SQLiteSearch) + dense retrieval (MariaDB
  native VECTOR columns and VEC_DISTANCE_COSINE), fused with reciprocal rank fusion, with the LLM
  used only to pick from a retrieved shortlist. Use this skill whenever a task involves semantic
  search, embeddings, a vector store, a knowledge base, "chat with my data", item/party matching,
  document-to-master matching, RRF, BM25 vs embeddings, chunking, or an LLM choosing among ERP
  records — and before adding any vector database, Chroma/FAISS/pgvector dependency, or writing a
  new retrieval or LLM-selection path in a Frappe app. Reach for it before designing retrieval so
  the infrastructure, quota discipline and hallucination guardrails match what already works here.
---

# RAG inside a Frappe/ERPNext bench

The working reference implementation is `apps/rfq_intelligence/rfq_intelligence/matching/` —
match an RFQ line ("stainless fasteners, 8mm thread") to an `Item` in a catalogue of thousands.
Every rule below came out of that build, and most were corrections to a first attempt.

## The one-line shape

```
query ──┬─▶ BM25 over SQLite FTS5    ─▶ ranked item codes ─┐
        │                                                  ├─▶ RRF ─▶ top ~20 ─▶ LLM picks one
        └─▶ cosine over MariaDB VECTOR ─▶ ranked item codes ┘                        │
                                                                                     ▼
                                                                        {item_code | null, confidence, reason}
```

Retrieval is deterministic and local. The model is a **chooser over a shortlist**, never a source
of facts and never a source of numbers.

## Zero new infrastructure — this is the important part

Do not add Chroma, FAISS, pgvector, numpy, or a search service. None are installed in this bench
and none are needed.

| Half | What it runs on |
|---|---|
| Sparse / BM25 | `frappe.search.sqlite_search.SQLiteSearch` (frappe v17) — FTS5, incremental indexing already wired into `doc_events` + scheduler. Subclass + one `sqlite_search` hook. |
| Dense / vector | MariaDB 11.7+ native `VECTOR(n)` columns, HNSW `VECTOR INDEX`, `VEC_DISTANCE_COSINE()`. One extra SQL table in the site DB. |
| Embeddings + LLM | Provider REST API via `requests`. No SDK — `google-genai` pins `google-auth` outside frappe's supported range. |

### The MariaDB vector table

DocTypes cannot express a `VECTOR` field, so this is a plain SQL table
(`apps/rfq_intelligence/rfq_intelligence/matching/vector.py`):

```sql
CREATE TABLE `__rfq_item_embedding` (
  id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_code    VARCHAR(140) NOT NULL,
  content_hash CHAR(64)     NOT NULL,
  embedding    VECTOR(768)  NOT NULL,
  UNIQUE KEY uk_item (item_code),
  VECTOR INDEX (embedding)
);
```

Three traps, all verified against a live server:

- **The natural primary key is rejected.** A vector index needs a PK ≤ 256 bytes; `VARCHAR(140)`
  under utf8mb4 is 560. Hence the surrogate `BIGINT` with `item_code` as a unique key.
- **Frappe refuses DDL inside an open write transaction** (`ImplicitCommitError`), so
  `frappe.db.commit()` must precede every `CREATE`/`DROP`.
- **Dimension is config, not code.** Changing it invalidates every stored vector — detect the
  current column width from `information_schema` and rebuild rather than migrate.

## Why hybrid, concretely

Neither half is optional, and the reason is specific to ERP data:

- **Embeddings cannot tell `6204-2RS` from `6205-2RS`.** They are near-identical strings for a
  different bore diameter. BM25 separates them trivially. Part numbers, thread sizes, HSN codes,
  GSTINs, batch ids — the identifiers ERP runs on — are exactly where dense retrieval is weakest.
- **BM25 cannot match a paraphrase.** "half kilo pack" → the 500g grease needs semantics.

So: run both, fuse by rank.

### Fusion is by rank, never by score

BM25 relevance is unbounded term-frequency; cosine similarity is a bounded distance. Weighting
them directly needs constants that drift the moment the catalogue or embedding model changes.
Reciprocal rank fusion uses only rank order:

```
score(doc) = Σ over lists  1 / (k + rank_in_that_list)      # k = 60
```

At k=60 rank 1 scores 1/61 and rank 2 scores 1/62 — close enough that **an item found by both
engines outranks one found first by a single engine**. That consensus preference is the entire
point. Break ties deterministically (by id) so identical inputs produce an identical prompt.

## Indexing rules that were learned the hard way

**Sparse half** (`apps/rfq_intelligence/rfq_intelligence/matching/lexical.py`):

- **`tokenchars` is load-bearing.** `"unicode61 remove_diacritics 2 tokenchars '-_/.'"` keeps
  `M8-1.25/SS` as one token. The default tokeniser shreds it into fragments and destroys the
  precision this half exists to provide.
- **Frappe's indexer rejects a document whose content field is `None`.** Mapping `content` to
  `description` silently made every item with a null description invisible. Map `content` to a
  field that is always present, and append the rest in `prepare_document()`.
- **OR the query terms, don't AND them.** The framework default joins terms with a space, which
  FTS5 reads as implicit AND. A customer writing "High-Pressure Stainless Steel Control Valve
  3/4in NPT" against a catalogue entry "Control Valve 3/4in NPT" returns *zero rows*. With OR,
  BM25 still ranks more-matching documents higher. Precision is recovered downstream by RRF's
  top-N cut and the model's final choice — recall at this layer, precision at the next.

**Both halves:** fold the highest-precision identifiers into the indexed text — `Item Customer
Detail.ref_code` (the customer's own part number), item code, barcodes. An RFQ that quotes
`NW-4471-A` and nothing else is otherwise unmatchable. Repeat the part number first in the query
string, since BM25 weights term frequency.

**Asymmetric embedding:** use the provider's task types — `RETRIEVAL_DOCUMENT` when indexing,
`RETRIEVAL_QUERY` when searching. Catalogue entries and query lines are different roles and
embedding them identically costs recall.

## Index maintenance: never call an API from a doc event

`Item.on_update` fires once per row of a bulk import. An embedding call there exhausts a rate
limit in seconds.

- `on_update` **only flags dirty** — a SQL update blanking `content_hash`. No network.
- An **hourly scheduled sweep** embeds everything flagged, in batches of 100.
- `content_hash` (sha256 of the indexable text) makes re-runs free. A no-op save, a nightly
  sweep, or a developer re-testing all cost nothing.

## Quota discipline shapes the architecture

The binding constraint on a free tier was **20 requests per day per model** — not per minute.
Three consequences that generalise to any metered provider:

1. **Batch per document, never per line.** Matching an RFQ of any size costs exactly two calls:
   one batched embedding call for all queries, one selection call for all lines. Per-line calls
   would burn a whole day on four documents.
2. **The quota is per model, so use different models per stage.** Extraction and matching draw on
   independent budgets. A free doubling of throughput for one config field.
3. **Cache the expensive stage on a content hash** with a TTL. On a 20/day budget this is a quota
   control, not an optimisation.

Detect a per-day 429 and **raise immediately** rather than retrying — backoff burns 90 seconds to
reach the same answer. Surface the quota name, value and model in the error.

## Guardrails — the part that makes it safe to ship

- **The model may only choose from what it was shown.** Validate the returned id against the
  shortlist set; anything else is invention. Log it and treat the line as unmatched. This is what
  makes hallucination structurally impossible rather than merely unlikely.
- **`null` / no-match is a first-class answer,** stated as such in the prompt. "Three phase
  induction motor" against a catalogue without one must return No Match, not snap to a neighbour.
  Quoting the wrong product is far more damaging than admitting no match.
- **Confidence routes to a human.** Below a configurable floor → `Needs Review`, not silently
  used. Instruct the model that a well-calibrated low score is the *desired* outcome.
- **Store `method`, `confidence`, `reason` and the candidate list on the row** so a reviewer sees
  why. Retrieval that cannot be audited cannot be trusted.
- **Degrade, don't fail.** If vector retrieval throws, log and continue with BM25 alone. Losing
  dense recall on paraphrased lines is bad; losing the whole match step helps nobody.
- **The LLM never produces a number.** It extracts and it matches. Every rate comes from a
  deterministic engine reading ERP masters. The same principle one level down: don't ask a model
  to split `"50 - 60"` into two floats — return the cell verbatim and let Python split it.
  Deterministic string work belongs in code.

## Prompting notes specific to structured output

- **Mark every schema field `required`.** Flash-tier models simply omit optional fields.
- **Flash models write deliberation into the next string field.** Observed in a UOM field:
  `"Nos Japanese/Nos format preserved as Nos? Yes verbatim: Nos. Expected price: 50 - 60"`.
  Parse defensively — for a one-word field, keep the leading token.
- **Clamp every string at the boundary.** Frappe `Data` columns are VARCHAR(140); truncate and log
  rather than letting one absurd field fail the save.
- **A prompt rule can defeat itself.** "Never suggest a price" with a caveat about transcribing the
  customer's own budget dropped the budget column entirely. Split into two numbered rules and
  rename the field (`customer_stated_budget`) so it cannot read as a price the model is proposing.

## Applying this elsewhere in an ERP

The shape transfers to any "free text → master record" problem: bank narration → Party/Account,
purchase invoice line → Item, address blob → Customer, support text → Item Group. Swap the corpus
definition and the prompt; the retrieval stack, RRF, guardrails and quota discipline are
unchanged. `rapidfuzz` (an ERPNext dep) is a cheap pre-filter or tie-breaker on near-identical
names — and strip legal-form suffixes before comparing party names ("Northwind Engineering Pvt.
Ltd." scores 80.8 against "Northwind Engineering", below a strict threshold of 88; stripping
takes it to 100).

Log every outbound API call through the stock `Integration Request` doctype — request/response
inspection for free, and it is the established Frappe pattern.

## Checklist for a new retrieval feature

1. Define the corpus: which doctype, which fields, which filters (`disabled = 0`, etc.), and which
   child-table identifiers to fold in.
2. Subclass `SQLiteSearch`, set `tokenchars`, register in `hooks.py` under `sqlite_search`.
3. Create the vector table (`after_install` + a patch), dimension from settings.
4. `on_update` → flag dirty; scheduled sweep → embed in batches; hash-gate re-embeds.
5. Retrieve both halves, RRF at k=60, cut to ~20.
6. One batched model call, strict schema, all fields required, no-match allowed.
7. Reject any id outside the shortlist. Persist confidence + rationale. Flag low confidence.
8. Test the case that motivates the hybrid: an exact part-number query must rank its item first
   (pure vector fails this), and a paraphrase must still match (pure BM25 fails this).
