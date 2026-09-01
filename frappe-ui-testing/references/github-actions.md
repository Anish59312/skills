# Enabling UI tests in a public GitHub repo that already has Python unit tests

Starting point assumed: a Frappe app repo with `.github/workflows/server-tests.yml` (bench + MariaDB
service + `bench run-parallel-tests`) and `.github/helper/install.sh`. That's the standard shape for
`erpnext`, `hrms`, `india_compliance`, and most community apps.

Copy `assets/ui-tests.yml` to `.github/workflows/ui-tests.yml` and work through the list below.

## 1. A separate workflow, not another job

Put UI tests in their own file. Different services, a much longer timeout, artifacts on failure, and
a much higher flake rate than unit tests. Bundling them into `server-tests.yml` means a flaky
browser test blocks a green Python run, and you can't require one without the other in branch
protection.

## 2. Gate it on frontend changes

If the repo already uses `dorny/paths-filter` for server tests, note that the two filters are
**inverses**. Server tests typically exclude JS:

```yaml
backend:
  - '**'
  - '!**.css'
  - '!**.js'
  - '!**.md'
```

The UI job wants the opposite — fire *on* JS, HTML, CSS, doctype JSON (which carries field layout),
and on the Cypress files themselves:

```yaml
frontend:
  - '**.js'
  - '**.html'
  - '**.css'
  - '**.scss'
  - '**/doctype/**/*.json'
  - 'cypress/**'
  - 'cypress.config.js'
  - '.github/workflows/ui-tests.yml'
```

Keep push and scheduled runs ungated: `if: github.event_name != 'pull_request' || needs.changes.outputs.frontend == 'true'`.

A nightly cron is worth having. UI tests are the thing that breaks when `frappe`/`erpnext` develop
moves under you, and you want to find that out at 5:30 am rather than on a release PR.

## 3. `install.sh` needs a `TYPE=ui` branch

This is the step most likely to be wrong. A server-tests `install.sh` almost always does
`bench init --skip-assets`, which is correct for Python tests and fatal for UI tests: with no
`dist/` the Desk boots blank and every spec times out at `cy.visit`.

Add to the existing script:

```bash
# after `bench get-app <your_app>` / `bench setup requirements --dev`
if [ "$TYPE" == "ui" ]; then
    bench setup requirements --node
    CI=Yes bench build --production
fi
```

`bench build` with no `--app` builds frappe's assets too, which you need — the Desk itself is
frappe's bundle.

Most such scripts also already do `bench start &` followed immediately by other work, racing the
server. For UI tests, wait for it properly:

```bash
bench start &> ~/frappe-bench/bench_start.log &

if [ "$TYPE" == "ui" ]; then
    echo "Waiting for the web server..."
    timeout 120 bash -c "until curl -sf http://${SITE_NAME}:8000 > /dev/null; do sleep 2; done"
fi
```

Also confirm the Procfile trimming doesn't remove `web:`. Server-test scripts sometimes comment out
`socketio:` and `redis_socketio:` — the Desk tolerates missing socketio (it just logs reconnect
errors), but if your specs assert on realtime updates or background-job completion toasts, leave
socketio in.

If the repo's `site_config.json` helper sets `"host_name"`, make sure it matches the hostname you
add to `/etc/hosts` and the site name you pass to bench. `CYPRESS_baseUrl` is derived from the
site URL, so a mismatch here sends Cypress to the wrong origin.

## 4. Site setup

```yaml
- name: Site Setup
  run: |
    bench --site $SITE_NAME execute frappe.utils.install.complete_setup_wizard
    bench --site $SITE_NAME execute frappe.tests.ui_test_helpers.create_test_user
    bench --site $SITE_NAME set-password frappe@example.com admin
    bench --site $SITE_NAME execute $APP_NAME.tests.ui_setup.execute
```

- `complete_setup_wizard` — without it the Desk redirects to the setup wizard and nothing else is
  reachable.
- `create_test_user` — creates `frappe@example.com`, which `cy.login()` uses by default via the
  config's `testUser`.
- The last line is yours. Anything domain-specific that every spec needs (a Company, tax templates,
  items, app settings) belongs in one idempotent Python function, not in `before()` hooks repeated
  across specs. `erpnext_ui_tests` does exactly this with
  `erpnext_ui_tests.test_utils.site_setup.execute`.

For an ERPNext-dependent app, remember frappe's setup wizard does not create an ERPNext Company —
create it in your own `ui_setup.execute`.

You do **not** need `set-config allow_tests true` in CI: `whitelist_for_tests` also passes when the
`CI` env var is set, and GitHub Actions always sets it.

## 5. Browser

```yaml
- uses: browser-actions/setup-chrome@latest
- run: echo "BROWSER_PATH=$(which chrome)" >> $GITHUB_ENV
```

then `--browser $BROWSER_PATH`. The runner image's bundled Chrome version drifts; pinning through
this action is what frappe does and it removes a class of "works locally, fails in CI" reports.

## 6. Caches

- `~/.cache/Cypress` — the binary, ~250 MB, downloaded on the first `run-ui-tests`. Cache it with a
  plain `${{ runner.os }}-cypress` key; there is no useful hash input, since bench installs the
  version *it* chooses, not one from your lockfile.
- yarn cache dir and pip cache — same as the server-tests workflow.

## 7. Sharding without Cypress Cloud

`assets/cypress.config.js` partitions specs by `SPLIT` / `SPLIT_INDEX`:

```yaml
strategy:
  matrix:
    container: [1, 2]
env:
  SPLIT: ${{ strategy.job-total }}
  SPLIT_INDEX: ${{ strategy.job-index }}
```

Round-robin over a sorted spec list — deterministic, no account, no secret. Granularity is one
**file**, so one enormous spec pins a shard and the other shards idle. Keep specs small.

`frappe/lms` uses the `cypress-split` package for the same env vars; the config in `assets/` does it
inline to avoid the module-resolution problem described in `bench-command.md`.

### The Cypress Cloud alternative

If you want duration-based load balancing and a hosted dashboard:

```yaml
- run: |
    bench --site $SITE_NAME run-ui-tests $APP_NAME \
      --headless --parallel \
      --ci-build-id $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT \
      -- --group ui-shard-${{ matrix.container }}
  env:
    CYPRESS_RECORD_KEY: ${{ secrets.CYPRESS_RECORD_KEY }}
```

Bench appends `--record` automatically whenever `CYPRESS_RECORD_KEY` is set, and `--parallel` also
sets `CYPRESS_CLOUD_PARALLEL=1` so local splitting backs off. You need a `projectId` in
`cypress.config.js` and a record key.

**On a public repo, a record key in a workflow file is readable by anyone** — and secrets are not
available to `pull_request` runs from forks, so Cloud-recorded runs will fail on exactly the PRs you
most want covered. Frappe's own repos do commit their record keys in plaintext, accepting that
someone can pollute their dashboard. Unless you specifically want the dashboard, local sharding is
the better default for an OSS repo.

## 8. Artifacts on failure

Videos and screenshots land under `apps/<your_app>/cypress/`. Upload both with
`if-no-files-found: ignore` (screenshots only exist if something failed). The
`after:spec` hook in `assets/cypress.config.js` deletes videos for clean specs, so the upload stays
small.

Always `cat bench_start.log` and `logs/*.log` — for server-side failures the Cypress video shows
only a generic error toast, and the traceback is in the bench log.

## 9. Branch protection

A matrix produces one check per shard, and the names change whenever you resize it. Add the
aggregate job from `assets/ui-tests.yml`:

```yaml
success:
  name: UI Success
  needs: [test]
  if: always()
  runs-on: ubuntu-latest
  steps:
    - run: |
        case "${{ needs.test.result }}" in
          success|skipped) exit 0 ;;
          *) exit 1 ;;
        esac
```

Require **`UI Success`** in branch protection. `skipped` must pass, or the paths-filter gate would
block every docs-only PR.

Roll it out non-blocking first: merge the workflow, let it run for a week or two, and only add it to
required checks once the flake rate is known. A newly required, newly flaky UI check is the fastest
way to get the whole thing disabled.

## 10. Optional — JS coverage

The repo probably already reports Python coverage to Codecov. To add the JS side:

```yaml
- name: Instrument source
  run: |
    cd ~/frappe-bench/apps/$APP_NAME
    npx nyc instrument -x '**/public/dist/**' -x '**/*.bundle.js' --in-place $APP_NAME
```

Run this **before** `bench build`, uncomment the `@cypress/code-coverage/support` import in
`cypress/support/e2e.js`, add `--with-coverage` to the bench command, and upload with a distinct
Codecov flag so JS and Python coverage don't overwrite each other. Coverage from a sharded run needs
merging (`npx nyc report`) — see the [Cypress code-coverage
plugin](https://github.com/cypress-io/code-coverage) and [nyc](https://github.com/istanbuljs/nyc).

Worth doing last, if at all. It adds a build step, a support-file import, and a merge step, all of
which can fail independently of the tests themselves.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Every spec times out; blank page in the video | Assets not built (`--skip-assets` with no `bench build`) |
| `cy.visit` fails immediately / connection refused | Server not up yet, or `/etc/hosts` entry missing, or `host_name` ≠ site name |
| Redirected to `/app/setup-wizard` | `complete_setup_wizard` not run |
| "Test endpoints are only available…" | `whitelist_for_tests` guard — `CI` not set, or running locally without `allow_tests` |
| `Cannot find module 'cypress-split'` | Bare import from the app dir; see `bench-command.md` |
| `Cannot find module '@testing-library/cypress'` | Same — you imported it directly instead of letting frappe's `commands.js` do it |
| Passes locally, fails in CI on a menu click | Chrome version drift, or `.es-menu` markup changed between frappe versions |
| One shard takes 10× the others | Spec files are too coarse; sharding is file-level |