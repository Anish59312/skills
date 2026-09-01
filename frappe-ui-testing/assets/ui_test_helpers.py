"""Server-side fixtures for Cypress UI tests.

Copy to <app>/tests/ui_test_helpers.py. Called from specs with
cy.call("<app>.tests.ui_test_helpers.<fn>").

Reachability: whitelist_for_tests passes when frappe.in_test, OR on a dev server
(DEV_SERVER=true) with `allow_tests` in site config, OR whenever the CI env var is set. That last
clause means these endpoints answer plain HTTP on any CI runner with no opt-in. Write them as
though they are exposed, because they are: take explicit identifiers, never a pattern to expand.
"""

import frappe
from frappe.tests.utils import whitelist_for_tests

# User defaults whose app_ready msgprint would block the Desk.
NOTIFICATION_KEYS = ()


@whitelist_for_tests(methods=["POST"])
def suppress_notifications():
    """Stop app_ready msgprint modals from blocking the Desk.

    With testIsolation: false the modal is not cleared between it() blocks and sits over the page
    behind a backdrop. The caller must cy.reload() afterwards — these flags reach the client
    through boot_session bootinfo.
    """
    for key in NOTIFICATION_KEYS:
        # No `parent`: clears the DefaultValue row for every parent (__default, __global and each
        # user). bootinfo.sysdefaults merges all of them, so clearing one is not enough.
        frappe.defaults.clear_default(key)
        # clear_default only invalidates a user's own cache when handed that user as `parent`.
        frappe.defaults.clear_user_default(key)

    return {"cleared": list(NOTIFICATION_KEYS)}


@whitelist_for_tests(methods=["POST"])
def set_single_values(doctype, **kwargs):
    """Set fields on a Single.

    This is globally shared state. Any spec touching it must own its own spec file and restore the
    previous values in after(). Singles reach the client only through boot_session bootinfo, so the
    caller MUST cy.reload() for the change to be visible to client scripts — frappe.clear_cache()
    on the server does nothing for the page already loaded.
    """
    for field, value in kwargs.items():
        frappe.db.set_single_value(doctype, field, value)

    frappe.clear_cache()

    return kwargs


@whitelist_for_tests(methods=["POST"])
def delete_documents(doctype, names):
    """Cancel-then-delete the named documents.

    Prefer NOT calling this. With testIsolation: false and retries on, deleting a document that a
    retried attempt or a later spec asserts on breaks that spec, and submitted documents drag in a
    whole class of Cancelled -> Delete -> linked GL/SLE failures. A leftover _Test draft is cheap;
    a flaky teardown is not.

    Takes explicit names, never filters: a whitelisted endpoint that expands `name like "_Test%"`
    server-side is a wildcard delete reachable over HTTP.
    """
    # cy.call form-encodes its args, so a JS array arrives as a JSON string.
    names = frappe.parse_json(names) if isinstance(names, str) else names

    for name in names:
        doc = frappe.get_doc(doctype, name)
        if doc.docstatus == 1:
            doc.cancel()

        doc.delete(ignore_permissions=True)

    return names
