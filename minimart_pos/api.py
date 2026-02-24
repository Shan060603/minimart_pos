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
        "payment_methods": payment_methods,
        "warehouse": profile.warehouse
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
    """Fetches items with Live Stock and Item Group."""
    profile = get_assigned_pos_profile()
    
    # ADDED: i.item_group to the SELECT statement
    return frappe.db.sql("""
        SELECT 
            i.name as item_code, 
            i.item_name, 
            i.image,
            i.item_group,
            COALESCE(ip.price_list_rate, 0) as price,
            COALESCE(b.actual_qty, 0) as actual_qty
        FROM `tabItem` i 
        LEFT JOIN `tabItem Price` ip ON ip.item_code = i.name AND ip.price_list = %s
        LEFT JOIN `tabBin` b ON b.item_code = i.name AND b.warehouse = %s
        WHERE i.disabled = 0 
          AND i.has_variants = 0 
          AND i.is_sales_item = 1
        ORDER BY i.item_name ASC 
        LIMIT 100
    """, (profile.selling_price_list, profile.warehouse), as_dict=1)

@frappe.whitelist()
def get_item_by_barcode(barcode):
    """Searches for an item with its current stock level and group."""
    item_code = frappe.db.get_value("Item Barcode", {"barcode": barcode}, "parent")
    
    if not item_code:
        if frappe.db.exists("Item", barcode):
            item_code = barcode

    if item_code:
        profile = get_assigned_pos_profile()
        # ADDED: i.item_group to the SELECT statement
        item_data = frappe.db.sql("""
            SELECT 
                i.name as item_code, 
                i.item_name, 
                i.image,
                i.item_group,
                COALESCE((SELECT price_list_rate FROM `tabItem Price` 
                          WHERE item_code = i.name AND price_list = %s LIMIT 1), 0) as price,
                COALESCE((SELECT actual_qty FROM `tabBin` 
                          WHERE item_code = i.name AND warehouse = %s LIMIT 1), 0) as actual_qty
            FROM `tabItem` i 
            WHERE i.name = %s
        """, (profile.selling_price_list, profile.warehouse, item_code), as_dict=1)

        return item_data[0] if item_data else None
    return None

@frappe.whitelist()
def create_invoice(cart, customer=None, mode_of_payment="Cash", amount_paid=0):
    """Creates a POS Invoice with clean reconciliation for Closing Entries."""
    profile = get_assigned_pos_profile()
    
    opening_entry = frappe.db.get_value("POS Opening Entry", 
        {"pos_profile": profile.name, "user": frappe.session.user, "status": "Open", "docstatus": 1}, "name")
    
    if not opening_entry:
        frappe.throw(_("Please open a POS shift first."))

    selected_customer = customer or profile.customer or "Guest"
    invoice = frappe.new_doc("POS Invoice")
    
    invoice.pos_profile = profile.name
    invoice.pos_opening_entry = opening_entry
    invoice.customer = selected_customer
    invoice.company = profile.company
    invoice.update_stock = 0 
    invoice.set_posting_time = 1
    invoice.posting_date = now_datetime().date()
    
    invoice.flags.ignore_permissions = True
    invoice.flags.ignore_validate_stock = True
    invoice.flags.ignore_mandatory = True

    items = json.loads(cart)
    for i in items:
        invoice.append("items", {
            "item_code": i.get("item_code"),
            "qty": flt(i.get("qty")), 
            "rate": flt(i.get("price")),
            "warehouse": profile.warehouse,
            "price_list_rate": flt(i.get("price")),
            "allow_negative_stock": 1
        })

    invoice.set_missing_values()
    invoice.calculate_taxes_and_totals()

    total_to_pay = flt(invoice.grand_total)
    paid = flt(amount_paid)
    change = paid - total_to_pay if paid > total_to_pay else 0
    
    invoice.paid_amount = paid
    invoice.change_amount = change

    payment_account = frappe.db.get_value("Mode of Payment Account", 
        {"parent": mode_of_payment, "company": profile.company}, "default_account")

    invoice.append("payments", {
        "mode_of_payment": mode_of_payment,
        "account": payment_account,
        "amount": total_to_pay 
    })

    invoice.insert()
    
    frappe.db.set_value("POS Invoice", invoice.name, {
        "docstatus": 1,
        "status": "Paid",
        "paid_amount": paid,
        "change_amount": change
    }, update_modified=False)
    
    doc = frappe.get_doc("POS Invoice", invoice.name)
    doc.__dict__.update({
        'enable_discount_accounting': 0,
        'use_company_roundoff_cost_center': 0,
        'is_opening': 'No'
    })
    
    try:
        doc.make_gl_entries()
    except Exception:
        frappe.log_error(frappe.get_traceback(), _("POS GL Failure"))
    
    frappe.db.commit() 
    return invoice.name

# --- VOID / CANCEL LOGIC ---

@frappe.whitelist()
def void_invoice(invoice_name):
    """Cancels a POS Invoice and returns items to restore UI stock counts."""
    doc = frappe.get_doc("POS Invoice", invoice_name)
    if doc.docstatus != 1:
        frappe.throw(_("Only submitted invoices can be voided."))
        
    items_to_return = []
    for item in doc.items:
        items_to_return.append({
            "item_code": item.item_code,
            "qty": item.qty
        })
        
    doc.cancel()
    return items_to_return

# --- RECENT ORDERS & CLOSING ---

@frappe.whitelist()
def get_recent_invoices(opening_entry):
    return frappe.db.get_list('POS Invoice',
        filters={'pos_opening_entry': opening_entry, 'docstatus': 1},
        fields=['name', 'customer', 'grand_total', 'creation'],
        order_by='creation desc',
        limit=10
    )

@frappe.whitelist()
def close_pos_shift(opening_entry):
    """Consolidates shift data with corrected reconciliation logic."""
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

    total_grand = 0
    total_net = 0
    total_q = 0

    for inv in invoices:
        closing_doc.append("pos_transactions", {
            "pos_invoice": inv.name,
            "grand_total": inv.grand_total,
            "posting_date": inv.posting_date
        })
        total_grand += flt(inv.grand_total)
        total_net += flt(inv.net_total)
        total_q += flt(inv.total_qty)

    closing_doc.grand_total = total_grand
    closing_doc.net_total = total_net
    closing_doc.total_quantity = total_q

    payment_data = frappe.db.sql("""
        SELECT p.mode_of_payment, SUM(p.amount) as total_amount
        FROM `tabSales Invoice Payment` p
        JOIN `tabPOS Invoice` inv ON p.parent = inv.name
        WHERE inv.pos_opening_entry = %s AND inv.docstatus = 1
        GROUP BY p.mode_of_payment
    """, (opening_entry), as_dict=1)

    opening_amounts = {d.mode_of_payment: d.opening_amount for d in opening_doc.balance_details}
    reconciled_mops = {p.mode_of_payment: p.total_amount for p in payment_data}
    
    profile_mops = frappe.get_doc("POS Profile", opening_doc.pos_profile).payments

    for mop_row in profile_mops:
        mop = mop_row.mode_of_payment
        opening_amt = flt(opening_amounts.get(mop, 0))
        sales_amt = flt(reconciled_mops.get(mop, 0))
        
        closing_doc.append("payment_reconciliation", {
            "mode_of_payment": mop,
            "opening_amount": opening_amt,
            "expected_amount": opening_amt + sales_amt,
            "closing_amount": opening_amt + sales_amt
        })

    closing_doc.insert()
    closing_doc.submit()
    return closing_doc.name