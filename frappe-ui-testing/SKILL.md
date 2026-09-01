---
name: frappe-ui-testing
description: >-
  Set up and write browser/UI/end-to-end tests for a custom Frappe or ERPNext app using Cypress via
  `bench run-ui-tests`, and wire them into GitHub Actions for a repo that already runs Python unit
  tests. Use this skill whenever a task involves: adding UI tests, E2E tests, browser tests, Cypress
  or `cypress.config.js` to a Frappe app; `bench --site X run-ui-tests <app>`; writing a `.cy.js`
  spec against the Frappe Desk; frappe's Cypress custom commands (`cy.login`, `cy.new_form`,
  `cy.fill_field`, `cy.fill_table_field`, `cy.call`, `cy.insert_doc`, `cy.click_action_button`);
  `@whitelist_for_tests` server-side fixtures for UI tests; a `ui-tests.yml` GitHub Actions workflow
  for a Frappe app; or sharding/parallelising Cypress across a CI matrix with `cypress-split`. Also
  covers how to structure a growing suite — the `cypress/` folder layout, form/transaction controller
  classes, reusing the app's `test_records.json` from a spec, and designing `ui_test_helpers.py`
  fixtures. Reach for it before creating any Cypress scaffolding in a Frappe app —
  `bench run-ui-tests` resolves the binary and the config from two different directories, and getting
  that wrong is the single most common way this setup fails.
---

# UI Testing for a Custom Frappe App

Frappe runs Desk UI tests on **Cypress**, driven by `bench --site <site> run-ui-tests <app>`. The
[official doc](https://docs.frappe.io/framework/user/en/ui-testing) describes this from the point of
view of someone working inside `frappe/frappe`, where the config, support files, and `node_modules`
already exist. A **custom app** has none of them, and the command's path handling is the part that
trips people up.

## The one thing to understand first

`bench run-ui-tests <app>` ([`frappe/commands/testing.py`](https://github.com/frappe/frappe/blob/develop/frappe/commands/testing.py), `run_ui_tests`) does this:

```python
app_base_path = frappe.get_app_source_path(app)
os.chdir(app_base_path)                              # cwd = apps/<app>
node_bin = subprocess.run("(cd ../frappe && yarn bin)", ...)   # binary from apps/frappe
cypress_path = f"{node_bin}/cypress"
frappe.commands.popen(f"CYPRESS_baseUrl=... {cypress_path} run ...", cwd=app_base_path)
```

So **two roots are in play at once**:

| Concern | Resolves from |
| --- | --- |
| `cypress.config.js` location, `specPattern`, `supportFile` | `apps/<your_app>/` |
| Cypress binary and its plugins (`cypress-split`, `@testing-library/cypress`, `@cypress/code-coverage`, `@4tw/cypress-drag-drop`, `cypress-real-events`) | `apps/frappe/node_modules/` |

Node/webpack resolve `node_modules` by walking **up from the importing file**, and
`apps/<your_app>/…` never walks into `apps/frappe/node_modules`. Every bare `require()`/`import` of
a Cypress plugin from your app's own files will therefore fail unless you either reach frappe's copy
by relative path or add the package to your own app.

Read `references/bench-command.md` for the full behaviour (env vars it injects, flags, the
auto-install of plugins into `apps/frappe`).

## Setup — six steps

Copy the files in `assets/` into the app root, then adjust.

```
cypress.config.js                        -> apps/<app>/cypress.config.js
cypress/support/e2e.js                   -> supportFile; imports frappe's
cypress/support/commands.js              -> app-specific commands
cypress/support/session.js               -> login + Desk bootstrap
cypress/support/test_records.js          -> accessors over <app>/tests/test_records.json
cypress/support/controllers/base.js      -> wait_for_settle, assert_no_modal
cypress/support/controllers/form.js      -> form + child-table driving
cypress/e2e/example.cy.js                -> a spec written with bare cy.* commands
cypress/e2e/controller_example.cy.js     -> the same idea via the controller layer
ui_test_helpers.py                       -> apps/<app>/<app>/tests/ui_test_helpers.py
```

The support/controller files are optional for a single throwaway spec and close to mandatory by the
fifth — `references/spec-architecture.md` explains the reasoning behind each.

### 1. `cypress.config.js` at the **app root**

Not inside `cypress/`. Cypress looks for it in cwd, which bench has set to `apps/<your_app>`.

Note that `assets/cypress.config.js` exports a **plain object** rather than calling
`defineConfig(...)`. `defineConfig` is only a TypeScript typing helper, and `require("cypress")`
from the app root does not resolve — the symptom is:

```
Your configFile is invalid: apps/<app>/cypress.config.js
It threw an error when required   →   MODULE_NOT_FOUND: 'cypress'
```

Two fixes. Dropping `defineConfig` costs nothing. Adding `cypress` to the app's own
`devDependencies` (step 4) also costs very little in practice — `yarn add -D cypress@13.17.0`
finishes in seconds because the binary is already in the shared cache
(`~/Library/Caches/Cypress`, `~/.cache/Cypress`) from bench's own install, and only the JS package
is written into `apps/<app>/node_modules`. Take that route if you want editor autocomplete on the
config, or if `setupNodeEvents` needs to `require` a plugin anyway.

`baseUrl` and `adminPassword` in the file are placeholders — bench overrides both with
`CYPRESS_baseUrl` (from the site's URL) and `CYPRESS_adminPassword` (from the site config) at run
time. Keep them anyway so `npx cypress open` works standalone.

### 2. `cypress/support/e2e.js` — borrow frappe's support file

```js
import "../../../frappe/cypress/support/e2e"; // eslint-disable-line
```

That relative hop (`apps/<your_app>/cypress/support/` → `../../../` → `apps/` → `frappe/…`) is the
whole trick. Because the import lands *inside* `apps/frappe`, frappe's own
`import "@testing-library/cypress/add-commands"` resolves correctly from there. It gives you ~45
custom commands for free — see `references/cypress-commands.md`.

Import frappe's **`support/e2e`**, not `support/commands`. Its `e2e.js` is three lines, and all three
are things you would otherwise have to reproduce: `import "./commands"`,
`import "@cypress/code-coverage/support"` (which is the bare specifier your own file cannot resolve —
see Gotchas), and a blanket `Cypress.on("uncaught:exception", () => false)`.

That last one is worth understanding rather than copying blind. The Desk throws a steady trickle of
exceptions that have nothing to do with the test — `ResizeObserver loop completed`, aborted
in-flight XHRs on navigation, third-party widget noise — and Cypress fails a test on **any** uncaught
exception in the app under test. Frappe swallows all of them. The cost is that a genuine JS
regression in your own client script becomes invisible: the form quietly does nothing and you debug
the assertion instead of the stack trace.

Taking frappe's file wholesale is still the right default — it is what frappe's and erpnext's own
suites run against, so your suite fails the same way theirs does. Narrow it only when you are
actually chasing a swallowed error, by re-registering a scoped handler *after* the import.

Add app-specific setup in the same file, below the import. Put app-specific commands in
`cypress/support/commands.js` and import that too.

### 3. `cypress/e2e/*.cy.js` for specs

This is the Cypress ≥10 default `specPattern` (`cypress/e2e/**/*.cy.{js,jsx,ts,tsx}`), so no
override is needed.

The published doc says `cypress/integration/*.js` — that is the **legacy Cypress ≤9 layout**.
Frappe's own repo still uses it, but only because its config carries an explicit
`specPattern: ["./cypress/integration/*.js", "**/ui_test_*.js"]`. Don't copy the legacy layout into
a new app. (ERPNext has no `cypress/` directory at all, so there is no in-house modern example to
copy — `references/spec-architecture.md` fills that gap.)

Keep specs **flat** in `cypress/e2e/`, and everything else under `cypress/support/`. A
`cypress/pages/transactions/` sitting next to `cypress/e2e/transactions/` is indistinguishable in an
editor tab bar. Once you have more than one or two specs, read
`references/spec-architecture.md` before inventing a layout.

### 4. App-local `devDependencies` — only if your config imports them

Needed only when `cypress.config.js` itself does a bare `require`, e.g. for `cypress-split`
sharding or `defineConfig`. Pin to the majors bench installs so the config and the binary agree:

```json
{
  "devDependencies": {
    "cypress": "^13",
    "cypress-split": "^1",
    "@testing-library/cypress": "^10"
  }
}
```

The binary still comes from `apps/frappe` — this local copy exists purely for module resolution, so
a major-version drift between the two is a real (if quiet) failure mode. `assets/cypress.config.js`
avoids the dependency entirely by using the `SPLIT`/`SPLIT_INDEX` env vars directly.

### 5. Server-side fixtures via `@whitelist_for_tests`

Create `<app>/tests/ui_test_helpers.py`:

```python
import frappe
from frappe.tests.utils import whitelist_for_tests


@whitelist_for_tests()
def create_test_customer():
    if not frappe.db.exists("Customer", "UI Test Customer"):
        frappe.get_doc({"doctype": "Customer", "customer_name": "UI Test Customer"}).insert()
    return "UI Test Customer"
```

Call it from a spec with `cy.call("<app>.tests.ui_test_helpers.create_test_customer")`.

`whitelist_for_tests` refuses unless `frappe.in_test`, or a **dev server** with `allow_tests` set in
site config, or the `CI` env var is present. Locally that means both of:

```sh
bench --site <site> set-config allow_tests true
DEV_SERVER=true bench --site <site> serve --port 8001
```

`frappe._dev_server` is set from the `DEV_SERVER` env var. `bench start` exports it via the
Procfile; a bare `bench serve` does **not**, and every `cy.call` to a test helper then 403s with no
useful message. Export it explicitly whenever you run `serve` by hand.

Note what that guard implies for helper design: these endpoints are reachable over plain HTTP on any
machine with `CI` in the environment. Take explicit document names, never a `like` pattern — and see
"Server-side fixtures: design rules" in `references/spec-architecture.md`, which also covers
`cy.call`'s form-encoding of arguments (structured args arrive as JSON strings and need
`frappe.parse_json`) and why deleting documents in teardown is usually a mistake.

### 6. Run it

```sh
bench --site <site> run-ui-tests <app>              # interactive Cypress runner
bench --site <site> run-ui-tests <app> --headless   # what CI does
bench --site <site> run-ui-tests <app> --headless --spec cypress/e2e/my_spec.cy.js
```

A server must be running, and the site must be reachable over HTTP — see Gotchas.

If a run behaves as though your files are the previous version — a spec you moved still executing at
its old path, an edit to a support file not taking effect — clear the **project bundle cache**.
Cypress keys compiled spec and support bundles by source path and does not always invalidate them
when files move:

```sh
rm -rf ~/Library/Application\ Support/Cypress/cy/production/projects/<app>-*/bundles   # macOS
rm -rf ~/.config/Cypress/cy/production/projects/<app>-*/bundles                        # Linux
```

Alongside it, `bench --site <site> clear-cache` for server-side bootinfo, and
`bench build --app <app>` if you changed the app's own Desk JS (not needed for changes under
`cypress/`).

## Gotchas

**The site must actually be reachable at its `host_name` over HTTP.** `cy.visit` fails before any
assertion runs otherwise. If the bench has `serve_default_site` set globally, port 8000 is pinned to
one site and every other site 404s or resolves to the wrong one. Check with
`curl -I http://<site>:8000` first; fix with `bench set-config -g serve_default_site false`, or run
against whichever site `:8000` actually serves.

**Assets must be built.** A bench created with `bench init --skip-assets` has no `dist/`, so the
Desk boots blank and every spec times out. Run `bench build` (CI: `CI=Yes bench build --production`).

**`--with-coverage` produces empty reports, and you cannot make it silent.** Two separate problems.
First, `import "@cypress/code-coverage/support"` won't resolve from your app's `e2e.js` — importing
frappe's `support/e2e` (step 2) gets it for free; otherwise use the relative path
`../../../frappe/node_modules/@cypress/code-coverage/support`. Second, and more fundamentally,
**nothing instruments the JS**. `--with-coverage` only sets `CYPRESS_coverage=true`; there is no
`babel-plugin-istanbul` anywhere in frappe's esbuild pipeline, so `window.__coverage__` never exists.
The run still writes `coverage/coverage-final.json` = `{}`, an empty `.nyc_output/out.json`, a 0-byte
`lcov.info`, and a table of "Unknown" percentages — `coverageReport()` calls `saveCoverage()` and the
nyc reporters *before* it checks whether the map is empty, so no flag suppresses the files.

Options, in order: don't pass `--with-coverage` locally (the support hook takes its
`Skipping code coverage hooks` branch when `coverage` is false); gate the task registration in
`setupNodeEvents` on `process.env.CI` so CI keeps it and laptops don't; or just add `coverage/` and
`.nyc_output/` to `.gitignore` and ignore the noise. Real coverage numbers need an instrumentation
step you add yourself.

**`cy.login()` defaults** to `Cypress.config("testUser")` and `Cypress.env("adminPassword")`. Set
`testUser: "frappe@example.com"` in the config and create that user in CI with
`bench --site <site> execute frappe.tests.ui_test_helpers.create_test_user`.

**`testIsolation`.** Frappe sets `testIsolation: false` so state carries across `it()` blocks within
a spec. `assets/cypress.config.js` keeps that for consistency with frappe's own suite; flip it to
`true` if you'd rather have each test start clean at the cost of re-login time. The non-obvious cost
of `false`: a modal opened in one `it()` is still there in the next, over a backdrop, swallowing
every click. See `references/spec-architecture.md`.

**The support file and each spec are bundled separately.** A module imported by both gets two
instances, so module-level state written during a `before()` in the support file is *not* visible to
the spec. Anything shared has to be a static import (a JSON file, a pure function) or go through
`Cypress.env()` / an alias.

**`cy.login()` re-authenticates once per spec file.** It wraps `cy.session([email, password], …)`, so
repeat calls within a file restore from cache — but frappe does not pass `cacheAcrossSpecs: true`, so
every spec pays one real login. That is a reason to keep specs coarse enough to be worth the boot,
and it interacts with `cypress-split`: sharding multiplies logins.

**An app that calls an external API can hit production from a test run.** A "sandbox mode" setting
usually only rewrites the URL path and still egresses, and any page whose client script fetches the
vendor directly will do so the moment a `cy.visit` lands on it. Block it at the network layer in
`support/e2e.js`:

```js
beforeEach(() => {
    cy.intercept("https://api.vendor.example/**", { forceNetworkError: true });
});
```

**Videos/screenshots** land in `apps/<your_app>/cypress/videos` and `.../screenshots`. Add both to
`.gitignore`, along with `coverage/` and `.nyc_output/` if you ever run `--with-coverage`.

## CI

For a public repo that already runs Python unit tests, add a **separate** `ui-tests.yml` rather than
a job inside the existing server-tests workflow — different services, different timeout, different
failure modes, and you want it independently required in branch protection.

`assets/ui-tests.yml` is a complete, ready-to-use workflow. `references/github-actions.md` explains
each part, the changes needed in an existing `.github/helper/install.sh`, matrix sharding without a
Cypress Cloud account, branch protection, and optional JS coverage.

## Reference files

- `references/bench-command.md` — exactly what `bench run-ui-tests` does, and module resolution.
- `references/cypress-commands.md` — frappe's custom command catalogue with signatures, Testing
  Library queries, and `whitelist_for_tests`.
- `references/spec-architecture.md` — folder layout, controller classes, reading `cur_frm.doc`,
  reusing the app's `test_records.json`, session bootstrap, and fixture design rules. Read this
  before writing the second spec.
- `references/github-actions.md` — CI setup end to end.

## Prior art worth reading

- [`frappe/erpnext_ui_tests`](https://github.com/frappe/erpnext_ui_tests) — the canonical Desk-app
  example; source of the `../../../frappe/cypress/support/commands` pattern.
- [`frappe/lms`](https://github.com/frappe/lms/blob/develop/.github/workflows/ui-tests.yml) —
  current-generation workflow with `SPLIT`/`SPLIT_INDEX` sharding.
- [`frappe/frappe`](https://github.com/frappe/frappe/blob/develop/.github/workflows/ui-tests.yml) —
  the framework's own suite, incl. the `success:` aggregate job.
- [`frappe/crm`](https://github.com/frappe/crm) uses **Playwright**, not Cypress — it is a pure
  Frappe-UI SPA with no Desk. If your app is an SPA too, that is the better model, and none of the
  above applies.