import frappe
import json
from frappe import _ 
from frappe.utils import flt, now_datetime

# --- HELPER ---

def get_assigned_pos_profile():
    """Fetches the POS Profile assigned to the current user."""
    user = frappe.session.user
    profile_name = frappe.db.get_value("POS Profile User", {"user": user}, "parent")
    if not profile_name:
        frappe.throw(_("No POS Profile assigned to user {0}.").format(user))
    return frappe.get_doc("POS Profile", profile_name)

# --- SHIFT MANAGEMENT ---

@frappe.whitelist()
def check_pos_opening():
    """Checks active shift and returns profile configuration."""
    profile = get_assigned_pos_profile()
    opening_entry = frappe.db.get_value("POS Opening Entry", 
        {"pos_profile": profile.name, "user": frappe.session.user, "status": "Open", "docstatus": 1}, 
        "name"
    )
    
    payment_methods = [p.mode_of_payment for p in profile.payments]
    
    return {
        "opening_entry": opening_entry,
        "pos_profile": profile.name,
        "company": profile.company,
        "customer": profile.customer,
        "payment_methods": payment_methods
    }

@frappe.whitelist()
def create_opening_entry(pos_profile, amount=0):
    """Creates and submits a new POS Opening Entry."""
    doc = frappe.new_doc("POS Opening Entry")
    doc.pos_profile = pos_profile
    doc.user = frappe.session.user
    doc.company = frappe.db.get_value("POS Profile", pos_profile, "company")
    doc.period_start_date = now_datetime()
    
    profile_doc = frappe.get_doc("POS Profile", pos_profile)
    if profile_doc.payments:
        doc.append("balance_details", {
            "mode_of_payment": profile_doc.payments[0].mode_of_payment,
            "opening_amount": flt(amount)
        })
    
    doc.insert()
    doc.submit()
    return doc.name

# --- CORE TRANSACTION LOGIC ---

@frappe.whitelist()
def get_products():
    """Fetches items for the visual grid based on the POS Profile Price List."""
    profile = get_assigned_pos_profile()
    return frappe.db.sql("""
        SELECT 
            i.name as item_code, i.item_name, i.image,
            COALESCE((SELECT price_list_rate FROM `tabItem Price` 
                      WHERE item_code = i.name AND price_list = %s LIMIT 1), 0) as price
        FROM `tabItem` i 
        WHERE i.disabled = 0 AND i.has_variants = 0 AND i.is_sales_item = 1
        ORDER BY i.item_name ASC LIMIT 100
    """, (profile.selling_price_list,), as_dict=1)

@frappe.whitelist()
def get_item_by_barcode(barcode):
    """Searches for an item by barcode or Item Code and returns price/details."""
    item_code = frappe.db.get_value("Item Barcode", {"barcode": barcode}, "parent")
    
    if not item_code:
        if frappe.db.exists("Item", barcode):
            item_code = barcode

    if item_code:
        profile = get_assigned_pos_profile()
        item_data = frappe.db.sql("""
            SELECT 
                i.name as item_code, 
                i.item_name, 
                i.image,
                COALESCE((SELECT price_list_rate FROM `tabItem Price` 
                          WHERE item_code = i.name AND price_list = %s LIMIT 1), 0) as price
            FROM `tabItem` i 
            WHERE i.name = %s
        """, (profile.selling_price_list, item_code), as_dict=1)

        return item_data[0] if item_data else None
    return None

@frappe.whitelist()
def create_invoice(cart, customer=None, mode_of_payment="Cash", amount_paid=0):
    """Creates a POS Invoice. Qty is converted to flt to support decimals like 0.5."""
    profile = get_assigned_pos_profile()
    opening_data = check_pos_opening()
    
    if not opening_data.get("opening_entry"):
        frappe.throw(_("Please open a POS shift first."))

    selected_customer = customer or profile.customer or "Guest"

    invoice = frappe.new_doc("POS Invoice")
    invoice.pos_opening_entry = opening_data["opening_entry"]
    invoice.pos_profile = profile.name
    invoice.customer = selected_customer
    invoice.company = profile.company
    invoice.update_stock = 1
    invoice.set_posting_time = 1
    
    items = json.loads(cart)
    for i in items:
        invoice.append("items", {
            "item_code": i.get("item_code"),
            "qty": flt(i.get("qty")), 
            "rate": flt(i.get("price")),
            "warehouse": profile.warehouse
        })

    invoice.set_missing_values()
    invoice.calculate_taxes_and_totals()

    invoice.set("payments", [])
    
    payment_account = frappe.db.get_value("Mode of Payment Account", 
        {"parent": mode_of_payment, "company": profile.company}, "default_account")

    if not payment_account:
        frappe.throw(_("Account not found for {0}").format(mode_of_payment))

    invoice.append("payments", {
        "mode_of_payment": mode_of_payment,
        "account": payment_account,
        "amount": flt(amount_paid) 
    })

    invoice.insert()
    invoice.submit()
    
    # Update the link to the opening entry
    frappe.db.set_value("POS Invoice", invoice.name, "pos_opening_entry", opening_data["opening_entry"])
    
    return invoice.name

# --- RECENT ORDERS LOGIC ---

@frappe.whitelist()
def get_recent_invoices(opening_entry):
    """Bypasses permissions to fetch invoices for the current shift list."""
    return frappe.db.get_list('POS Invoice',
        filters={
            'pos_opening_entry': opening_entry,
            'docstatus': 1
        },
        fields=['name', 'customer', 'grand_total', 'creation'],
        order_by='creation desc',
        limit=10
    )

# --- IMPROVED CLOSING LOGIC ---

@frappe.whitelist()
def close_pos_shift(opening_entry):
    """Closes shift and reconciles all POS Invoices."""
    opening_doc = frappe.get_doc("POS Opening Entry", opening_entry)
    
    invoices = frappe.get_all("POS Invoice", 
        filters={"pos_opening_entry": opening_entry, "docstatus": 1},
        fields=["name", "grand_total", "net_total", "total_qty", "posting_date"]
    )
    
    if not invoices:
        frappe.throw(_("No submitted invoices found for this shift."))

    closing_doc = frappe.new_doc("POS Closing Entry")
    closing_doc.pos_opening_entry = opening_entry
    closing_doc.pos_profile = opening_doc.pos_profile
    closing_doc.user = opening_doc.user
    closing_doc.company = opening_doc.company
    closing_doc.period_start_date = opening_doc.period_start_date
    closing_doc.period_end_date = now_datetime()

    for inv in invoices:
        closing_doc.append("pos_transactions", {
            "pos_invoice": inv.name,
            "grand_total": inv.grand_total,
            "posting_date": inv.posting_date
        })

    opening_amounts = {d.mode_of_payment: d.opening_amount for d in opening_doc.balance_details}

    payment_data = frappe.db.sql("""
        SELECT p.mode_of_payment, SUM(p.amount - inv.change_amount) as total_amount
        FROM `tabSales Invoice Payment` p
        JOIN `tabPOS Invoice` inv ON p.parent = inv.name
        WHERE inv.pos_opening_entry = %s AND inv.docstatus = 1
        GROUP BY p.mode_of_payment
    """, (opening_entry), as_dict=1)

    for pay in payment_data:
        mop = pay.mode_of_payment
        opening_amt = flt(opening_amounts.get(mop, 0))
        net_payment = flt(pay.total_amount)
        
        closing_doc.append("payment_reconciliation", {
            "mode_of_payment": mop,
            "opening_amount": opening_amt,
            "expected_amount": opening_amt + net_payment,
            "closing_amount": opening_amt + net_payment
        })

    closing_doc.grand_total = sum(inv.grand_total for inv in invoices)
    closing_doc.net_total = sum(inv.net_total for inv in invoices)
    closing_doc.total_quantity = sum(inv.total_qty for inv in invoices)

    closing_doc.insert()
    closing_doc.submit()
    return closing_doc.name