// Loaded automatically before every spec (Cypress default supportFile).

// Pull in frappe's whole support file, not just its commands.js. Three things come with it:
// its ~45 custom commands (cy.login, cy.new_form, cy.fill_field, ...), the
// @cypress/code-coverage support hook, and a blanket `uncaught:exception -> false`.
//
// The relative hop matters: apps/<your_app>/cypress/support/ -> ../../../ -> apps/ -> frappe/.
// Because the import lands inside apps/frappe, frappe's own bare imports
// (@testing-library/cypress, @4tw/cypress-drag-drop, cypress-real-events, @cypress/code-coverage)
// resolve from apps/frappe/node_modules, which is where bench installs them.
import "../../../frappe/cypress/support/e2e"; // eslint-disable-line

// App-specific commands. Check references/cypress-commands.md first — most of what you need
// already exists above.
import "./commands";

// Frappe swallows every uncaught exception from the app under test. That hides Desk noise
// (ResizeObserver loops, XHRs aborted by navigation) but also hides real regressions in your own
// client scripts. Uncomment to narrow it while debugging a swallowed error:
//
// Cypress.on("uncaught:exception", (err) =>
// 	/ResizeObserver loop/.test(err.message) ? false : undefined
// );

// If this app talks to an external API, kill it at the network layer. A "sandbox mode" setting
// usually only rewrites the URL path and still egresses — a stray cy.visit onto a settings page
// would otherwise hit production. forceNetworkError rather than a stub, so the failure is loud.
//
// beforeEach(() => {
// 	cy.intercept("https://api.vendor.example/**", { forceNetworkError: true });
// });
