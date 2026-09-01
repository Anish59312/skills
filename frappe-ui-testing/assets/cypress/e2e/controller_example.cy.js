// The same idea as example.cy.js, written through the controller layer. Compare the two: once a
// suite has more than a couple of specs, the second style is what keeps them readable.
//
// Run just this one:
//   bench --site <site> run-ui-tests <app> --headless --spec cypress/e2e/controller_example.cy.js

import FormController from "../support/controllers/form";
import { bootstrap } from "../support/session";
import { get } from "../support/test_records";

describe("Sales Order", () => {
	// Doctype is a constructor arg — no per-doctype controller file needed until one has
	// behaviour of its own.
	const page = new FormController("Sales Order");

	// Static import, so these resolve here in the describe body. A missing record throws now,
	// with the file path, instead of timing out later on a blank link field.
	const customer = get("Customer", "_Test Customer");
	const item = get("Item", "_Test Item");

	before(() => {
		bootstrap();
	});

	it("creates a draft order", () => {
		page.open_new();

		page.set_link("customer", customer.name);
		page.wait_for_settle();

		const items = page.grid("items");
		items.ensure_rows(1);
		items.set_link(1, "item_code", item.name);
		page.wait_for_settle();

		items.set(1, "qty", 2);
		items.collapse_row(1);
		page.wait_for_settle();

		// Assert against cur_frm.doc, not the DOM: the server computes these and they land in the
		// doc first.
		page.doc().should((doc) => {
			expect(doc.items, "one item row").to.have.length(1);
			expect(doc.items[0].amount, "amount computed").to.be.greaterThan(0);
		});

		page.save();
		page.assert_status("Draft");
	});

	// No after() teardown on purpose. With testIsolation: false and retries on, deleting a
	// document a retried attempt asserts on breaks the spec. A leftover _Test draft is cheap.
});
