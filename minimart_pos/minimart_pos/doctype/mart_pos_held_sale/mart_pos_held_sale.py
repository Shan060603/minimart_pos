import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


class MartPOSHeldSale(Document):
	def before_insert(self):
		if not self.created_on:
			self.created_on = now_datetime()
		if not self.cashier:
			self.cashier = frappe.session.user
		if not self.status:
			self.status = "Held"
