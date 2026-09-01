# `bench run-ui-tests` — what it actually does

Source: `frappe/commands/testing.py`, `run_ui_tests` (frappe develop).

```
bench --site <site> run-ui-tests <app> [CYPRESSARGS...]
                                       [--headless] [--parallel] [--with-coverage]
                                       [--browser chrome] [--spec PATH] [--ci-build-id ID]
```

## Sequence

1. `frappe.init(site)`.
2. `app_base_path = frappe.get_app_source_path(app)` → `apps/<app>`.
3. Reads `site_url` and `admin_password` from the site's config.
4. **`os.chdir(app_base_path)`** — Cypress's cwd is your app, so `cypress.config.js` must be at the
   app root.
5. Finds the binary via `(cd ../frappe && yarn bin)` → `apps/frappe/node_modules/.bin/cypress`.
6. If the binary or any plugin is missing from `apps/frappe/node_modules`, installs them there:

   ```
   cypress@^13  @4tw/cypress-drag-drop@^2  cypress-real-events
   @testing-library/cypress@^10  @testing-library/dom@8.17.1
   @cypress/code-coverage@^3  cypress-split@^1.0.0
   ```

   It saves `apps/frappe/package.json`, runs `yarn add --no-lockfile`, then **restores** the file so
   frappe's own manifest stays clean. First run is therefore slow and network-dependent.
7. Runs the binary with `cwd=app_base_path`.

## Environment it injects

| Variable | Value | Effect |
| --- | --- | --- |
| `CYPRESS_baseUrl` | `frappe.utils.get_site_url(site)` | **Overrides** `baseUrl` in your config |
| `CYPRESS_adminPassword` | site config `admin_password` (omitted if unset) | Read by `cy.login()` via `Cypress.env("adminPassword")` |
| `CYPRESS_coverage` | `true`/`false` from `--with-coverage` | Read by `@cypress/code-coverage` |
| `CYPRESS_CLOUD_PARALLEL` | `1` with `--parallel`, else `0` | Frappe's config uses this to disable `cypress-split` when Cypress Cloud is orchestrating |

Because `baseUrl` is overridden, the value in your config file only matters for a standalone
`npx cypress open`.

## Flags

- `--headless` → `cypress run --browser <browser>`; without it, `cypress open`.
- `--browser` → defaults to `chrome`; in CI pass an explicit path (e.g. from
  `browser-actions/setup-chrome`).
- `--spec PATH` → only applied together with `--headless`.
- `--parallel` → adds `--parallel` and sets `CYPRESS_CLOUD_PARALLEL=1`. Requires Cypress Cloud.
- `--ci-build-id ID` → adds `--ci-build-id`; needed to group machines into one Cloud run.
- `--with-coverage` → sets `CYPRESS_coverage=true` only. It does **not** instrument your source —
  you must run `nyc instrument` yourself beforehand. Since nothing in frappe's esbuild pipeline
  applies `babel-plugin-istanbul`, the out-of-the-box result is an empty report; see "Coverage" below.
- Any trailing unprocessed args are appended verbatim to the Cypress command line. Separate them
  with `--` when they'd otherwise be eaten by bench, e.g.
  `bench --site s run-ui-tests app --headless -- --group my-group`.
- `--record` is appended **automatically** whenever the `CYPRESS_RECORD_KEY` env var is set.

Exit code: a Cypress failure raises `click.exceptions.Exit(1)`, so CI fails correctly.

## Module resolution — the trap

Node and Cypress's bundler resolve `node_modules` by walking up from the **importing file's**
directory. Nothing under `apps/<your_app>/` ever walks into `apps/frappe/node_modules`.

| File | Bare `require("cypress-split")` | Works? |
| --- | --- | --- |
| `apps/frappe/cypress.config.js` | `apps/frappe/node_modules` | yes |
| `apps/frappe/cypress/support/commands.js` | `apps/frappe/node_modules` | yes |
| `apps/<your_app>/cypress.config.js` | `apps/<your_app>/node_modules`, `apps/node_modules`, … | **no** |
| `apps/<your_app>/cypress/support/e2e.js` | same | **no** |

The failure looks like this, and the stack trace names the bare specifier rather than the real
problem:

```
Your configFile is invalid: apps/<app>/cypress.config.js
It threw an error when required, check the stack trace below:
Error: Cannot find module 'cypress'
```

Three ways out, in order of preference:

1. **Reach frappe by relative path.** `import "../../../frappe/cypress/support/e2e"` — the import
   lands inside `apps/frappe`, so *its* transitive bare imports resolve fine. This is what
   `erpnext_ui_tests` does and it costs nothing. Works from `cypress.config.js` too, for plugin
   `require`s: `require("../frappe/node_modules/@cypress/code-coverage/task")`.
2. **Avoid the dependency.** Don't call `defineConfig` (it's a typing helper — a plain object works);
   read `SPLIT`/`SPLIT_INDEX` yourself instead of importing `cypress-split`.
3. **Add the package to your app's own `package.json`.** What `frappe/lms` does. Correct, but now
   two copies of Cypress exist and can drift in version — pin the same major bench installs.

Option 3 is cheaper than it sounds for `cypress` itself. `yarn add -D cypress@13.17.0` in the app
takes seconds: the ~250 MB binary is already in the shared download cache
(`~/Library/Caches/Cypress` on macOS, `~/.cache/Cypress` on Linux) from bench's install into
`apps/frappe`, so only the JS package is written. Do this if you want `defineConfig` for editor
autocomplete.

Ordinary app source under test is unaffected — that's served by the running bench, not bundled by
Cypress.

## Coverage

`@cypress/code-coverage` has two halves, and both must be present when `CYPRESS_coverage=true`:
the support hook (`@cypress/code-coverage/support`, which frappe's own `cypress/support/e2e.js`
imports) and the node task (`@cypress/code-coverage/task`, registered in `setupNodeEvents`). If the
support hook loads and the task is missing, the run errors.

But the plugin is inert regardless, because **nothing instruments the JS**. There is no
`babel-plugin-istanbul` or equivalent anywhere under `apps/frappe/esbuild/`, so `window.__coverage__`
never exists. Symptoms of a `--with-coverage` run:

- `coverage/coverage-final.json` → `{}`
- `.nyc_output/out.json` → `{}`
- `coverage/lcov.info` → 0 bytes
- the summary table prints `Unknown` for every percentage

And it cannot be made quiet: `coverageReport()` in the plugin's `task.js` calls `saveCoverage(map)`
and runs the nyc reporters *before* it tests whether the map is empty. There is no flag that writes
nothing.

So pick one:

- **Don't pass `--with-coverage` locally.** With `coverage` false the support hook takes its
  `Skipping code coverage hooks` branch and writes nothing.
- **Gate the task on `process.env.CI`** in `setupNodeEvents`, so CI keeps the wiring and laptops
  don't get the artifacts.
- **Redirect the output** with an `nyc` block in `package.json` (frappe uses
  `"report-dir": ".cypress-coverage"`).

Add `coverage/` and `.nyc_output/` to `.gitignore` either way. Getting real numbers requires adding
an instrumentation step yourself; nothing upstream does it for you.

## Caches that go stale

Cypress keys compiled spec and support bundles by source path, per project, and does not reliably
invalidate them when a file is moved or renamed. The symptom is a run that executes a spec at a path
that no longer exists, or ignores an edit to a support file.

```sh
# macOS
rm -rf ~/Library/Application\ Support/Cypress/cy/production/projects/<app>-*/bundles
# Linux
rm -rf ~/.config/Cypress/cy/production/projects/<app>-*/bundles
```

The directory is `<app>-<hash-of-project-path>`, so the glob is the easy way in. Deleting `bundles/`
only forces a rebundle — it does not touch the Cypress binary or the browser profile.

The other two worth knowing:

- `bench --site <site> clear-cache` — server-side bootinfo, user defaults, Single doctype values.
  Needed after changing a Single that a client script reads through `frappe.boot`.
- `bench build --app <app>` — only if you changed the app's own Desk JS. Files under `cypress/` are
  bundled by Cypress, not by bench, so they never need a build.

## Running the server by hand

CI aside, you need an HTTP server for the site. `bench start` works, but a single-site run is often
easier on its own port:

```sh
DEV_SERVER=true bench --site <site> serve --port 8001
```

`DEV_SERVER=true` is not optional if any spec calls a `@whitelist_for_tests` endpoint —
`frappe._dev_server` reads that env var, `bench start` exports it via the Procfile, and a bare
`bench serve` does not. Without it every `cy.call` to a test helper 403s.

Point the config's `baseUrl` at the same host and port (`http://<site>:8001`) for standalone
`npx cypress open`; `bench run-ui-tests` overrides it with the site URL anyway.

## `whitelist_for_tests`

`frappe/tests/utils/__init__.py`:

```python
def whitelist_for_tests(**whitelist_kwargs):
    """Only allows access when running in test mode or a dev server with testing enabled."""
```

The guard is:

```python
frappe.in_test or (frappe._dev_server and frappe.conf.allow_tests) or os.environ.get("CI")
```

So: passes automatically in CI (GitHub Actions sets `CI`), needs
`bench --site <site> set-config allow_tests true` **and** `DEV_SERVER=true` locally, and throws on a
production server. It accepts everything `frappe.whitelist()` does, e.g.
`@whitelist_for_tests(allow_guest=True)` or `@whitelist_for_tests(methods=["POST"])`.

Two things follow from that guard being `os.environ.get("CI")` on its own:

- **Any** machine with `CI` in the environment exposes these endpoints over plain HTTP, with no
  `allow_tests` opt-in. Write them as though they are reachable, because they are.
- Consequently a helper must never take a pattern it expands server-side. `delete_documents(doctype,
  filters)` that appends `name like "_Test%"` is a whitelisted wildcard delete; take an explicit list
  of names instead. See `spec-architecture.md`.

`cy.call` sends its `args` form-encoded, so a JS array or object arrives as a **string**. Any helper
taking structured input needs `frappe.parse_json(value) if isinstance(value, str) else value`.
