# Frappe Cypress command catalogue

Everything here comes from `apps/frappe/cypress/support/commands.js` and is available to a custom
app once its `cypress/support/e2e.js` does:

```js
import "../../../frappe/cypress/support/e2e";
```

(Importing frappe's `support/e2e` rather than `support/commands` also brings in its
`@cypress/code-coverage/support` import and its blanket `uncaught:exception` handler — see SKILL.md
step 2.)

Signatures are from frappe develop; check the file if something behaves unexpectedly, since the
Desk markup these selectors depend on does shift between versions.

## Session

```js
cy.login(email, password)   // both optional; default to config `testUser` + env `adminPassword`
cy.switch_to_user(user)     // logs out, logs in as `user`
cy.add_role(user, role)
cy.remove_role(user, role)
```

`cy.login()` wraps `cy.session([email, password], setup)`, so repeat calls within a spec restore from
cache instead of re-authenticating. It preserves `session_last_route` across the session reset.

Frappe does **not** pass `cacheAcrossSpecs: true`, so the cache is per spec **file** — every spec pays
one real login. Nothing in your app can change that short of patching frappe's command; factor it
into how finely you split specs, and remember `cypress-split` multiplies it by the shard count.

## Server calls and data setup

```js
cy.call(method, args)                     // POST /api/method/<method> with CSRF; asserts 200
cy.get_list(doctype, fields = [], filters = [])
cy.get_doc(doctype, name)
cy.insert_doc(doctype, args, ignore_duplicate)
cy.update_doc(doctype, docname, args)
cy.remove_doc(doctype, name, ignore_missing)
cy.set_value(doctype, name, {fieldname: value})   // frappe.client.set_value
cy.create_records(doc)                    // doc or [doc]; creates only if no match exists
```

`cy.create_records` and `cy.add_role`/`cy.remove_role` go through
`frappe.tests.ui_test_helpers.*`, which are `@whitelist_for_tests` endpoints — they only work when
that guard passes (see `bench-command.md`).

Prefer these API commands over driving the UI for **setup**. Reserve UI interaction for the
behaviour actually under test; it is an order of magnitude slower and far more brittle.

## Navigation

```js
cy.new_form(doctype)        // visits /desk/<slug>/new and waits for data-route + ajax idle
cy.go_to_list(doctype)
cy.awesomebar(text)         // types into #navbar-search, picks the first suggestion
cy.select_form_tab(label)
cy.click_form_section(section_name)
cy.desk_ready()             // frappe.app booted, ajax_count === 0, main section non-empty
cy.clear_cache()
```

`cy.desk_ready()` is the right thing to wait on after a bare `cy.visit()` — it asserts the boot
completed and all in-flight requests settled, which arbitrary `cy.wait(ms)` does not.

## Fields

```js
cy.get_field(fieldname, fieldtype = "Data")
cy.fill_field(fieldname, value, fieldtype = "Data")
cy.get_table_field(tablefieldname, row_idx, fieldname, fieldtype = "Data")
cy.fill_table_field(tablefieldname, row_idx, fieldname, value, fieldtype = "Data")
```

**Always pass the real `fieldtype`.** `fill_field` branches on it and the branches are not
interchangeable:

- `Link` / `Dynamic Link` — clears, focuses, waits for the `role="listbox"` dropdown, types with a
  100 ms delay, asserts the first option contains the value, presses Enter, blurs, then asserts the
  input value. Passing `"Data"` for a Link silently leaves the field unset because no option is
  selected.
- `Select` — uses `.select()`.
- `Date` / `Time` / `Datetime` — clicks first and waits for `.datepicker.active` to exist.
- `Text Editor` — targets `.ql-editor[contenteditable=true]`.
- `Code` — targets `.ace_text-input`. `Markdown Editor` — `.ace-editor-target`.

`get_field` selects `[data-fieldname="…"]:not(.search) input:visible` (or `select`), `.first()`.

## Buttons and actions

```js
cy.save()                              // clicks Save, waits on the savedocs intercept
cy.click_doc_primary_button(name)
cy.click_listview_primary_button(name)
cy.click_action_button(name)           // Actions menu → menuitem (espresso .es-menu)
cy.click_menu_button(name)             // ⋯ menu → menuitem
cy.click_custom_action_button(name)    // buttons added by client scripts
cy.click_modal_primary_button(name)
cy.click_sidebar_button(name)
cy.click_timeline_action_btn(name)
```

`cy.save()` intercepts `/api/method/frappe.desk.form.save.savedocs` and waits on it, so it's a real
synchronisation point rather than a blind click.

Note that `click_action_button` and `click_menu_button` look inside `.es-menu` because the page
header dropdowns body-portal in current frappe. On older versions they searched within the button
group — a symptom of that mismatch is "element not found" on a menu that is visibly open.

## Lists

```js
cy.open_list_filter()
cy.click_filter_button()
cy.clear_filters()
cy.click_listview_row_item(row_no)
cy.click_listview_row_item_with_text(text)
cy.select_listview_row_checkbox(row_no)
```

## Dialogs

```js
cy.dialog(opts)          // constructs and shows a real frappe.ui.Dialog
cy.get_open_dialog()     // .modal:visible, last
cy.hide_dialog()
cy.clear_dialogs()       // rips out .modal + .modal-backdrop from the DOM
cy.clear_datepickers()
```

`clear_dialogs`/`clear_datepickers` are teardown helpers — useful in `afterEach` when
`testIsolation: false` leaves modals stacked between tests.

## Assertions

```js
cy.compare_document(expected_document)
```

Reads `cur_frm.doc` and recursively asserts every property in `expected_document`, descending into
child tables by index. Only checks the keys you supply.

## Testing Library queries

`@testing-library/cypress` is loaded by frappe's `commands.js`, so these are available:

```js
cy.findByRole("button", {name: "Actions"})
cy.findByLabelText("Customer")
cy.findByPlaceholderText(...)
cy.findByText(...)
cy.findByDisplayValue(...)
cy.findByTitle(...)
cy.findByAltText(...)
cy.findByTestId(...)
```

Prefer `findByRole` where the Desk exposes a real role — it survives CSS refactors that break class
selectors. Frappe's own `click_action_button` uses it. Docs:
[queries](https://testing-library.com/docs/queries/about),
[byrole](https://testing-library.com/docs/queries/byrole).

Also loaded: `@4tw/cypress-drag-drop` (`.drag()`) and `cypress-real-events`
(`.realClick()`, `.realHover()`, `.realType()` — genuine browser events, for things synthetic
events don't trigger).

## Server-side fixtures

`<app>/tests/ui_test_helpers.py`:

```python
import frappe
from frappe.tests.utils import whitelist_for_tests


@whitelist_for_tests()
def setup_ui_test_data():
    frappe.db.truncate("Some Doctype")
    ...
    frappe.db.commit()
```

From a spec:

```js
before(() => {
  cy.login();
  cy.call("myapp.tests.ui_test_helpers.setup_ui_test_data");
});
```

Frappe's own `frappe/tests/ui_test_helpers.py` is worth skimming for patterns —
`create_if_not_exists`, `create_doctype`, `create_child_doctype`, `setup_workflow`,
`create_test_user`.

## Writing specs — practical notes

- One concern per spec file. `cypress-split` shards at **file** granularity, so a single giant spec
  pins one CI shard and wastes the rest.
- `testIsolation: false` (frappe's default) means state carries between `it()` blocks in a file.
  Order matters; write them as a deliberate sequence or set `testIsolation: true`.
- Never `cy.wait(ms)` to paper over async. Use `cy.desk_ready()`, `cy.save()`, or an explicit
  `cy.intercept(...).as(...)` + `cy.wait("@alias")`.
- `defaultCommandTimeout` is 20 s in frappe's config for a reason — the Desk boot is slow. Don't
  lower it.
- Assert against `cur_frm.doc`, not the DOM, for anything the server computes. `cy.compare_document`
  and `cy.window().its("cur_frm.doc")` both read it.
- For layout, controller classes, and reuse of the app's `test_records.json`, see
  `spec-architecture.md`.
