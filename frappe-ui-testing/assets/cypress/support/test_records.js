// Accessors over the app's existing Python test records, so specs and unit tests agree on names.
//
// Create them first:
//     bench --site <site> execute <app>.tests.before_tests
//
// A STATIC import is required. Cypress bundles the support file and each spec separately, so a
// module populated during a before() hook would hand the spec a second, empty instance.
import records from "../../<app>/tests/test_records.json";

const RECORDS_PATH = "<app>/tests/test_records.json";

// Frappe autonames most doctypes as `field:<doctype>_name` (Company -> company_name,
// Supplier -> supplier_name, ...). List only the exceptions here. Records that carry an explicit
// `name` already hold the docname and take precedence.
const NAME_FIELD = { Item: "item_code" };

function docname(doctype, record) {
	const field = NAME_FIELD[doctype] || `${doctype.toLowerCase().replace(/ /g, "_")}_name`;

	return record.name || record[field];
}

function all(doctype) {
	return (records[doctype] || []).map((r) => ({ ...r, name: docname(doctype, r) }));
}

/** Single record, for dot access: get("Supplier", "_Test Supplier").gstin */
export function get(doctype, name) {
	const record = all(doctype).find((r) => r.name === name);

	if (!record) {
		// Fail at import time with something diagnosable, rather than 40 s later on a blank
		// link field.
		throw new Error(
			`No ${doctype} named "${name}" in ${RECORDS_PATH}. ` +
				`Has the record been renamed, or does before_tests need re-running?`
		);
	}

	return record;
}

/** Every record whose `property` equals `value`. */
export function find(doctype, property, value) {
	return all(doctype).filter((r) => r[property] === value);
}

// Resist adding semantic exports (registered_supplier, service_item, ...). Each is a second place
// to update when a record changes, and each is typically used once. Add a helper here only when it
// encodes a rule rather than a name — a derived value, a matcher, a format.
