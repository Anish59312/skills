// Cypress config for a custom Frappe app.
//
// This file MUST live at the app root (apps/<your_app>/cypress.config.js) — `bench run-ui-tests`
// chdirs here before launching Cypress.
//
// Deliberately a plain object rather than `defineConfig({...})`: `require("cypress")` does not
// resolve from an app directory, because the Cypress binary lives in apps/frappe/node_modules.
// `defineConfig` is only a typing helper, so nothing is lost. If you add `cypress` to this app's
// own devDependencies you can switch to `defineConfig` — see references/bench-command.md.

const fs = require("fs");
const path = require("path");

const E2E_DIR = "cypress/e2e";

// Shard specs across a CI matrix without Cypress Cloud. GitHub Actions supplies
// SPLIT=${{ strategy.job-total }} and SPLIT_INDEX=${{ strategy.job-index }}.
// File-level granularity, so keep specs small and numerous.
function get_spec_pattern() {
	const split = parseInt(process.env.SPLIT, 10);
	const index = parseInt(process.env.SPLIT_INDEX, 10);

	if (!split || split <= 1 || Number.isNaN(index)) {
		return `./${E2E_DIR}/**/*.cy.js`;
	}

	const specs = fs
		.readdirSync(path.join(__dirname, E2E_DIR), { recursive: true })
		.filter((file) => file.endsWith(".cy.js"))
		.sort() // stable order, so every shard agrees on the partition
		.filter((_, i) => i % split === index)
		.map((file) => `./${E2E_DIR}/${file}`);

	// Cypress errors out on an empty spec list; give an unmatchable pattern instead.
	return specs.length ? specs : [`./${E2E_DIR}/__no_specs_for_this_shard__.cy.js`];
}

module.exports = {
	// Only needed if you record to Cypress Cloud. Delete otherwise.
	// projectId: "xxxxxx",

	// Both are overridden at run time by bench (CYPRESS_baseUrl from the site URL,
	// CYPRESS_adminPassword from site_config). Kept so `npx cypress open` works standalone.
	adminPassword: "admin",
	testUser: "frappe@example.com",

	defaultCommandTimeout: 20000,
	pageLoadTimeout: 15000,
	viewportWidth: 1400,
	viewportHeight: 960,

	video: true,
	retries: {
		runMode: 2,
		openMode: 0,
	},

	e2e: {
		baseUrl: "http://test_site:8000",
		specPattern: get_spec_pattern(),

		// Matches frappe's own suite: state carries between it() blocks within a spec.
		// Set to true if you would rather each test start clean (costs a re-login per test).
		testIsolation: false,

		setupNodeEvents(on, config) {
			// Only needed because frappe's support/e2e.js imports @cypress/code-coverage/support,
			// which errors if the task is missing while CYPRESS_coverage is true.
			//
			// Gated on CI deliberately. The plugin is inert either way — nothing in frappe's
			// esbuild pipeline runs babel-plugin-istanbul, so window.__coverage__ never exists and
			// `--with-coverage` writes an empty coverage/ and .nyc_output/. Keeping it off locally
			// stops those artifacts appearing in the working tree. Gitignore both regardless.
			if (process.env.CI) {
				require("../frappe/node_modules/@cypress/code-coverage/task")(on, config);
			}

			on("before:browser:launch", (browser, launchOptions) => {
				if (browser.family === "chromium") {
					launchOptions.args.push("--disable-dev-shm-usage");
					launchOptions.args.push("--disable-gpu");
					launchOptions.args.push("--no-sandbox");
				}
				return launchOptions;
			});

			// Keep videos only for specs that failed or were retried.
			on("after:spec", (spec, results) => {
				if (!results || !results.video) return;
				const failed = results.tests.some((test) =>
					test.attempts.some((attempt) => attempt.state === "failed")
				);
				if (!failed) fs.unlinkSync(results.video);
			});

			return config;
		},
	},
};
