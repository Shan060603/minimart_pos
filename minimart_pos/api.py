import json

import frappe
from erpnext.accounts.doctype.pos_closing_entry.pos_closing_entry import make_closing_entry_from_opening
from erpnext.accounts.doctype.pos_invoice.pos_invoice import get_stock_availability
from erpnext.selling.doctype.customer.customer import get_credit_limit, get_customer_outstanding
from erpnext.stock.stock_ledger import NegativeStockError
from frappe import _
from frappe.utils import flt, getdate, now_datetime


def get_current_pricing_date():
	return getdate(now_datetime())


def get_latest_item_price_rate(item_code, uom, price_list, pricing_date=None):
	"""Return the latest active price for one item/UOM/price list as of the given date."""
	pricing_date = pricing_date or get_current_pricing_date()
	result = frappe.db.sql(
		"""
		SELECT ip.price_list_rate
		FROM `tabItem Price` ip
		WHERE ip.item_code = %s
			AND ip.price_list = %s
			AND IFNULL(ip.uom, '') = %s
			AND (ip.valid_from IS NULL OR ip.valid_from <= %s)
			AND (ip.valid_upto IS NULL OR ip.valid_upto >= %s)
		ORDER BY
			COALESCE(ip.valid_from, '1900-01-01') DESC,
			COALESCE(ip.creation, '1900-01-01 00:00:00') DESC,
			ip.name DESC
		LIMIT 1
		""",
		(item_code, price_list, uom or "", pricing_date, pricing_date),
	)
	return flt(result[0][0]) if result else 0


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
		uom["price"] = get_latest_item_price_rate(item_code, uom["uom"], price_list)

	return uoms


# --- HELPER ---


def get_assigned_pos_profile():
	"""Fetches the POS Profile assigned to the current user."""
	user = frappe.session.user
	profile_name = frappe.db.get_value("POS Profile User", {"user": user}, "parent")
	if not profile_name:
		frappe.throw(_("No POS Profile assigned to user {0}.").format(user))
	return frappe.get_doc("POS Profile", profile_name)


def is_active_product_bundle(item_code):
	return bool(frappe.db.exists("Product Bundle", {"name": item_code, "disabled": 0}))


def get_bundle_components(item_code, warehouse=None):
	if not is_active_product_bundle(item_code):
		return []

	components = frappe.get_all(
		"Product Bundle Item",
		filters={"parent": item_code},
		fields=["item_code", "qty"],
		order_by="idx asc",
	)

	component_rows = []
	for row in components:
		if not frappe.db.get_value("Item", row.item_code, "is_stock_item"):
			continue

		component = {"item_code": row.item_code, "qty": flt(row.qty)}
		if warehouse:
			component["available_qty"] = get_available_qty(row.item_code, warehouse)
		component_rows.append(component)

	return component_rows


def get_available_qty(item_code, warehouse):
	availability, is_stock_item, _ = get_stock_availability(item_code, warehouse)
	if not is_stock_item:
		return 0
	return flt(availability)


def enrich_pos_item(row, warehouse):
	row = dict(row)
	row["bundle_components"] = get_bundle_components(row["item_code"], warehouse=warehouse)
	row["is_product_bundle"] = 1 if row["bundle_components"] else 0
	row["actual_qty"] = get_available_qty(row["item_code"], warehouse)
	return row


def get_stock_qty_map(item_codes, warehouse):
	"""Fetch stock in one query so the POS grid doesn't resolve each item individually."""
	if not item_codes or not warehouse:
		return {}

	rows = frappe.get_all(
		"Bin",
		filters={"warehouse": warehouse, "item_code": ["in", list(item_codes)]},
		fields=["item_code", "actual_qty"],
		limit_page_length=0,
	)
	return {row.item_code: flt(row.actual_qty) for row in rows}


def get_active_bundle_names(item_codes):
	if not item_codes:
		return set()

	return set(
		frappe.get_all(
			"Product Bundle",
			filters={"name": ["in", list(item_codes)], "disabled": 0},
			pluck="name",
			limit_page_length=0,
		)
	)


def get_bundle_component_map(bundle_names, stock_qty_map=None):
	if not bundle_names:
		return {}

	component_rows = frappe.get_all(
		"Product Bundle Item",
		filters={"parent": ["in", list(bundle_names)]},
		fields=["parent", "item_code", "qty"],
		order_by="parent asc, idx asc",
		limit_page_length=0,
	)
	if not component_rows:
		return {}

	component_item_codes = {row.item_code for row in component_rows}
	stock_items = set(
		frappe.get_all(
			"Item",
			filters={"name": ["in", list(component_item_codes)], "is_stock_item": 1},
			pluck="name",
			limit_page_length=0,
		)
	)

	bundle_components = {bundle_name: [] for bundle_name in bundle_names}
	stock_qty_map = stock_qty_map or {}

	for row in component_rows:
		if row.item_code not in stock_items:
			continue

		bundle_components.setdefault(row.parent, []).append(
			{
				"item_code": row.item_code,
				"qty": flt(row.qty),
				"available_qty": flt(stock_qty_map.get(row.item_code, 0)),
			}
		)

	return bundle_components


def get_bundle_available_qty(components):
	if not components:
		return 0

	possible_qty = []
	for component in components:
		component_qty = flt(component.get("qty")) or 0
		if component_qty <= 0:
			continue
		possible_qty.append(flt(component.get("available_qty")) / component_qty)

	return min(possible_qty) if possible_qty else 0


def get_catalog_rows(profile, item_code=None, search_term=None, item_group=None, limit_page_length=None, in_stock_only=True):
	pricing_date = get_current_pricing_date()
	conditions = [
		"i.disabled = 0",
		"i.has_variants = 0",
		"i.is_sales_item = 1",
		"(i.is_stock_item = 1 OR EXISTS (SELECT 1 FROM `tabProduct Bundle` pb WHERE pb.name = i.name AND pb.disabled = 0))",
	]
	values = [profile.selling_price_list, pricing_date, pricing_date, pricing_date, pricing_date]

	warehouse = (profile.warehouse or "").strip()
	if in_stock_only and warehouse:
		conditions.append("EXISTS (SELECT 1 FROM `tabBin` b WHERE b.item_code = i.name AND b.warehouse = %s AND b.actual_qty > 0)")
		values.append(warehouse)

	if item_code:
		conditions.append("i.name = %s")
		values.append(item_code)

	if item_group:
		conditions.append("i.item_group = %s")
		values.append(item_group)

	if search_term:
		like_query = f"%{search_term}%"
		conditions.append(
			"(i.name = %s OR i.name LIKE %s OR i.item_name LIKE %s OR EXISTS (SELECT 1 FROM `tabItem Barcode` ib WHERE ib.parent = i.name AND ib.barcode = %s))"
		)
		values.extend([search_term, like_query, like_query, search_term])

	order_by = "i.item_name ASC, conversion_factor ASC"
	if search_term:
		like_query = f"%{search_term}%"
		values.extend([search_term, search_term, like_query])
		order_by = """
			CASE
				WHEN i.name = %s THEN 0
				WHEN i.item_name = %s THEN 1
				WHEN i.name LIKE %s THEN 2
				ELSE 3
			END,
			i.item_name ASC,
			conversion_factor ASC
		"""

	limit_clause = ""
	if limit_page_length:
		limit_clause = "LIMIT %s"
		values.append(int(limit_page_length))

	return frappe.db.sql(
		f"""
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
			COALESCE(ip.price_list_rate, 0) as price
		FROM `tabItem` i
		LEFT JOIN `tabItem Price` ip
			ON ip.item_code = i.name
			AND ip.price_list = %s
			AND (ip.valid_from IS NULL OR ip.valid_from <= %s)
			AND (ip.valid_upto IS NULL OR ip.valid_upto >= %s)
			AND NOT EXISTS (
				SELECT 1
				FROM `tabItem Price` ip_newer
				WHERE ip_newer.item_code = ip.item_code
					AND ip_newer.price_list = ip.price_list
					AND IFNULL(ip_newer.uom, '') = IFNULL(ip.uom, '')
					AND (ip_newer.valid_from IS NULL OR ip_newer.valid_from <= %s)
					AND (ip_newer.valid_upto IS NULL OR ip_newer.valid_upto >= %s)
					AND (
						COALESCE(ip_newer.valid_from, '1900-01-01') > COALESCE(ip.valid_from, '1900-01-01')
						OR (
							COALESCE(ip_newer.valid_from, '1900-01-01') = COALESCE(ip.valid_from, '1900-01-01')
							AND COALESCE(ip_newer.creation, '1900-01-01 00:00:00') > COALESCE(ip.creation, '1900-01-01 00:00:00')
						)
						OR (
							COALESCE(ip_newer.valid_from, '1900-01-01') = COALESCE(ip.valid_from, '1900-01-01')
							AND COALESCE(ip_newer.creation, '1900-01-01 00:00:00') = COALESCE(ip.creation, '1900-01-01 00:00:00')
							AND ip_newer.name > ip.name
						)
					)
			)
		LEFT JOIN `tabUOM Conversion Detail` iu ON iu.parent = i.name AND iu.uom = ip.uom
		WHERE {" AND ".join(conditions)}
		ORDER BY {order_by}
		{limit_clause}
		""",
		values,
		as_dict=1,
	)


def validate_shift_stock(opening_entry):
	"""Fail early with a clean message if closing the shift would create negative stock."""
	# Reuse ERPNext POS invoice selection logic.
	# ERPNext's POS closing helper uses `get_pos_invoices(...)` to determine the invoices
	# that belong to the opening shift; we must do the same here.
	opening_doc = frappe.get_doc("POS Opening Entry", opening_entry)

	# ERPNext helper expects: start, end, pos_profile, user.
	period_start_date = opening_doc.period_start_date

	# ERPNext's make_closing_entry_from_opening() uses current datetime as period_end.
	from frappe.utils import now_datetime
	period_end_date = now_datetime()

	pos_profile = opening_doc.pos_profile
	user = opening_doc.user

	# Imported from ERPNext's POS closing helper module.
	from erpnext.accounts.doctype.pos_closing_entry.pos_closing_entry import get_pos_invoices
	pos_invoices = get_pos_invoices(period_start_date, period_end_date, pos_profile, user)


	# Compute sold quantities from returned invoices.
	sold_rows = frappe.db.sql(
		"""
		SELECT
			item.item_code,
			item.warehouse,
			SUM(item.stock_qty) AS sold_qty
		FROM `tabPOS Invoice Item` item
		WHERE item.parent IN %(invoice_names)s
			AND item.docstatus = 1
			AND IFNULL(item.warehouse, '') != ''
		GROUP BY item.item_code, item.warehouse
		HAVING sold_qty > 0
		""",
		{"invoice_names": tuple([inv.name if hasattr(inv, "name") else inv for inv in pos_invoices] )},
		as_dict=1,
	)


	required_stock = {}
	bundle_cache = {}

	for row in sold_rows:
		item_code = row.item_code
		warehouse = row.warehouse
		sold_qty = flt(row.sold_qty)

		if is_active_product_bundle(item_code):
			components = bundle_cache.setdefault(item_code, get_bundle_components(item_code))
			for component in components:
				key = (component["item_code"], warehouse)
				required_stock[key] = required_stock.get(key, 0) + (flt(component["qty"]) * sold_qty)
		else:
			key = (item_code, warehouse)
			required_stock[key] = required_stock.get(key, 0) + sold_qty

	for (item_code, warehouse), required_qty in required_stock.items():
		actual_qty = flt(frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse}, "actual_qty"))

		if actual_qty < required_qty:
			frappe.throw(
				_("{0} needs {1} units in warehouse {2}, but only {3} are available for POS closing.").format(
					frappe.bold(item_code),
					frappe.bold(required_qty),
					frappe.bold(warehouse),
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
		{
			"pos_profile": profile.name,
			"user": frappe.session.user,
			"status": "Open",
			"docstatus": 1,
		},
		"name",
	)

	payment_methods = [p.mode_of_payment for p in profile.payments]

	opening_doc = frappe.get_doc("POS Opening Entry", opening_entry) if opening_entry else None
	opening_time = None
	cashier = None
	if opening_doc:
		# Use POS Opening Entry's own timestamp fields.
		cashier = opening_doc.user
		opening_time = opening_doc.get("period_start_date") or opening_doc.get("posting_date") or opening_doc.get("created_on")

	return {
		"opening_entry": opening_entry,
		"pos_profile": profile.name,
		"company": profile.company,
		"customer": profile.customer,
		"payment_methods": payment_methods,
		"warehouse": profile.warehouse,
		"cashier": cashier,
		"opening_time": opening_time,
	}



@frappe.whitelist()
def create_opening_entry(pos_profile, amounts=None):
	"""Creates and submits a new POS Opening Entry.

	amounts: dict of mode_of_payment -> opening_amount. Missing modes default to 0.
	"""
	doc = frappe.new_doc("POS Opening Entry")

	doc.pos_profile = pos_profile
	doc.user = frappe.session.user
	doc.company = frappe.db.get_value("POS Profile", pos_profile, "company")
	doc.period_start_date = now_datetime()

	profile_doc = frappe.get_doc("POS Profile", pos_profile)
	# Create one balance detail row per configured payment method.
	if profile_doc.payments:
		if isinstance(amounts, str):
			amounts = json.loads(amounts or "{}")
		amounts = amounts or {}
		for row in profile_doc.payments:
			doc.append(
				"balance_details",
				{
					"mode_of_payment": row.mode_of_payment,
					"opening_amount": flt(amounts.get(row.mode_of_payment, 0.0)),
				},
			)



	doc.insert()
	doc.submit()
	doc.status = "Open"
	doc.save()
	return doc.name


# --- CORE TRANSACTION LOGIC ---


@frappe.whitelist()
def get_products(search_term=None, item_group=None, limit_page_length=20, in_stock_only=True):
	"""Fetches saleable POS items, including product bundles with computed availability."""
	if isinstance(in_stock_only, str):
		in_stock_only = in_stock_only.strip().lower() in {"1", "true", "yes", "y", "on"}

	profile = get_assigned_pos_profile()
	search_term = (search_term or "").strip()
	item_group = (item_group or "").strip()
	limit_page_length = int(limit_page_length or 20)
	rows = get_catalog_rows(
		profile,
		search_term=search_term or None,
		item_group=item_group or None,
		limit_page_length=limit_page_length,
		in_stock_only=in_stock_only,
	)
	if not rows:
		return []

	item_codes = {row["item_code"] for row in rows}
	bundle_names = get_active_bundle_names(item_codes)
	bundle_components = get_bundle_component_map(bundle_names)
	component_item_codes = {
		component["item_code"]
		for components in bundle_components.values()
		for component in components
	}
	stock_qty_map = get_stock_qty_map(item_codes | component_item_codes, profile.warehouse)
	bundle_components = get_bundle_component_map(bundle_names, stock_qty_map=stock_qty_map)

	products = []
	for row in rows:
		product = dict(row)
		components = bundle_components.get(product["item_code"], [])
		product["bundle_components"] = components
		product["is_product_bundle"] = 1 if components else 0
		product["actual_qty"] = (
			get_bundle_available_qty(components)
			if product["is_product_bundle"]
			else flt(stock_qty_map.get(product["item_code"], 0))
		)
		products.append(product)

	return products


@frappe.whitelist()
def get_item_by_barcode(barcode):
	"""Searches for an item with its current stock level and group."""
	item_code = frappe.db.get_value("Item Barcode", {"barcode": barcode}, "parent")

	if not item_code:
		if frappe.db.exists("Item", barcode):
			item_code = barcode

	if item_code:
		profile = get_assigned_pos_profile()
		item_data = get_catalog_rows(profile, item_code=item_code, in_stock_only=False)
		if not item_data:
			return None

		item = enrich_pos_item(item_data[0], profile.warehouse)
		return item
	return None


@frappe.whitelist()
def search_item(query):
	"""Find the first POS item by exact code or partial name/code match."""
	query = (query or "").strip()
	if not query:
		return None

	profile = get_assigned_pos_profile()
	items = get_catalog_rows(profile, search_term=query, in_stock_only=False)
	for row in items:
		return enrich_pos_item(row, profile.warehouse)
	return None


def parse_cart_data(cart_data):
	if isinstance(cart_data, str):
		return json.loads(cart_data or "[]")
	return cart_data or []


@frappe.whitelist()
def hold_sale(cart, customer=None, grand_total=0, remarks=None, held_sale_name=None):
	"""Save or update a suspended cart without creating stock or accounting entries."""
	profile = get_assigned_pos_profile()
	items = parse_cart_data(cart)
	if not items:
		frappe.throw(_("Cannot hold an empty cart."))

	if held_sale_name:
		doc = frappe.get_doc("Mart POS Held Sale", held_sale_name)
		if doc.status != "Held":
			frappe.throw(_("Held Sale {0} is no longer available.").format(held_sale_name))
		if doc.cashier != frappe.session.user:
			frappe.throw(_("You can only update your own held sales."))
		if doc.company != profile.company or doc.warehouse != profile.warehouse:
			frappe.throw(_("Held Sale {0} does not belong to this POS profile.").format(held_sale_name))
	else:
		doc = frappe.new_doc("Mart POS Held Sale")
		doc.company = profile.company
		doc.warehouse = profile.warehouse
		doc.cashier = frappe.session.user
		doc.status = "Held"
		doc.created_on = now_datetime()

	doc.customer = customer or profile.customer or "Guest"
	doc.grand_total = flt(grand_total)
	doc.cart_data = json.dumps(items)
	doc.remarks = remarks
	doc.flags.ignore_permissions = True
	if doc.is_new():
		doc.insert()
	else:
		doc.save()
	return doc.name


@frappe.whitelist()
def get_held_sales():
    """Return active held sales for the current cashier and POS profile."""
    profile = get_assigned_pos_profile()

    sales = frappe.get_all(
        "Mart POS Held Sale",
        filters={
            "status": "Held",
            "cashier": frappe.session.user,
            "company": profile.company,
            "warehouse": profile.warehouse,
        },
        fields=[
            "name",
            "customer",
            "grand_total",
            "created_on",
            "remarks",
            "cart_data",
        ],
        order_by="created_on desc",
        limit=50,
    )

    for sale in sales:
        try:
            cart = json.loads(sale.get("cart_data") or "[]")
            sale["item_count"] = sum(
                float(item.get("qty", 0)) for item in cart
            )
        except Exception:
            sale["item_count"] = 0

        sale.pop("cart_data", None)

    return sales


@frappe.whitelist()
def get_held_sale(name):
	"""Load one held sale and return its cart payload for restoration."""
	doc = frappe.get_doc("Mart POS Held Sale", name)
	if doc.status != "Held":
		frappe.throw(_("Held Sale {0} is no longer available.").format(name))
	if doc.cashier != frappe.session.user:
		frappe.throw(_("You can only restore your own held sales."))

	return {
		"name": doc.name,
		"customer": doc.customer,
		"grand_total": doc.grand_total,
		"cart": parse_cart_data(doc.cart_data),
		"remarks": doc.remarks,
	}


def mark_held_sale_completed(held_sale_name, invoice_name=None):
	if not held_sale_name:
		return

	doc = frappe.get_doc("Mart POS Held Sale", held_sale_name)
	if doc.status != "Held":
		return

	if doc.cashier != frappe.session.user:
		frappe.throw(_("You can only complete your own held sales."))

	doc.status = "Completed"
	if invoice_name:
		doc.completed_invoice = invoice_name
	doc.flags.ignore_permissions = True
	doc.save()


@frappe.whitelist()
def complete_held_sale(held_sale_name, invoice_name=None):
	mark_held_sale_completed(held_sale_name, invoice_name)
	return held_sale_name


@frappe.whitelist()
def add_item_price_history(item_code, uom=None, price=0, price_list=None):
	"""Append a new selling Item Price row for POS manual pricing and return refreshed UOM prices."""
	if not item_code:
		frappe.throw(_("Item Code is required."))

	price = flt(price)
	if price < 0:
		frappe.throw(_("Price cannot be negative."))

	profile = get_assigned_pos_profile()
	item = frappe.get_doc("Item", item_code)
	uom = uom or item.stock_uom
	price_list = price_list or profile.selling_price_list or frappe.db.get_single_value("Selling Settings", "selling_price_list")
	pricing_date = get_current_pricing_date()

	current_price_name = frappe.db.sql(
		"""
		SELECT ip.name
		FROM `tabItem Price` ip
		WHERE ip.item_code = %s
			AND ip.price_list = %s
			AND IFNULL(ip.uom, '') = %s
			AND (ip.valid_from IS NULL OR ip.valid_from <= %s)
			AND (ip.valid_upto IS NULL OR ip.valid_upto >= %s)
		ORDER BY
			COALESCE(ip.valid_from, '1900-01-01') DESC,
			COALESCE(ip.creation, '1900-01-01 00:00:00') DESC,
			ip.name DESC
		LIMIT 1
		""",
		(item_code, price_list, uom or "", pricing_date, pricing_date),
	)

	if current_price_name:
		frappe.db.set_value("Item Price", current_price_name[0][0], "valid_upto", pricing_date, update_modified=False)

	item_price = frappe.new_doc("Item Price")
	item_price.item_code = item_code
	item_price.uom = uom
	item_price.price_list = price_list
	item_price.price_list_rate = price
	item_price.valid_from = pricing_date
	item_price.flags.ignore_permissions = True
	item_price.insert()

	return {
		"item_code": item_code,
		"uom": uom,
		"price": price,
		"price_list": price_list,
		"valid_from": pricing_date,
		"uoms": get_item_uoms_and_prices(item_code, price_list=price_list),
	}


def get_utang_credit_details(customer, company, amount=0):
	if not customer or customer == "Guest" or not frappe.db.exists("Customer", customer):
		frappe.throw(_("Utang is only available for registered customers."))

	credit_limit = flt(get_credit_limit(customer, company))
	current_outstanding = flt(
		get_customer_outstanding(customer, company, ignore_outstanding_sales_order=True)
	)
	projected_outstanding = current_outstanding + flt(amount)

	return {
		"customer": customer,
		"company": company,
		"credit_limit": credit_limit,
		"current_outstanding": current_outstanding,
		"projected_outstanding": projected_outstanding,
		"available_credit": credit_limit - current_outstanding,
		"allowed": credit_limit > 0 and projected_outstanding <= credit_limit,
	}


@frappe.whitelist()
def get_utang_credit_status(customer, amount=0):
	profile = get_assigned_pos_profile()
	return get_utang_credit_details(customer, profile.company, amount)


def validate_utang_credit(customer, company, amount):
	details = get_utang_credit_details(customer, company, amount)
	if not details["allowed"]:
		frappe.throw(
			_(
				"Credit limit exceeded. Current outstanding: {0}, Sale amount: {1}, Credit limit: {2}."
			).format(
				frappe.bold(details["current_outstanding"]),
				frappe.bold(flt(amount)),
				frappe.bold(details["credit_limit"]),
			),
			title=_("Utang Not Allowed"),
		)
	return details


def reconcile_pos_invoice_payments(invoice, mode_of_payment, received_amount):
	"""Mirror ERPNext POS' payment totals before server-side submit."""
	received_amount = flt(received_amount)
	selected_payment_found = mode_of_payment == "Utang"

	for payment in invoice.get("payments") or []:
		if payment.mode_of_payment == mode_of_payment:
			payment.amount = received_amount
			selected_payment_found = True
		else:
			payment.amount = 0

	if not selected_payment_found:
		frappe.throw(
			_("Mode of Payment {0} is not configured in POS Profile {1}.").format(
				frappe.bold(mode_of_payment), frappe.bold(invoice.pos_profile)
			)
		)

	invoice.set_paid_amount()

	rounded_total = getattr(invoice, "rounded_total", None)
	raw_grand_total = getattr(invoice, "grand_total", None)
	base_rounded_total = getattr(invoice, "base_rounded_total", None)
	raw_base_grand_total = getattr(invoice, "base_grand_total", None)
	paid_amount = flt(getattr(invoice, "paid_amount", 0))
	base_paid_amount = flt(getattr(invoice, "base_paid_amount", 0))
	total_advance = flt(getattr(invoice, "total_advance", 0))
	write_off_amount = flt(getattr(invoice, "write_off_amount", 0))
	base_write_off_amount = flt(getattr(invoice, "base_write_off_amount", 0))
	conversion_rate = flt(getattr(invoice, "conversion_rate", 0))
	change_amount = flt(getattr(invoice, "change_amount", 0))
	grand_total = flt(rounded_total or raw_grand_total)
	base_grand_total = flt(base_rounded_total or raw_base_grand_total)

	frappe.logger("minimart_pos").debug(
		"POS invoice payment reconciliation values: "
		f"rounded_total={repr(rounded_total)}, "
		f"grand_total={repr(raw_grand_total)}, "
		f"base_rounded_total={repr(base_rounded_total)}, "
		f"base_grand_total={repr(raw_base_grand_total)}, "
		f"paid_amount={repr(getattr(invoice, 'paid_amount', None))}, "
		f"base_paid_amount={repr(getattr(invoice, 'base_paid_amount', None))}, "
		f"total_advance={repr(getattr(invoice, 'total_advance', None))}, "
		f"write_off_amount={repr(getattr(invoice, 'write_off_amount', None))}, "
		f"base_write_off_amount={repr(getattr(invoice, 'base_write_off_amount', None))}, "
		f"conversion_rate={repr(getattr(invoice, 'conversion_rate', None))}, "
		f"change_amount={repr(getattr(invoice, 'change_amount', None))}"
	)

	has_cash_payment = any(payment.type == "Cash" for payment in invoice.get("payments") or [])

	invoice.change_amount = 0
	invoice.base_change_amount = 0
	if paid_amount > grand_total and not invoice.is_return and has_cash_payment:
		invoice.change_amount = flt(
			paid_amount - grand_total, invoice.precision("change_amount")
		)
		invoice.base_change_amount = flt(
			base_paid_amount - base_grand_total, invoice.precision("base_change_amount")
		)
		change_amount = flt(invoice.change_amount)

	if invoice.party_account_currency == invoice.currency:
		total_amount_to_pay = flt(
			grand_total
			- total_advance
			- write_off_amount,
			invoice.precision("grand_total"),
		)
	else:
		total_amount_to_pay = flt(
			base_grand_total
			- total_advance
			- base_write_off_amount,
			invoice.precision("base_grand_total"),
		)
		paid_amount = base_paid_amount

	invoice.outstanding_amount = flt(
		total_amount_to_pay - paid_amount + flt(change_amount * conversion_rate),
		invoice.precision("outstanding_amount"),
	)


def set_normal_pos_sale_item_fields(item, warehouse):
	"""Keep Mart POS item rows aligned with native normal POS sales."""
	item.warehouse = warehouse
	item.delivered_by_supplier = 0
	item.target_warehouse = None
	item.sales_order = None
	item.so_detail = None
	item.delivery_note = None
	item.dn_detail = None
	if item.meta.has_field("against_sales_order"):
		item.against_sales_order = None


@frappe.whitelist()
def create_invoice(
	cart,
	customer=None,
	mode_of_payment="Cash",
	amount_paid=0,
	total_payable=None,
	held_sale_name=None,
	payment_due_date=None,
):
	"""Create an ERPNext POS Invoice using ERPNext's POS payment structure.

	Important: we must NOT manually create `payments` child rows.
	ERPNext initializes `payments` from the POS Profile via POSInvoice.set_pos_fields()
	(through update_multi_mode_option). Mart must then only set the `amount` on
	the appropriate existing payment row.
	"""
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

	# Link the invoice to the currently open POS Opening Entry for this user + POS Profile.
	opening_entry_doc = frappe.get_all(
		"POS Opening Entry",
		filters={
			"pos_profile": profile.name,
			"user": frappe.session.user,
			"status": "Open",
			"docstatus": 1,
		},
		fields=["name"],
		order_by="creation asc",
		limit=1,
	)
	if not opening_entry_doc:
		frappe.throw(_("Please open a POS shift first."))
	invoice.pos_opening_entry = opening_entry_doc[0].name


	invoice.customer = selected_customer
	invoice.company = profile.company
	invoice.update_stock = 0
	invoice.set_posting_time = 1
	invoice.posting_date = now_datetime().date()
	invoice.due_date = invoice.posting_date
	invoice.set_warehouse = profile.warehouse

	invoice.flags.ignore_permissions = True

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
				"target_warehouse": None,
				"delivered_by_supplier": 0,
				"sales_order": None,
				"so_detail": None,
				"delivery_note": None,
				"dn_detail": None,
				"price_list_rate": item_price,
				"allow_negative_stock": 1,
			},
		)

	invoice.is_pos = 1

	invoice.set_missing_values()
	for item in invoice.get("items") or []:
		set_normal_pos_sale_item_fields(item, profile.warehouse)

	invoice.calculate_taxes_and_totals()


	if total_payable is not None:
		total_payable = flt(total_payable)
		if total_payable and flt(invoice.grand_total) != total_payable:
			invoice.apply_discount_on = "Grand Total"
			invoice.discount_amount = flt(invoice.grand_total - total_payable)
			invoice.calculate_taxes_and_totals()

	total_to_pay = flt(invoice.grand_total)
	received = flt(amount_paid)
	if received < 0:
		frappe.throw(_("Amount paid cannot be negative."))

	is_utang = mode_of_payment == "Utang"
	if is_utang:
		validate_utang_credit(selected_customer, profile.company, total_to_pay)
		received = 0

	has_deferred_payment = received < total_to_pay

	if has_deferred_payment:
		if not payment_due_date:
			frappe.throw(_("Payment Due Date is required when the invoice has an outstanding balance."))

		invoice.due_date = getdate(payment_due_date)
		if invoice.due_date < invoice.posting_date:
			frappe.throw(_("Payment Due Date cannot be before the invoice posting date."))

	# ERPNext POS Invoice will set payment rows (per POS Profile) and
	# expects to update them based on `amount` for the selected Mode of Payment.
	# Mart must NOT manually set payment row structure; only set the relevant
	# row's amount (Cash/GCash/etc), leaving other rows at 0.

	invoice.is_pos = 1
	invoice.account_for_change_amount = profile.account_for_change_amount
	reconcile_pos_invoice_payments(invoice, mode_of_payment, received)

	invoice.insert()

	reconcile_pos_invoice_payments(invoice, mode_of_payment, received)

	invoice.submit()

	mark_held_sale_completed(held_sale_name, invoice.name)

	frappe.db.commit()
	return invoice.name


# --- VOID / CANCEL LOGIC ---


@frappe.whitelist()
def void_invoice(invoice_name):
	"""Submitted invoices cannot be voided from Mart POS."""
	frappe.throw(
		_("Checkout has already happened for Sales Invoice {0}. Use Return Sale instead.").format(
			frappe.bold(invoice_name)
		),
		title=_("Void Not Allowed"),
	)


# --- RECENT ORDERS & CLOSING ---


@frappe.whitelist()
def delete_held_sales(names):
	"""Delete held sales by name, enforcing ownership to the current POS profile + cashier."""
	if not names:
		return {"deleted": 0}

	# Accept either JSON string or list
	if isinstance(names, str):
		try:
			names = json.loads(names)
		except Exception:
			names = [names]




	if not isinstance(names, (list, tuple)):

		names = [names]

	profile = get_assigned_pos_profile()
	cashier = frappe.session.user

	# Only delete sales that are still Held and owned by current cashier + POS profile
	allowed = frappe.get_all(
		"Mart POS Held Sale",
		filters={
			"name": ["in", list(names)],
			"status": "Held",
			"cashier": cashier,
			"company": profile.company,
			"warehouse": profile.warehouse,
		},
		pluck="name",
	)

	allowed = list(set(allowed))
	if allowed:
		# Delete only the allowed/owned names
		for name in allowed:
			frappe.delete_doc("Mart POS Held Sale", name, ignore_permissions=True)




	deleted_count = len(allowed)
	frappe.db.commit()
	return {"deleted": deleted_count, "requested": len(names), "allowed": deleted_count}




@frappe.whitelist()
def delete_all_held_sales():
	"""Delete all held sales owned by the current POS profile + current cashier."""
	profile = get_assigned_pos_profile()
	cashier = frappe.session.user


	rows = frappe.get_all(
		"Mart POS Held Sale",
		filters={
			"status": "Held",
			"cashier": cashier,
			"company": profile.company,
			"warehouse": profile.warehouse,
		},
		pluck="name",
	)

	rows = list(set(rows or []))
	if rows:
		for name in rows:
			frappe.delete_doc("Mart POS Held Sale", name)

	frappe.db.commit()
	return {"deleted": len(rows)}






@frappe.whitelist()
def get_recent_invoices(opening_entry):

	return frappe.db.get_list(
		"Sales Invoice",
		filters={"owner": frappe.session.user, "docstatus": 1},
		fields=[
			"name",
			"customer",
			"grand_total",
			"outstanding_amount",
			"creation",
			"status",
			"is_return",
			"return_against",
		],
		order_by="creation desc",
		limit=20,
	)



@frappe.whitelist()
def close_pos_shift(opening_entry):
	"""Create and submit a POS Closing Entry for an open shift."""
	opening_doc = frappe.get_doc("POS Opening Entry", opening_entry)
	if opening_doc.status != "Open":
		frappe.throw(_("Shift is already closed."))

	# Use ERPNext POS closing helper to select POS invoices for this shift.
	# No custom POS Invoice filtering by (non-existent) custom linkage fields.
	validate_shift_stock(opening_entry)


	# ERPNext helper builds the closing entry based on the opening shift,
	# and internally links POS invoices to this opening (no custom POS invoice fields here).
	closing_doc = make_closing_entry_from_opening(opening_doc)

	closing_doc.period_end_date = now_datetime()

	# Initialize payment reconciliation rows so Closing Amount defaults to Expected Amount,
	# matching ERPNext's standard POS closing entry draft behavior.
	# (The user will still review/edit before submitting.)
	if getattr(closing_doc, "payment_reconciliation", None):
		for row in closing_doc.payment_reconciliation:
			if row.expected_amount is not None:
				row.closing_amount = row.expected_amount

	closing_doc.insert()
	# Do NOT manually close the POS Opening Entry here.
	# ERPNext will automatically close the opening entry during POS Closing Entry submission.
	return closing_doc.name
