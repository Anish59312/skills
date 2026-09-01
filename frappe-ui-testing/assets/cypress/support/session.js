// Login and Desk bootstrap.
//
// Plain exported functions rather than Cypress commands: there is no global namespace to collide
// with, so no prefix is needed, and the import line documents where the helper came from.

const SUPPRESS_NOTIFICATIONS = "<app>.tests.ui_test_helpers.suppress_notifications";

// User defaults whose msgprint fires on app_ready. With testIsolation: false the resulting modal
// is not cleared between it() blocks and sits over the page behind a backdrop, so every
// subsequent click in the file fails.
const NOTIFICATION_KEYS = [];

export function bootstrap() {
	// Wraps cy.session, so this is cached within the spec file. Frappe does not set
	// cacheAcrossSpecs, so each spec file still pays one real login.
	cy.login();
	cy.visit("/desk");
	cy.desk_ready();

	if (!NOTIFICATION_KEYS.length) return;

	cy.window({ log: false }).then((win) => {
		const defaults = win.frappe.boot.sysdefaults || {};
		const outstanding = NOTIFICATION_KEYS.filter((key) => Number(defaults[key]));

		if (!outstanding.length) return;

		cy.call(SUPPRESS_NOTIFICATIONS);
		// The flags reach the client through boot_session bootinfo, so the page must reboot
		// before the change is visible. Clearing the server cache alone does nothing here.
		cy.reload();
		cy.desk_ready();
	});
}
