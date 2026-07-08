# minimart_pos - Phase 5 TODO

- [ ] Implement restore checkout → create standard ERPNext **POS Invoice** (minimart_pos/api.py)
- [ ] Update backend to support POS Opening Entry with per-mode opening amounts (minimart_pos/api.py)
- [ ] Update opening shift dialog to list all POS Profile payment modes and block selling until opened (martpos_page.js)
- [ ] Add UI display while shift is open (Shift Open, Cashier, Opening Time)
- [ ] Add Close Shift button beside Hold Sale / Held Sales and implement closing dialog that captures Actual per mode and submits POS Closing Entry (martpos_page.js + api.py)
- [ ] Disable selling after closing (next load requires new opening)
- [ ] Validation: run `python3 -m py_compile minimart_pos/api.py` and `node --check minimart_pos/minimart_pos/page/martpos_page/martpos_page.js`
- [ ] Verification summary: list ERPNext APIs reused and confirm forbidden areas untouched
