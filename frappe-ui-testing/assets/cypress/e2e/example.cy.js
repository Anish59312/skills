// Template spec. Rename, and replace the doctype/fields with something your app actually owns.
//
// Run just this one:
//   bench --site <site> run-ui-tests <app> --headless --spec cypress/e2e/example.cy.js

context("Example — new form", () => {
	before(() => {
		cy.login();
		// Server-side fixtures belong here, not in the UI:
		// cy.call("myapp.tests.ui_test_helpers.setup_ui_test_data");
	});

	it("creates a ToDo from the Desk", () => {
		cy.new_form("ToDo");

		// Always pass the real fieldtype — fill_field branches on it, and a Link filled as
		// "Data" silently leaves the field unset.
		cy.fill_field("description", "UI test todo", "Text Editor");
		cy.fill_field("priority", "High", "Select");

		cy.save();

		// Read the doc back rather than re-reading the DOM.
		cy.compare_document({
			description: "<div class=\"ql-editor read-mode\"><p>UI test todo</p></div>",
			priority: "High",
			status: "Open",
		});
	});

	it("shows the new ToDo in the list", () => {
		cy.go_to_list("ToDo");
		cy.desk_ready();
		cy.findByText("UI test todo").should("be.visible");
	});

	after(() => {
		// Teardown is optional and often counterproductive — see spec-architecture.md. Only do
		// this where a leftover really would break a later spec.
		cy.get_list("ToDo", ["name"], [["description", "like", "%UI test todo%"]]).then((res) => {
			res.data.forEach((row) => cy.remove_doc("ToDo", row.name, true));
		});
	});
});
