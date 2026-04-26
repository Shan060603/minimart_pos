import json

import frappe
from erpnext.accounts.doctype.pos_closing_entry.pos_closing_entry import make_closing_entry_from_opening
from erpnext.stock.stock_ledger import NegativeStockError
from frappe import _
from frappe.utils import flt, now_datetime


@frappe.whitelist()
def get_item_uoms_and_prices(item_code, price_list=None):
	"""Return UOMs and prices for an item, for POS UOM switching."""
	if not item_code:
		return []
	item = frappe.get_doc("Item", item_code)
	uoms = []
	stock_uom = item.stock_uom
	price_list = price_list or frappe.db.get_single_value("Selling Settings", "selling_price_list")

	# Always include stock UOM
	uom_row = {"uom": stock_uom, "conversion_factor": 1, "is_stock_uom": 1}
	uoms.append(uom_row)

	# Add other UOMs from Item UOM table
	for row in item.uoms:
		if row.uom != stock_uom:
			uoms.append({"uom": row.uom, "conversion_factor": row.conversion_factor, "is_stock_uom": 0})

	# Fetch prices for each UOM
	for uom in uoms:
		price = frappe.db.get_value(
			"Item Price",
			{"item_code": item_code, "uom": uom["uom"], "price_list": price_list},
			"price_list_rate",
		)
		uom["price"] = frappe.utils.flt(price) if price is not None else 0

	return uoms


# --- HELPER ---


def get_assigned_pos_profile():
	"""Fetches the POS Profile assigned to the current user."""
	user = frappe.session.user
	profile_name = frappe.db.get_value("POS Profile User", {"user": user}, "parent")
	if not profile_name:
		frappe.throw(_("No POS Profile assigned to user {0}.").format(user))
	return frappe.get_doc("POS Profile", profile_name)


def validate_shift_stock(opening_entry):
	"""Fail early with a clean message if closing the shift would create negative stock."""
	stock_rows = frappe.db.sql(
		"""
		SELECT
			item.item_code,
			item.warehouse,
			SUM(item.stock_qty) AS required_qty
		FROM `tabPOS Invoice Item` item
		INNER JOIN `tabPOS Invoice` invoice ON invoice.name = item.parent
		WHERE invoice.pos_opening_entry = %s
			AND invoice.docstatus = 1
			AND IFNULL(item.warehouse, '') != ''
		GROUP BY item.item_code, item.warehouse
		HAVING required_qty > 0
		""",
		(opening_entry,),
		as_dict=1,
	)

	for row in stock_rows:
		actual_qty = flt(
			frappe.db.get_value("Bin", {"item_code": row.item_code, "warehouse": row.warehouse}, "actual_qty")
		)
		required_qty = flt(row.required_qty)

		if actual_qty < required_qty:
			frappe.throw(
				_("{0} needs {1} units in warehouse {2}, but only {3} are available for POS closing.").format(
					frappe.bold(row.item_code),
					frappe.bold(required_qty),
					frappe.bold(row.warehouse),
					frappe.bold(actual_qty),
				),
				NegativeStockError,
				title=_("Insufficient Stock"),
			)


# --- SHIFT MANAGEMENT ---


@frappe.whitelist()
def check_pos_opening():
	"""Checks active shift and returns profile configuration."""
	profile = get_assigned_pos_profile()
	opening_entry = frappe.db.get_value(
		"POS Opening Entry",
		{"pos_profile": profile.name, "user": frappe.session.user, "status": "Open", "docstatus": 1},
		"name",
	)

	payment_methods = [p.mode_of_payment for p in profile.payments]

	return {
		"opening_entry": opening_entry,
		"pos_profile": profile.name,
		"company": profile.company,
		"customer": profile.customer,
		"payment_methods": payment_methods,
		"warehouse": profile.warehouse,
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
		doc.append(
			"balance_details",
			{"mode_of_payment": profile_doc.payments[0].mode_of_payment, "opening_amount": flt(amount)},
		)

	doc.insert()
	doc.submit()
	doc.status = "Open"
	doc.save()
	return doc.name


# --- CORE TRANSACTION LOGIC ---


@frappe.whitelist()
def get_products():
	"""Fetches items with Live Stock and Item Group."""
	profile = get_assigned_pos_profile()

	return frappe.db.sql(
		"""
        SELECT 
            i.name as item_code, 
            i.item_name, 
            i.image,
            i.item_group,
            COALESCE(ip.uom, i.stock_uom) as uom,
            CASE
                WHEN COALESCE(ip.uom, i.stock_uom) = i.stock_uom THEN 1
                ELSE COALESCE(iu.conversion_factor, 1)
            END as conversion_factor,
            COALESCE(ip.price_list_rate, 0) as price,
            COALESCE(b.actual_qty, 0) as actual_qty
        FROM `tabItem` i 
        LEFT JOIN `tabItem Price` ip ON ip.item_code = i.name AND ip.price_list = %s
        LEFT JOIN `tabUOM Conversion Detail` iu ON iu.parent = i.name AND iu.uom = ip.uom
        LEFT JOIN `tabBin` b ON b.item_code = i.name AND b.warehouse = %s
        WHERE i.disabled = 0 
          AND i.has_variants = 0 
          AND i.is_sales_item = 1
          AND COALESCE(b.actual_qty, 0) > 0
        ORDER BY i.item_name ASC, conversion_factor ASC
    """,
		(profile.selling_price_list, profile.warehouse),
		as_dict=1,
	)


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
		item_data = frappe.db.sql(
			"""
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
        """,
			(profile.selling_price_list, profile.warehouse, item_code),
			as_dict=1,
		)

		return item_data[0] if item_data else None
	return None


@frappe.whitelist()
def search_item(query):
	"""Find the first in-stock POS item by exact code or partial name/code match."""
	query = (query or "").strip()
	if not query:
		return None

	profile = get_assigned_pos_profile()
	like_query = f"%{query}%"

	items = frappe.db.sql(
		"""
		SELECT
			i.name as item_code,
			i.item_name,
			i.image,
			i.item_group,
			COALESCE(ip.uom, i.stock_uom) as uom,
			CASE
				WHEN COALESCE(ip.uom, i.stock_uom) = i.stock_uom THEN 1
				ELSE COALESCE(iu.conversion_factor, 1)
			END as conversion_factor,
			COALESCE(ip.price_list_rate, 0) as price,
			COALESCE(b.actual_qty, 0) as actual_qty
		FROM `tabItem` i
		LEFT JOIN `tabItem Price` ip ON ip.item_code = i.name AND ip.price_list = %s
		LEFT JOIN `tabUOM Conversion Detail` iu ON iu.parent = i.name AND iu.uom = ip.uom
		LEFT JOIN `tabBin` b ON b.item_code = i.name AND b.warehouse = %s
		WHERE i.disabled = 0
		  AND i.has_variants = 0
		  AND i.is_sales_item = 1
		  AND COALESCE(b.actual_qty, 0) > 0
		  AND (i.name = %s OR i.name LIKE %s OR i.item_name LIKE %s)
		ORDER BY
			CASE
				WHEN i.name = %s THEN 0
				WHEN i.item_name = %s THEN 1
				WHEN i.name LIKE %s THEN 2
				ELSE 3
			END,
			i.item_name ASC,
			conversion_factor ASC
		LIMIT 1
		""",
		(
			profile.selling_price_list,
			profile.warehouse,
			query,
			like_query,
			like_query,
			query,
			query,
			like_query,
		),
		as_dict=1,
	)

	return items[0] if items else None


@frappe.whitelist()
def create_invoice(cart, customer=None, mode_of_payment="Cash", amount_paid=0, total_payable=None):
	"""Creates a POS Invoice with clean reconciliation for Closing Entries."""
	profile = get_assigned_pos_profile()

	opening_entry = frappe.db.get_value(
		"POS Opening Entry",
		{"pos_profile": profile.name, "user": frappe.session.user, "status": "Open", "docstatus": 1},
		"name",
	)

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
		item_price = flt(i.get("price"))
		discount_pct = flt(i.get("discount_pct"))
		discount_amount = flt(item_price * (discount_pct / 100.0))
		discounted_rate = item_price - discount_amount

		# Use UOM if provided, else fallback to stock UOM
		item_doc = frappe.get_doc("Item", i.get("item_code"))
		uom = i.get("uom") or item_doc.stock_uom
		conversion_factor = 1
		if uom != item_doc.stock_uom:
			for row in item_doc.uoms:
				if row.uom == uom:
					conversion_factor = row.conversion_factor
					break

		invoice.append(
			"items",
			{
				"item_code": i.get("item_code"),
				"qty": flt(i.get("qty")),
				"uom": uom,
				"conversion_factor": conversion_factor,
				"rate": discounted_rate,
				"discount_percentage": discount_pct,
				"discount_amount": discount_amount,
				"warehouse": profile.warehouse,
				"price_list_rate": item_price,
				"allow_negative_stock": 1,
			},
		)

	invoice.set_missing_values()
	invoice.calculate_taxes_and_totals()

	if total_payable is not None:
		total_payable = flt(total_payable)
		if total_payable and flt(invoice.grand_total) != total_payable:
			invoice.apply_discount_on = "Grand Total"
			invoice.discount_amount = flt(invoice.grand_total - total_payable)
			invoice.calculate_taxes_and_totals()

	total_to_pay = flt(invoice.grand_total)
	paid = flt(amount_paid)
	change = paid - total_to_pay if paid > total_to_pay else 0

	invoice.paid_amount = paid
	invoice.change_amount = change

	payment_account = frappe.db.get_value(
		"Mode of Payment Account", {"parent": mode_of_payment, "company": profile.company}, "default_account"
	)

	invoice.append(
		"payments", {"mode_of_payment": mode_of_payment, "account": payment_account, "amount": total_to_pay}
	)

	invoice.insert()

	frappe.db.set_value(
		"POS Invoice",
		invoice.name,
		{"docstatus": 1, "status": "Paid", "paid_amount": paid, "change_amount": change},
		update_modified=False,
	)

	doc = frappe.get_doc("POS Invoice", invoice.name)
	doc.__dict__.update(
		{"enable_discount_accounting": 0, "use_company_roundoff_cost_center": 0, "is_opening": "No"}
	)

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
		items_to_return.append({"item_code": item.item_code, "qty": item.qty})

	doc.cancel()
	return items_to_return


# --- RECENT ORDERS & CLOSING ---


@frappe.whitelist()
def get_recent_invoices(opening_entry):
	return frappe.db.get_list(
		"POS Invoice",
		filters={"pos_opening_entry": opening_entry, "docstatus": 1},
		fields=["name", "customer", "grand_total", "creation"],
		order_by="creation desc",
		limit=10,
	)


@frappe.whitelist()
def close_pos_shift(opening_entry):
	"""Create and submit a POS Closing Entry for an open shift."""
	opening_doc = frappe.get_doc("POS Opening Entry", opening_entry)
	if opening_doc.status != "Open":
		frappe.throw(_("Shift is already closed."))

	invoices = frappe.get_all(
		"POS Invoice",
		filters={"pos_opening_entry": opening_entry, "docstatus": 1},
		fields=["name", "grand_total", "net_total", "total_qty", "posting_date"],
	)

	if not invoices:
		frappe.throw(_("No submitted invoices found for this shift."))

	validate_shift_stock(opening_entry)

	closing_doc = make_closing_entry_from_opening(opening_doc)
	closing_doc.period_end_date = now_datetime()
	closing_doc.insert()
	closing_doc.submit()
	frappe.db.set_value(
		"POS Opening Entry", opening_entry, {"status": "Closed", "pos_closing_entry": closing_doc.name}
	)
	return closing_doc.name
