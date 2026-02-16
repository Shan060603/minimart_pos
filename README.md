# 🛒 MiniMart POS for Frappe/ERPNext

A lightweight, responsive, and barcode-ready Point of Sale (POS) system built as a custom page for Frappe. Designed for speed, it handles the full retail cycle from scanning to shift reconciliation.



## 🚀 Quick Features
* **Adaptive UI**: Automatically switches layout for Mobile, Tablet, and Desktop.
* **Fast Scanning**: Optimized for USB/Bluetooth barcode scanners with auto-focus.
* **Shift Logic**: Integrated with `POS Opening Entry` and `POS Closing Entry`.
* **Financial Accuracy**: Correctly handles "Amount Paid" vs "Change" to ensure your ledgers balance.

---

## 🛠️ Installation

Run these commands in your `frappe-bench` directory:

```bash
# 1. Download the app
bench get-app https://github.com/Shan060603/minimart_pos.git

# 2. Install it on your site
bench --site [your-site-name] install-app minimart_pos

# 3. Build assets and restart
bench build --app minimart_pos
bench restart