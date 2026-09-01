# Structuring a Desk spec suite

Everything below is about the *second* problem — once `bench run-ui-tests` runs at all, how the
`cypress/` tree should be laid out so it stays readable past the third spec.

## Folder layout

```
apps/<app>/
  cypress.config.js            # app root — bench chdirs here
  cypress/
    e2e/
      purchase_invoice.cy.js   # flat; one file per doctype/concern
    support/
      e2e.js                   # supportFile (Cypress default)
      session.js               # login + desk bootstrap
      test_records.js          # accessors over the app's test-record JSON
      controllers/
        base.js
        form.js
        transaction.js
```

`e2e/` and `support/` are the two Cypress ≥10 defaults (`specPattern:
cypress/e2e/**/*.cy.{js,jsx,ts,tsx}`, `supportFile: cypress/support/e2e.js`). Don't override either
— the folder names read badly ("e2e" is a directory of specs, not a category of test) but every
Cypress doc, error message, and third-party plugin assumes them, and renaming buys nothing.

**Keep the specs flat.** A `cypress/e2e/transactions/` next to a `cypress/pages/transactions/` is
indistinguishable at a glance in an editor tab bar, and `--spec` paths become long. Nest only once a
single directory genuinely exceeds ~15 files.

**Put helpers under `support/`, not a sibling top-level directory.** `support/` already means
"things loaded in aid of specs"; a top-level `cypress/pages/` invents a second such concept.

## Controllers, not page objects

The [Cypress Best Practices](https://docs.cypress.io/app/core-concepts/best-practices) page argues
against the Page Object Model, and there is no official folder for one. But a Desk form is a real
abstraction — the same "set a link field, wait for the server-side fetch, read `cur_frm.doc`" dance
recurs in every spec — so *something* has to hold it.

Name that thing after what ERPNext already calls it. `erpnext/public/js/controllers/` holds
`transaction.js`, `buying.js`, `accounts.js`, `stock_controller.js`, `taxes_and_totals.js`. Mirroring
those names means a reader who knows the app knows immediately what layer they're in, and it avoids
"page" — which in a Desk app collides with the actual `Page` doctype and with `frappe.ui.Page`.

Layer it the way the client scripts are layered:

```
BaseController        wait_for_settle(), assert_no_modal()
  FormController      open_new/open, fill, set_link, grid(), doc(), save(), assert_status()
    TransactionController   set_supplier(), add_item(), assert_*_tax_heads()
```

**One controller per level of the hierarchy that actually has distinct behaviour — not one per
doctype.** A `purchase_invoice.js` controller holding nothing but `new TransactionController("Purchase
Invoice")` is a file that exists to be imported. Pass the doctype to the constructor instead:

```js
const page = new TransactionController("Purchase Invoice");
```

Likewise, don't split `buying.js` out of `transaction.js` until there is a `selling.js` that would
otherwise duplicate it. Buying-only methods (`set_supplier`, `set_bill_no`) sitting on
`TransactionController` cost nothing; a two-method class in its own file costs a hop every time
someone reads a spec.

Every mutating method should `return this` (or a Cypress chain) so specs read as a sequence.

### `wait_for_settle`

The single most useful method on the base class:

```js
wait_for_settle() {
    cy.window({ log: false }).should((win) => {
        expect(win.frappe && win.frappe.app, "desk booted").to.be.ok;
        expect(win.frappe.request.ajax_count, "requests settled").to.eq(0);
    });

    return this;
}
```

It must be inside `.should()`, not `.then()` — `should` retries until the assertion passes, `then`
samples once. This is the same check `cy.desk_ready()` makes, minus the "main section non-empty"
part, so it is safe to call mid-form after a link field triggers a fetch.

### Read state from `cur_frm.doc`, not the DOM

```js
doc() {
    return cy.window({ log: false }).its("cur_frm.doc");
}
```

Server-computed values (tax rows, totals, `place_of_supply`) land in the doc before they land in the
DOM, and the DOM representation changes between frappe versions. Assert against the doc:

```js
this.doc().should((doc) => {
    const heads = doc.taxes.map((row) => row.account_head);
    expect(heads, "two tax rows").to.have.length(2);
});
```

Reserve DOM assertions for things that only exist in the DOM — the status indicator, an
`msgprint`, a button's disabled state.

### Grids

Wrap child tables in their own small class returned by `FormController.grid(fieldname)`, so a spec
says `page.grid("items").set_link(1, "item_code", …)`. Two non-obvious bits:

- `ensure_rows(n)` must read the existing row count first and click `.grid-add-row` only the
  shortfall — a fresh transaction form often already has one blank row.
- Collapse the row after filling it (`.grid-collapse-row`). An open grid row overlays the fields
  below it and later `cy.fill_field` calls silently target the wrong input.

## Accessing test records from a spec

Most Frappe apps already ship a `<app>/tests/test_records.json` consumed by a `before_tests` hook.
Reusing it from Cypress is the right instinct — the records are already there, already named, and
already the ones the Python suite trusts.

**Import the JSON statically.** Cypress bundles the support file and each spec file *separately*, so
a module holding state populated in a `before()` hook gets a second, empty instance inside the spec.
Only a static import is shared:

```js
import records from "../../<app>/tests/test_records.json";
```

Expose a small generic API rather than one named export per record:

```js
export function get(doctype, name)              // -> single object, dot access
export function find(doctype, property, value)  // -> array of matching objects
```

`get()` should throw with the file path and a hint when the name misses — a spec that fails at
import time with "No Supplier named X in <path>; has the record been renamed?" is far cheaper to
diagnose than one that fails 40 seconds later on a blank link field.

Resist adding semantic exports (`intra_state_supplier`, `service_item`, …). Each one is a second
place to update when a record changes, and they are only ever used once.

Records in the JSON often lack a `name`, because frappe autonames them. Derive it:

```js
const NAME_FIELD = { Item: "item_code" };   // exceptions only

function docname(doctype, record) {
    const field = NAME_FIELD[doctype] || `${doctype.toLowerCase().replace(/ /g, "_")}_name`;
    return record.name || record[field];
}
```

That covers the `field:<doctype>_name` autoname convention (Company → `company_name`, Supplier →
`supplier_name`, …), falls back to an explicit `name` where one exists, and needs an entry in
`NAME_FIELD` only for the genuine exceptions. Verify the mapping once with a throwaway node script
that resolves a docname for every record in the file — a silent `undefined` here surfaces as an
unhelpable link-field failure.

### The alternatives, and why the static import wins

| Approach | Verdict |
| --- | --- |
| Static JSON import | Synchronous, usable at `describe()` body level. Describes the *file*, not the site — a record deleted on the site still resolves. |
| `cy.get_list(doctype, fields, filters)` | Honest — reads the real site. But async, so it can't populate a `const` at describe level, and it can't express child-table predicates. |
| `cy.fixture()` | Needs `fixturesFolder` repointed at the app's tests dir, still async, buys nothing over the import. |
| A `@whitelist_for_tests` python helper | Full query power, but a round trip per lookup and another file to maintain. |

Cheap belt-and-braces: one `cy.get_list` existence check in `bootstrap()` for a single sentinel
record, so a site that never ran `before_tests` fails once with a clear message instead of once per
spec with a link-field timeout.

## Auditing which test records to keep

Before reusing an app's `test_records.json`, grep every record name across the repo. Typical
findings:

- **Records only one Python test uses**, which nonetheless pull a whole ERPNext subsystem (fixed
  assets, manufacturing) into every `before_tests`. Move those into that test's own `setUpClass`.
- **Records with zero references.** Delete.
- **JSON files under `<app>/<module>/data/`** that look like test records but are API request/response
  payload fixtures. Not documents; leave them.

Only the first category — parties, items, companies, addresses — is usable by a UI test anyway,
because those are the only ones a Desk form can transact with.

## Session bootstrap

Export plain functions from `support/session.js` rather than registering Cypress commands. There is
no global namespace to collide with, so no prefix is needed, and the import site documents where the
helper came from.

```js
export function bootstrap() {
    cy.login();
    cy.visit("/desk");
    cy.desk_ready();
    // ...app-specific quieting, see below
}
```

`cy.login()` wraps `cy.session([email, password], setup)`, so repeat calls inside a spec restore from
cache and do not re-authenticate. Frappe does **not** pass `cacheAcrossSpecs: true`, so the login does
happen once per spec file. That is per-file overhead you cannot avoid without patching frappe;
budget for it rather than trying to share state across specs.

### Modals that block every subsequent test

With `testIsolation: false`, a modal raised once is still there in the next `it()`, sitting over the
page behind a backdrop. Apps that `msgprint` on `app_ready` (upgrade notices, feature announcements)
will break the whole spec file this way.

Suppress them server-side in `bootstrap()`, and only if they're actually pending:

```js
cy.window({ log: false }).then((win) => {
    const defaults = win.frappe.boot.sysdefaults || {};
    if (!NOTIFICATION_KEYS.some((key) => Number(defaults[key]))) return;

    cy.call("<app>.tests.ui_test_helpers.suppress_notifications");
    cy.reload();
    cy.desk_ready();
});
```

On the python side, `frappe.defaults.clear_default(key)` with **no `parent`** — `bootinfo.sysdefaults`
merges `__default`, `__global` and the user's own row, so clearing only one leaves the flag set.
Follow it with `frappe.defaults.clear_user_default(key)` to invalidate the requesting user's cache,
which `clear_default` only does when handed that user as `parent`.

Frappe's `clear_dialogs()` and `clear_datepickers()` commands are the blunt version, useful in an
`afterEach`.

## Blocking third-party egress

If the app calls an external API, a stray `cy.visit` onto a settings page can hit **production**.
Sandbox flags are usually not enough — they typically just prefix the URL path and still egress.
Kill it at the network layer in `support/e2e.js`:

```js
beforeEach(() => {
    cy.intercept("https://api.vendor.example/**", { forceNetworkError: true });
});
```

`forceNetworkError` rather than a stub response, because a stub teaches the suite to depend on a
shape you invented. Fail loudly instead, then stub deliberately in the one spec that needs it.

## Server-side fixtures: design rules

Beyond "put setup in `@whitelist_for_tests` helpers" — a few things worth getting right the first
time.

**`cy.call` form-encodes its args**, so an array or object arrives on the python side as a JSON
string. Every helper taking structured input needs:

```python
names = frappe.parse_json(names) if isinstance(names, str) else names
```

**Take explicit identifiers, never a pattern.** A `delete_documents(doctype, filters)` that quietly
appends `name like "_Test%"` is a whitelisted, HTTP-reachable, wildcard delete. `whitelist_for_tests`
passes on *any* runner with the `CI` env var set — that is a much wider door than it looks. Take a
list of names the spec already knows:

```python
@whitelist_for_tests(methods=["POST"])
def delete_documents(doctype, names):
    names = frappe.parse_json(names) if isinstance(names, str) else names

    for name in names:
        doc = frappe.get_doc(doctype, name)
        if doc.docstatus == 1:
            doc.cancel()

        doc.delete(ignore_permissions=True)
```

**Prefer not deleting at all.** With `testIsolation: false` and `retries.runMode > 0`, deleting a
document that a retried attempt or a later `it()` asserts on breaks that test, and submitted
documents drag in a whole class of Cancel → Delete → linked GL/SLE failures. A leftover `_Test` draft
is cheap; a flaky teardown is not.

**Mark globally-shared state loudly.** A helper that writes a Single (`GST Settings`, `Accounts
Settings`, `System Settings`) mutates state every other spec sees. Two rules, both worth stating in
the docstring: the spec that touches it owns its own spec file and restores the previous value in
`after()`, and the caller must `cy.reload()` afterwards — Singles reach the client through
`boot_session` bootinfo, so a client script keeps reading the stale value until the page reboots.
`frappe.clear_cache()` on the server does not help the already-loaded page.
