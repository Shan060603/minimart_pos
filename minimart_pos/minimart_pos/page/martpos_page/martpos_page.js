frappe.pages["martpos_page"].on_page_load = function (wrapper) {
	let page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "Mart POS",
		single_column: true,
	});

	// Initial Shift Check
	frappe.call({
		method: "minimart_pos.api.check_pos_opening",
		callback: function (r) {
			if (!r.message.opening_entry) {
				show_opening_dialog(r.message.pos_profile);
			} else {
				render_pos_ui(page, r.message);
			}
		},
	});
};

function show_opening_dialog(profile) {
	let d = new frappe.ui.Dialog({
		title: __("Open POS Shift"),
		fields: [
			{
				label: __("Opening Amount"),
				fieldname: "amount",
				fieldtype: "Currency",
				default: 0,
			},
		],
		primary_action_label: __("Start Shift"),
		primary_action(values) {
			frappe.call({
				method: "minimart_pos.api.create_opening_entry",
				args: { pos_profile: profile, amount: values.amount },
				callback: (r) => {
					d.hide();
					location.reload();
				},
			});
		},
	});
	d.show();
}

function render_pos_ui(page, shift_data) {
	$(frappe.render_template("martpos_page", {})).appendTo(page.main);
	window.pos_instance = new MiniMartPOS(page, shift_data);
	window.pos_instance.init();

	page.set_primary_action(__("Open Drawer"), () => window.pos_instance.trigger_cash_drawer());
	page.add_inner_button(__("Hold Sale"), () => window.pos_instance.hold_sale());
	page.add_inner_button(__("Held Sales"), () => window.pos_instance.show_held_sales());
	page.add_menu_item(__("Close Shift"), () => window.pos_instance.close_shift());
}

class MiniMartPOS {
	constructor(page, shift_data) {
		this.page = page;
		this.shift_data = shift_data;
		this.cart = [];
		this.customer_control = null;
		this.serialPort = null;
		this.active_held_sale_name = null;
		// keep track of the currently open payment dialog wrapper
		this.$payment_wrapper = null;

		// Modal State
		this.current_payment_total = 0;
		this.current_utang_allowed = false;

		// Selectors
		this.$scan_input = $("#barcode-scan");
		this.$group_filter = $("#item-group-filter");
		this.$cart_container = $("#cart-table");
		this.$total_display = $("#grand-total");
		this.$product_grid = $("#product-grid");
		this.$recent_orders_list = $("#recent-orders-list");
		this.$clear_cart_btn = $("#clear-cart-btn");
		this.product_result_limit = 20;
		this.product_search_timer = null;
	}

	init() {
		this.setup_customer_control();
		this.bind_events();
		this.load_item_groups();
		this.load_products("", true);
		this.load_recent_orders();
		this.focus_input();
	}

	setup_customer_control() {
		let me = this;
		let cust_container = $("#customer-search-container");
		if (cust_container.length) {
			cust_container.empty();
			let $wrapper = $(`<div class="d-flex gap-2 align-items-center">
                <div id="customer-link-field" style="flex:1;"></div>
                <button class="btn btn-sm btn-outline-secondary" id="set-guest-btn" style="height:38px;">Guest</button>
            </div>`).appendTo(cust_container);

			this.customer_control = frappe.ui.form.make_control({
				df: {
					fieldtype: "Link",
					options: "Customer",
					placeholder: "Search Customer...",
					onchange: () => me.focus_input(),
				},
				parent: $wrapper.find("#customer-link-field"),
				render_input: true,
			});

			this.customer_control.set_value(this.shift_data.customer || "Guest");

			$wrapper.find("#set-guest-btn").on("click", () => {
				me.customer_control.set_value("Guest");
				me.focus_input();
			});
		}
	}

	focus_input() {
		setTimeout(() => {
			if (this.$scan_input.length) this.$scan_input.focus();
		}, 200);
	}

	bind_events() {
		const handleBarcodeScan = (e) => {
			if (e.key === "Enter" || e.which == 13) {
				let code = this.$scan_input.val().trim();
				if (code) this.fetch_item(code);
				this.$scan_input.val("");
				this.load_products();
				e.preventDefault();
			}
		};

		this.$scan_input.on("keypress", handleBarcodeScan);
		this.$scan_input.on("keydown", handleBarcodeScan);

		this.$scan_input.on("input", () => this.schedule_product_refresh());
		this.$group_filter.on("change", () => {
			let search_term = this.$scan_input.val().trim();
			this.load_products(search_term, !search_term);
			this.focus_input();
		});

		$(document).on("click", (e) => {
			if (
				!$(e.target).closest(
					"#barcode-scan, #item-group-filter, #customer-search-container, .awesomplete, .modal-dialog, .cart-qty-input, .cart-uom-select, .price-btn, .discount-btn, .btn-qty, .btn-remove, .num-btn, .quick-btn",
				).length
			) {
				this.focus_input();
			}
		});

		$(document).on("click", "#checkout-btn", () => this.process_payment());

		this.$clear_cart_btn.on("click", () => this.clear_cart());
	}

	async trigger_cash_drawer() {
		try {
			if (!("serial" in navigator)) return;
			if (!this.serialPort)
				this.serialPort = await navigator.serial.requestPort({ filters: [] });
			if (!this.serialPort.writable) await this.serialPort.open({ baudRate: 9600 });
			const writer = this.serialPort.writable.getWriter();
			const open_cmd = new Uint8Array([27, 112, 0, 25, 250]);
			await writer.write(open_cmd);
			writer.releaseLock();
		} catch (err) {
			console.error("Hardware Error:", err);
			this.serialPort = null;
		}
	}

	load_item_groups() {
		frappe.call({
			method: "frappe.client.get_list",
			args: {
				doctype: "Item Group",
				filters: { is_group: 0 },
				fields: ["name"],
				limit_page_length: 100,
			},
			callback: (r) => {
				if (r.message) {
					let options = r.message.map(
						(g) => `<option value="${g.name}">${g.name}</option>`,
					);
					this.$group_filter.append(options.join(""));
				}
			},
		});
	}

	schedule_product_refresh() {
		clearTimeout(this.product_search_timer);
		this.product_search_timer = setTimeout(() => {
			let search_term = this.$scan_input.val().trim();
			this.load_products(search_term, !search_term);
		}, 180);
	}

	load_products(search_term = "", in_stock_only = true) {
		let item_group = this.$group_filter.val();
		let normalized_search_term = (search_term || "").trim();
		let normalized_in_stock_only =
			in_stock_only !== null && in_stock_only !== undefined
				? in_stock_only
				: !normalized_search_term;
		frappe.call({
			method: "minimart_pos.api.get_products",
			args: {
				search_term: normalized_search_term,
				item_group: item_group,
				limit_page_length: this.product_result_limit,
				in_stock_only: normalized_in_stock_only,
			},
			callback: (r) => {
				if (r.message) this.render_products(r.message);
			},
		});
	}

	render_products(products) {
		if (!products.length) {
			this.$product_grid.html(
				`<div class="pos-loading-state">${__("No products found")}</div>`,
			);
			return;
		}

		let html = products
			.map((item) => {
				const itemJSON = JSON.stringify(item).replace(/"/g, "&quot;");
				const bundleComponents = encodeURIComponent(
					JSON.stringify(item.bundle_components || []),
				);
				const bundleLabel = item.is_product_bundle
					? `<span class="bundle-badge">${__("Bundle")}</span>`
					: "";
				let conversion = flt(item.conversion_factor) || 1;
				let display_qty = conversion
					? flt(item.actual_qty) / conversion
					: flt(item.actual_qty);
				let badge_class =
					display_qty <= 0
						? "bg-danger"
						: display_qty <= 5
							? "bg-warning"
							: "bg-success";
				return `
                <div class="product-card"
                      data-item-code="${item.item_code.toLowerCase()}"
                      data-item-uom="${(item.uom || "").toLowerCase()}"
                      data-item-name="${item.item_name.toLowerCase()}"
                      data-item-group="${item.item_group || ""}"
                      data-base-actual-qty="${item.actual_qty}"
                      data-actual-qty="${display_qty}"
                      data-display-conversion="${conversion}"
                      data-bundle-components="${bundleComponents}"
                      onclick="pos_instance.add_to_cart(${itemJSON})">
                    ${bundleLabel}
                    <span class="stock-badge ${badge_class}">${this.format_stock_qty(display_qty, conversion)}</span>
                    <div class="product-image">
                        ${item.image ? `<img src="${item.image}">` : `<div class="img-placeholder">${item.item_name[0]}</div>`}
                    </div>
                    <div class="product-name">${item.item_name}</div>
                    <div class="product-uom">${item.uom || ""}</div>
                    <div class="product-price">₱${flt(item.price).toFixed(2)}</div>
                </div>
            `;
			})
			.join("");
		this.$product_grid.html(html);
	}

	fetch_item(query) {
		frappe.call({
			method: "minimart_pos.api.get_item_by_barcode",
			args: { barcode: query },
			callback: (r) => {
				if (r.message) {
					this.handle_fetched_item(r.message);
				} else {
					this.search_item(query);
				}
			},
		});
	}

	search_item(query) {
		frappe.call({
			method: "minimart_pos.api.search_item",
			args: { query: query },
			callback: (r) => {
				if (r.message) {
					this.handle_fetched_item(r.message);
				} else {
					frappe.show_alert({ message: __("Not found"), indicator: "red" });
					frappe.utils.play_sound("error");
					this.focus_input();
				}
			},
		});
	}

	handle_fetched_item(item) {
		this.add_to_cart(item);
		frappe.utils.play_sound("submit");
		this.focus_input();
	}

	async add_to_cart(item) {
		// UOM/price cache per item_code
		if (!this.uom_cache) this.uom_cache = {};
		if (!this.uom_cache[item.item_code]) {
			// Fetch UOMs/prices from backend
			let uoms = await new Promise((resolve) => {
				frappe.call({
					method: "minimart_pos.api.get_item_uoms_and_prices",
					args: { item_code: item.item_code },
					callback: (r) => resolve(r.message || []),
				});
			});
			this.uom_cache[item.item_code] = uoms;
		}
		let uoms = this.uom_cache[item.item_code];
		let default_uom =
			uoms.find((u) => u.uom === item.uom) || uoms.find((u) => u.is_stock_uom) || uoms[0];

		// Keep discounted lines separate from newly added items, now also by UOM
		let existing = this.cart.find(
			(i) =>
				i.item_code === item.item_code &&
				flt(i.discount_pct || 0) === 0 &&
				i.uom === (default_uom && default_uom.uom),
		);
		if (existing) {
			existing.qty += 1;
		} else {
			this.cart.push({
				item_code: item.item_code,
				item_name: item.item_name,
				price: flt(default_uom.price),
				discount_pct: 0,
				qty: 1,
				uom: default_uom.uom,
				bundle_components: item.bundle_components || [],
				uoms: uoms, // cache UOMs for selector
			});
		}

		this.sync_grid_stock();
		this.render_cart();
	}

	update_item_discount(index, value) {
		let item = this.cart[index];
		let discount_pct = Math.max(0, Math.min(100, flt(value)));
		if (discount_pct > 100) {
			discount_pct = 100;
			frappe.show_alert({ message: __("Discount cannot exceed 100%"), indicator: "orange" });
		}
		item.discount_pct = discount_pct;
		this.render_cart();
	}

	open_item_discount_modal(index) {
		let me = this;
		let item = this.cart[index];
		const basePrice = flt(item.price);
		const updatePreview = (value) => {
			let discount_pct = Math.max(0, Math.min(100, flt(value)));
			let discountedPrice = basePrice * (1 - discount_pct / 100);
			discountedPrice = discountedPrice < 0 ? 0 : discountedPrice;
			let savedAmount = basePrice - discountedPrice;
			d.fields_dict.discount_preview.$wrapper.html(
				`<div class="discount-modal-summary">
                    <div><strong>${__("Original Price")}:</strong> ₱${basePrice.toFixed(2)}</div>
                    <div><strong>${__("Discount")}:</strong> ${discount_pct.toFixed(0)}%</div>
                    <div><strong>${__("Discounted Price")}:</strong> ₱${discountedPrice.toFixed(2)}</div>
                    <div><strong>${__("You Save")}:</strong> ₱${savedAmount.toFixed(2)}</div>
                </div>`,
			);
		};

		let d = new frappe.ui.Dialog({
			title: __("Item Discount"),
			fields: [
				{
					fieldtype: "Float",
					fieldname: "discount_pct",
					label: __("Discount %"),
					default: flt(item.discount_pct || 0),
					description: __("Enter discount percentage for this item"),
					reqd: 1,
				},
				{
					fieldtype: "HTML",
					fieldname: "discount_preview",
					options: "",
				},
			],
			primary_action_label: __("Apply"),
			primary_action(values) {
				let discount_pct = Math.max(0, Math.min(100, flt(values.discount_pct)));
				item.discount_pct = discount_pct;
				me.render_cart();
				d.hide();
			},
		});

		d.on_page_show = () => {
			const $input = d.fields_dict.discount_pct.input
				? d.fields_dict.discount_pct.input
				: d.fields_dict.discount_pct.$input;
			updatePreview($input.val());
			$input.on("input", (e) => updatePreview($(e.target).val()));
		};

		d.show();
	}

	open_item_price_modal(index) {
		let item = this.cart[index];
		if (!item) return;

		let me = this;
		let d = new frappe.ui.Dialog({
			title: __("Set Item Price"),
			fields: [
				{
					fieldtype: "Currency",
					fieldname: "price",
					label: __("Price"),
					default: flt(item.price),
					reqd: 1,
				},
			],
			primary_action_label: __("Save Price"),
			primary_action(values) {
				let price = flt(values.price);
				if (price < 0) {
					frappe.msgprint({
						title: __("Invalid Price"),
						indicator: "red",
						message: __("Price cannot be negative."),
					});
					return;
				}

				frappe.call({
					method: "minimart_pos.api.add_item_price_history",
					args: {
						item_code: item.item_code,
						uom: item.uom,
						price: price,
					},
					freeze: true,
					callback: (r) => {
						if (!r.message) return;

						let updatedUoms = r.message.uoms || [];
						if (!me.uom_cache) me.uom_cache = {};
						me.uom_cache[item.item_code] = updatedUoms;

						item.uoms = updatedUoms;
						item.price = price;

						let currentUomRow = updatedUoms.find((row) => row.uom === item.uom);
						if (currentUomRow) {
							item.price = flt(currentUomRow.price);
						}

						d.hide();
						me.render_cart();
						me.load_products();
						frappe.show_alert({ message: __("Item price saved"), indicator: "green" });
					},
				});
			},
		});

		d.show();
	}

	sync_grid_stock() {
		this.refresh_all_card_stock_displays();
	}

	get_cart_item_stock_units(cart_item) {
		let uom_row = (cart_item.uoms || []).find((u) => u.uom === cart_item.uom);
		let conversion = flt(uom_row && uom_row.conversion_factor) || 1;
		return flt(cart_item.qty) * conversion;
	}

	get_reserved_stock_qty(item_code) {
		return this.cart.reduce((total, cart_item) => {
			let stock_units = this.get_cart_item_stock_units(cart_item);
			if (cart_item.item_code === item_code) {
				total += stock_units;
			}

			(cart_item.bundle_components || []).forEach((component) => {
				if (component.item_code === item_code) {
					total += stock_units * flt(component.qty);
				}
			});

			return total;
		}, 0);
	}

	get_product_cards(item_code) {
		return this.$product_grid.find(
			`.product-card[data-item-code="${item_code.toLowerCase()}"]`,
		);
	}

	get_product_card(item_code, uom = null) {
		let $cards = this.get_product_cards(item_code);
		if (!uom) return $cards.first();
		let $card = $cards.filter(`[data-item-uom="${String(uom).toLowerCase()}"]`).first();
		return $card.length ? $card : $cards.first();
	}

	get_bundle_components_from_card($card) {
		let encoded = $card.attr("data-bundle-components");
		if (!encoded) return [];

		try {
			return JSON.parse(decodeURIComponent(encoded));
		} catch (e) {
			console.error("Failed to parse bundle components", e);
			return [];
		}
	}

	get_base_stock_qty(item_code) {
		let $card = this.get_product_card(item_code);
		return $card.length ? flt($card.attr("data-base-actual-qty")) : 0;
	}

	get_product_name(item_code) {
		let $card = this.get_product_card(item_code);
		return ($card.attr("data-item-name") || item_code).trim();
	}

	get_checkout_stock_issues() {
		let tracked_codes = new Set();

		this.cart.forEach((cart_item) => {
			tracked_codes.add(cart_item.item_code);
			(cart_item.bundle_components || []).forEach((component) =>
				tracked_codes.add(component.item_code),
			);
		});

		return Array.from(tracked_codes).reduce((issues, item_code) => {
			let available_qty = this.get_base_stock_qty(item_code);
			let required_qty = this.get_reserved_stock_qty(item_code);

			if (required_qty > available_qty) {
				issues.push({
					item_code,
					item_name: this.get_product_name(item_code),
					available_qty,
					required_qty,
				});
			}

			return issues;
		}, []);
	}

	get_remaining_bundle_qty(bundle_components) {
		if (!bundle_components.length) return 0;

		let remainingBundles = null;
		bundle_components.forEach((component) => {
			let componentQty = flt(component.qty);
			if (componentQty <= 0) return;

			let componentBaseStock =
				this.get_base_stock_qty(component.item_code) || flt(component.available_qty);
			let componentReserved = this.get_reserved_stock_qty(component.item_code);
			let componentRemaining = Math.max(0, componentBaseStock - componentReserved);
			let bundleRemainingFromComponent = componentRemaining / componentQty;

			if (remainingBundles === null || bundleRemainingFromComponent < remainingBundles) {
				remainingBundles = bundleRemainingFromComponent;
			}
		});

		return Math.max(0, remainingBundles === null ? 0 : remainingBundles);
	}

	refresh_all_card_stock_displays() {
		this.$product_grid.find(".product-card").each((_, card) => {
			let $card = $(card);
			let item_code = $card.attr("data-item-code");
			let display_conversion = flt($card.attr("data-display-conversion")) || 1;
			let display_uom = $card.attr("data-item-uom");
			this.update_card_stock_display(item_code, display_conversion, display_uom);
		});
	}

	update_card_stock_display(item_code, display_conversion = 1, display_uom = null) {
		let $card = this.get_product_card(item_code, display_uom);
		if (!$card.length) return;

		let bundle_components = this.get_bundle_components_from_card($card);
		let remaining_stock = bundle_components.length
			? this.get_remaining_bundle_qty(bundle_components)
			: Math.max(
					0,
					flt($card.attr("data-base-actual-qty")) -
						this.get_reserved_stock_qty(item_code),
				);
		let displayed_stock = display_conversion
			? remaining_stock / display_conversion
			: remaining_stock;

		$card.attr("data-display-conversion", display_conversion);
		$card.attr("data-actual-qty", displayed_stock);
		$card
			.find(".stock-badge")
			.text(this.format_stock_qty(displayed_stock, display_conversion));

		let badge_class =
			displayed_stock <= 0
				? "bg-danger"
				: displayed_stock <= 5
					? "bg-warning"
					: "bg-success";
		$card
			.find(".stock-badge")
			.removeClass("bg-danger bg-warning bg-success")
			.addClass(badge_class);
	}

	format_stock_qty(quantity, conversion = 1) {
		let value = flt(quantity);
		if (conversion <= 1) {
			return String(Math.floor(value));
		}

		if (Number.isInteger(value)) {
			return String(value);
		}

		return value.toFixed(2).replace(/\.?0+$/, "");
	}

	update_qty(index, delta) {
		let item = this.cart[index];
		if (!item) return;

		let next_qty = flt(item.qty) + delta;
		item.qty = next_qty < 1 ? 1 : next_qty;
		this.sync_grid_stock();
		this.render_cart();
	}

	manual_qty_update(index, value) {
		let item = this.cart[index];
		if (!item) return;

		let parsed_qty = flt(value);
		if (!Number.isFinite(parsed_qty) || parsed_qty < 1) {
			parsed_qty = 1;
		}

		item.qty = parsed_qty;
		this.sync_grid_stock();
		this.render_cart();
	}

	render_cart() {
		let html = this.cart
			.map((item, index) => {
				let discount_pct = flt(item.discount_pct || 0);
				let linePrice = flt(item.price) * (1 - discount_pct / 100);
				if (linePrice < 0) linePrice = 0;
				let lineTotal = (item.qty * linePrice).toFixed(2);
				let priceButtonClass =
					flt(item.price) <= 0 ? "price-btn price-btn-zero" : "price-btn";
				let uom_display =
					item.uom || (item.uoms && item.uoms.length ? item.uoms[0].uom : "");
				// UOM selector dropdown
				let uom_selector = "";
				if (item.uoms && item.uoms.length > 1) {
					uom_selector = `<select class="cart-uom-select" data-index="${index}">
                    ${item.uoms.map((u) => `<option value="${u.uom}" ${u.uom === item.uom ? "selected" : ""}>${u.uom}</option>`).join("")}
                </select>`;
				} else if (item.uoms && item.uoms.length === 1) {
					uom_selector = `<span class="cart-uom-label">${item.uoms[0].uom}</span>`;
				}
				return `
            <div class="cart-row">
                <div class="cart-item-line cart-item-line-header">
                    <div class="cart-item-name">${item.item_name}</div>
                    <div class="item-total">
                        <span class="item-total-label">${__("Total")}</span>
                        <span class="item-total-value">₱${lineTotal}</span>
                    </div>
                </div>
                <div class="cart-item-line cart-item-line-meta">
                    <div class="cart-item-meta">
                        <div class="cart-item-meta-item">
                            <span class="meta-label">${__("UOM")}</span>
                            <span class="meta-value">${uom_display}</span>
                        </div>
                        <div class="cart-item-meta-item">
                            <span class="meta-label">${__("Rate")}</span>
                            <span class="meta-value">₱${flt(item.price).toFixed(2)}</span>
                        </div>
                    </div>
                </div>
                <div class="cart-item-line cart-item-line-controls">

    <div class="qty-controls">
        <span class="qty-label">${__("Qty")}</span>

        <button onclick="pos_instance.update_qty(${index}, -1)"
            class="btn-qty">-</button>

        <input
            type="number"
            class="cart-qty-input"
            value="${item.qty}"
            min="1"
            onchange="pos_instance.manual_qty_update(${index}, this.value)">

        <button onclick="pos_instance.update_qty(${index}, 1)"
            class="btn-qty">+</button>
    </div>

    <div class="uom-selector-wrapper">
        ${uom_selector}
    </div>

    <div class="cart-actions">

        <button
            class="${priceButtonClass}"
            onclick="pos_instance.open_item_price_modal(${index})">
            ₱${flt(item.price).toFixed(2)}
        </button>

        <button
            class="discount-btn"
            onclick="pos_instance.open_item_discount_modal(${index})">
            ${flt(item.discount_pct || 0).toFixed(0)}%
        </button>

        <button
            onclick="pos_instance.void_cart_item(${index})"
            class="btn-remove">
            ${__("Remove")}
        </button>

    </div>

</div>
            </div>
        `;
			})
			.join("");
		$("#cart-count").text(`${this.cart.length} Items`);
		this.$cart_container.html(
			this.cart.length
				? html
				: `<div class="empty-cart-msg">${__("No items in cart")}</div>`,
		);
		// Bind UOM change events
		this.$cart_container
			.find(".cart-uom-select")
			.off("change")
			.on("change", (e) => {
				let idx = $(e.target).data("index");
				let new_uom = $(e.target).val();
				this.change_cart_item_uom(idx, new_uom);
			});
		this.update_total();
	}

	change_cart_item_uom(index, new_uom) {
		let item = this.cart[index];
		if (!item || !item.uoms) return;
		let uom_row = item.uoms.find((u) => u.uom === new_uom);
		if (!uom_row) return;
		item.uom = uom_row.uom;
		item.price = flt(uom_row.price);
		let conversion = flt(uom_row.conversion_factor);
		this.update_card_stock_display(item.item_code, conversion, item.uom);
		this.sync_grid_stock();
		// Optionally, reset discount on UOM change
		// item.discount_pct = 0;
		this.render_cart();
	}

	void_cart_item(index) {
		let item = this.cart[index];
		if (!item) return;
		this.cart.splice(index, 1);
		this.sync_grid_stock();
		this.render_cart();
		this.focus_input();
	}

	remove_item(index) {
		this.void_cart_item(index);
	}

	update_total() {
		let total = this.cart.reduce((sum, i) => {
			let discount_pct = flt(i.discount_pct || 0);
			let linePrice = flt(i.price) * (1 - discount_pct / 100);
			if (linePrice < 0) linePrice = 0;
			return sum + i.qty * linePrice;
		}, 0);
		this.$total_display.text(total.toFixed(2));
	}

	clear_cart() {
		if (this.cart.length === 0) return;

		const do_clear = () => {
			this.cart = [];
			this.active_held_sale_name = null;
			if (this.customer_control) {
				this.customer_control.set_value("Guest");
			}
			this.render_cart();
			this.sync_grid_stock();
			this.focus_input();
		};

		if (typeof frappe.confirm === "function") {
			frappe.confirm(__("Are you sure you want to clear the entire cart?"), do_clear);
		} else if (confirm(__("Are you sure you want to clear the entire cart?"))) {
			do_clear();
		}
	}

	hold_sale() {
		if (!this.cart.length) {
			frappe.msgprint({
				title: __("Cart Empty"),
				indicator: "red",
				message: __("Please add items to the cart before holding the sale."),
			});
			return;
		}

		const customer = this.customer_control ? this.customer_control.get_value() : null;
		if (!customer) {
			frappe.msgprint({
				title: __("Missing Customer"),
				indicator: "red",
				message: __("Please select a customer or choose Guest before holding the sale."),
			});
			return;
		}

		let d = new frappe.ui.Dialog({
			title: __("Hold Sale"),
			fields: [
				{
					fieldtype: "Small Text",
					fieldname: "remarks",
					label: __("Remarks"),
				},
			],
			primary_action_label: __("Hold Sale"),
			primary_action: (values) => {
				frappe.call({
					method: "minimart_pos.api.hold_sale",
					args: {
						cart: JSON.stringify(this.cart),
						customer: customer,
						grand_total: flt(this.$total_display.text()),
						remarks: values.remarks,
						held_sale_name: this.active_held_sale_name,
					},
					freeze: true,
					callback: (r) => {
						if (!r.message) return;
						d.hide();
						this.cart = [];
						this.active_held_sale_name = null;
						this.render_cart();
						this.load_products();
						this.focus_input();
						frappe.show_alert({
							message: __("Sale held successfully"),
							indicator: "green",
						});
					},
				});
			},
		});
		d.show();
	}

	show_held_sales() {
		frappe.call({
			method: "minimart_pos.api.get_held_sales",
			callback: (r) => {
				this.render_held_sales_dialog(r.message || []);
			},
		});
	}

	render_held_sales_dialog(held_sales) {
		let d = new frappe.ui.Dialog({
			title: __("Held Sales"),
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "held_sales_html",
					options: this.get_held_sales_html(held_sales),
				},
			],
		});

		d.on_page_show = () => {
			d.$wrapper.find(".held-sale-row").on("click", (e) => {
				let name = $(e.currentTarget).attr("data-name");
				this.restore_held_sale(name, d);
			});
		};

		d.show();
	}

	get_held_sales_html(held_sales) {
		if (!held_sales.length) {
			return `<div class="text-center text-muted p-3">${__("No held sales")}</div>`;
		}

		return `
            <div class="list-group">
                ${held_sales
					.map((sale) => {
						const name = this.escape_html(sale.name);
						const customer = this.escape_html(sale.customer || __("Guest"));
						const remarks = this.escape_html(sale.remarks);
						const created_on = this.escape_html(
							frappe.datetime.str_to_user(sale.created_on),
						);
						return `
                    <button type="button" class="list-group-item list-group-item-action held-sale-row" data-name="${name}">
                        <div class="d-flex justify-content-between align-items-center">
                            <strong>${name}</strong>
                            <span>₱${flt(sale.grand_total).toFixed(2)}</span>
                        </div>
                        <div class="d-flex justify-content-between text-muted small mt-1">
                            <span>${customer}</span>
                            <span>${created_on}</span>
                        </div>
                        ${sale.remarks ? `<div class="text-muted small mt-1">${remarks}</div>` : ""}
                    </button>
                `;
					})
					.join("")}
            </div>
        `;
	}

	escape_html(value) {
		return $("<div>")
			.text(value || "")
			.html();
	}

	restore_held_sale(name, dialog) {
		if (!name) return;
		if (this.cart.length && !confirm(__("Replace the current cart with this held sale?")))
			return;

		frappe.call({
			method: "minimart_pos.api.get_held_sale",
			args: { name: name },
			freeze: true,
			callback: (r) => {
				if (!r.message) return;
				this.cart = r.message.cart || [];
				this.active_held_sale_name = r.message.name;
				if (this.customer_control && r.message.customer) {
					this.customer_control.set_value(r.message.customer);
				}
				this.render_cart();
				this.sync_grid_stock();
				this.focus_input();
				dialog.hide();
				frappe.show_alert({ message: __("Held sale restored"), indicator: "green" });
			},
		});
	}

	load_recent_orders() {
		frappe.call({
			method: "minimart_pos.api.get_recent_invoices",
			args: { opening_entry: this.shift_data.opening_entry },
			callback: (r) => {
				if (r.message) this.render_recent_orders(r.message);
			},
		});
	}

	render_recent_orders(orders) {
		if (!orders.length) {
			this.$recent_orders_list.html(
				'<div class="text-center p-2 text-muted">No transactions</div>',
			);
			return;
		}
		let html = orders
			.map((order) => {
				const invoice_name = this.escape_html(order.name);
				const customer = this.escape_html(order.customer);
				const status = this.escape_html(order.status || "");
				const created_on = this.escape_html(frappe.datetime.str_to_user(order.creation));
				const outstanding = flt(order.outstanding_amount);
				return `
            <button type="button" class="recent-order-item recent-transaction-item" data-invoice="${invoice_name}">
                <div class="d-flex justify-content-between align-items-center">
                    <span class="order-id">#${invoice_name.split("-").pop()}</span>
                    <span class="order-total">₱${flt(order.grand_total).toFixed(2)}</span>
                </div>
                <div class="d-flex justify-content-between align-items-center mt-1">
                    <span class="order-customer text-muted" style="font-size: 10px;">${customer}</span>
                    <span class="text-muted" style="font-size: 10px;">${created_on}</span>
                </div>
                <div class="d-flex justify-content-between align-items-center mt-1">
                    <span class="text-muted" style="font-size: 10px;">
                        ${status}${outstanding > 0 ? ` · ${__("Outstanding")} ₱${outstanding.toFixed(2)}` : ""}
                    </span>
                    <span class="d-flex align-items-center gap-2">
                        ${order.is_return ? `<span class="badge badge-warning">${__("Return")}</span>` : ""}
                        <button type="button" class="btn btn-xs btn-default recent-reprint-btn" data-invoice="${invoice_name}">
                            <i class="fa fa-print"></i> ${__("Reprint")}
                        </button>
                    </span>
                </div>
            </button>
        `;
			})
			.join("");
		this.$recent_orders_list.html(html);
		this.$recent_orders_list
			.find(".recent-transaction-item")
			.off("click")
			.on("click", (e) => {
				this.show_transaction_menu($(e.currentTarget).attr("data-invoice"));
			});
		this.$recent_orders_list
			.find(".recent-reprint-btn")
			.off("click")
			.on("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.reprint_receipt($(e.currentTarget).attr("data-invoice"));
			});
	}

	show_transaction_menu(invoice_name) {
		if (!invoice_name) return;

		let d = new frappe.ui.Dialog({
			title: __("Transaction {0}", [invoice_name]),
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "transaction_actions",
					options: `
                        <div class="transaction-action-list">
                            <button type="button" class="btn btn-default btn-block text-left" data-action="reprint">
                                <i class="fa fa-print mr-2"></i>${__("Reprint Receipt")}
                            </button>
                            <button type="button" class="btn btn-default btn-block text-left" data-action="return">
                                <i class="fa fa-undo mr-2"></i>${__("Return Sale")}
                            </button>
                            <button type="button" class="btn btn-default btn-block text-left" data-action="payment">
                                <i class="fa fa-money mr-2"></i>${__("Receive Payment")}
                            </button>
                            <button type="button" class="btn btn-default btn-block text-left" data-action="view">
                                <i class="fa fa-file-text-o mr-2"></i>${__("View Invoice")}
                            </button>
                        </div>
                    `,
				},
			],
		});

		d.on_page_show = () => {
			d.$wrapper.find('[data-action="reprint"]').on("click", () => {
				d.hide();
				this.reprint_receipt(invoice_name);
			});
			d.$wrapper.find('[data-action="return"]').on("click", () => {
				d.hide();
				this.return_sale(invoice_name);
			});
			d.$wrapper.find('[data-action="payment"]').on("click", () => {
				d.hide();
				this.receive_payment(invoice_name);
			});
			d.$wrapper.find('[data-action="view"]').on("click", () => {
				d.hide();
				this.view_past_order(invoice_name);
			});
		};

		d.show();
	}

	reprint_receipt(invoice_name) {
		if (!invoice_name) return;

		const params = new URLSearchParams({
			doctype: "Sales Invoice",
			name: invoice_name,
			trigger_print: 1,
		});
		window.open(`/printview?${params.toString()}`, "_blank");
	}

	return_sale(invoice_name) {
		if (!invoice_name) return;

		frappe.call({
			method: "erpnext.accounts.doctype.sales_invoice.sales_invoice.make_sales_return",
			args: { source_name: invoice_name },
			freeze: true,
			callback: (r) => {
				if (!r.message) return;
				frappe.model.sync(r.message);
				frappe.set_route("Form", r.message.doctype, r.message.name);
			},
		});
	}

	receive_payment(invoice_name) {
		if (!invoice_name) return;

		frappe.call({
			method: "erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry",
			args: { dt: "Sales Invoice", dn: invoice_name },
			freeze: true,
			callback: (r) => {
				if (!r.message) return;
				frappe.model.sync(r.message);
				frappe.set_route("Form", r.message.doctype, r.message.name);
			},
		});
	}

	process_payment() {
		let me = this;
		const original_total = flt(this.$total_display.text());
		this.current_payment_total = original_total;

		const customer = this.customer_control ? this.customer_control.get_value() : null;
		if (!this.cart.length) {
			frappe.msgprint({
				title: __("Cart Empty"),
				indicator: "red",
				message: __("Please add items to the cart before checkout."),
			});
			return;
		}

		if (!customer) {
			frappe.msgprint({
				title: __("Missing Customer"),
				indicator: "red",
				message: __("Please select a customer or choose Guest before checkout."),
			});
			return;
		}

		let stock_issues = this.get_checkout_stock_issues();
		if (stock_issues.length) {
			let issue_lines = stock_issues
				.slice(0, 5)
				.map(
					(issue) =>
						`${frappe.utils.escape_html(issue.item_name)}: ${__("Available")} ${flt(issue.available_qty).toFixed(2)}, ${__("In Cart")} ${flt(issue.required_qty).toFixed(2)}`,
				);
			let more_count = stock_issues.length - issue_lines.length;
			let more_text =
				more_count > 0 ? `<br>${__("and {0} more item(s).", [more_count])}` : "";

			frappe.msgprint({
				title: __("Hold Sale Needed"),
				indicator: "orange",
				message: __(
					"This cart cannot be checked out because some items do not have enough stock. Use Hold Sale instead.<br><br>{0}{1}",
					[issue_lines.join("<br>"), more_text],
				),
			});
			return;
		}

		let d = new frappe.ui.Dialog({
			title: __("Finalize Payment"),
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "payment_ui",
					options: `
                    <div class="payment-modal-container">
                        <div class="payment-summary mb-3 p-3 text-center" style="background:#f8f9fa; border-radius:10px; border: 2px solid #171717;">
                            <div class="text-muted small font-weight-bold">TOTAL PAYABLE</div>
                            <div class="h2 font-weight-bold text-dark m-0" id="modal-payable-total">₱${original_total.toFixed(2)}</div>
                        </div>

                        <div class="row">
                            <div class="col-md-6 border-right">
                                <label class="small font-weight-bold">AMOUNT RECEIVED</label>
                                <input type="number" id="numpad-input" class="form-control form-control-lg text-right font-weight-bold mb-3"
                                    style="font-size: 2.5rem; height: 70px; border: 2px solid #171717;" value="">
                                
                                <div class="numpad-grid">
                                    ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, ".", "C"]
										.map(
											(val) =>
												`<button class="num-btn" data-val="${val}">${val}</button>`,
										)
										.join("")}
                                </div>
                            </div>

                            <div class="col-md-6">
                                <label class="small font-weight-bold text-primary">APPLY DISCOUNT</label>
                                <div class="input-group mb-3">
                                    <input type="number" id="discount-val" class="form-control" placeholder="Value">
                                    <div class="input-group-append">
                                        <button class="btn btn-outline-primary disc-btn" data-type="perc">%</button>
                                        <button class="btn btn-outline-primary disc-btn" data-type="fix">₱</button>
                                    </div>
                                </div>

                                <label class="small font-weight-bold">PAYMENT METHOD</label>
                                <div class="d-flex gap-2 mb-3">
                                    <button class="btn btn-primary flex-grow-1 mop-btn active" data-mop="Cash">CASH</button>
                                    <button class="btn btn-outline-dark flex-grow-1 mop-btn" data-mop="G-Cash">G-CASH</button>
                                    <button class="btn btn-outline-dark flex-grow-1 mop-btn" data-mop="Utang">UTANG</button>
                                </div>

                                <div id="utang-credit-status" class="small mb-3" style="display:none;"></div>

                                <div id="payment-due-date-wrapper" class="mb-3" style="display:none;">
                                    <label class="small font-weight-bold">PAYMENT DUE DATE</label>
                                    <input type="date" id="payment-due-date" class="form-control">
                                </div>

                                <label class="small font-weight-bold">QUICK CASH</label>
                                <div class="quick-cash-grid mb-3">
                                    ${[50, 100, 500, 1000]
										.map(
											(amt) =>
												`<button class="btn btn-info quick-btn" data-amt="${amt}">₱${amt}</button>`,
										)
										.join("")}
                                </div>

                                <div class="change-display-box p-3 text-center" style="background:#171717; border-radius:8px;">
                                    <div class="small font-weight-bold text-white">CHANGE</div>
                                    <div id="modal-change-val" class="change-amount" style="font-size: 2rem; color: #00ff00; font-weight: bold;">₱0.00</div>
                                </div>
                            </div>
                        </div>
                    </div>`,
				},
			],
			primary_action_label: __("Complete Sale"),
			primary_action(values) {
				// using scoped lookup inside wrapper ensures we target the correct dialog
				const $wrapper = d.$wrapper;
				let selected_mop = $wrapper.find(".mop-btn.active").attr("data-mop");
				let received =
					selected_mop === "Utang" ? 0 : flt($wrapper.find("#numpad-input").val());
				let customer = me.customer_control.get_value();
				let has_outstanding =
					selected_mop === "Utang" || received < me.current_payment_total;
				let payment_due_date = $wrapper.find("#payment-due-date").val();

				if (!customer) {
					frappe.msgprint({
						title: __("Missing Customer"),
						indicator: "red",
						message: __("Please select a customer or <b>Guest</b>."),
					});
					return;
				}

				if (has_outstanding && !payment_due_date) {
					frappe.msgprint({
						title: __("Missing Due Date"),
						indicator: "red",
						message: __("Please set the payment due date before submitting."),
					});
					return;
				}

				if (selected_mop === "Utang") {
					me.validate_utang_credit(customer, me.current_payment_total, () => {
						me.submit_payment(d, selected_mop, 0, customer, payment_due_date);
					});
					return;
				}

				me.submit_payment(d, selected_mop, received, customer, payment_due_date);
			},
		});

		// REBIND LISTENERS ON SHOW - Fixes the frozen interface issue
		d.on_page_show = () => {
			// remember wrapper for scoped operations
			me.$payment_wrapper = d.$wrapper;
			me.attach_payment_listeners(original_total);
			// Slight delay for focus to ensure DOM is ready
			setTimeout(() => {
				me.$payment_wrapper.find("#numpad-input").focus().select();
				me.$payment_wrapper.find("#payment-due-date").val(frappe.datetime.get_today());
				me.update_payment_ui();
			}, 100);
		};

		// remove old dialog from DOM when hidden so duplicate IDs don't accumulate
		d.on_hide = () => {
			if (me.$payment_wrapper) {
				me.$payment_wrapper.remove();
				me.$payment_wrapper = null;
			}
		};

		this.$payment_dialog = d;
		d.show();
	}

	submit_payment(dialog, selected_mop, received, customer, payment_due_date = null) {
		let cart_payload = this.cart.map((i) => ({
			item_code: i.item_code,
			qty: i.qty,
			uom: i.uom,
			price: i.price,
			discount_pct: i.discount_pct,
		}));

		frappe.call({
			method: "minimart_pos.api.create_invoice",
			args: {
				cart: JSON.stringify(cart_payload),
				customer: customer,
				mode_of_payment: selected_mop,
				amount_paid: received,
				total_payable: this.current_payment_total,
				held_sale_name: this.active_held_sale_name,
				payment_due_date: payment_due_date,
			},
			freeze: true,
			callback: (r) => {
				if (selected_mop !== "Utang") {
					this.trigger_cash_drawer();
				}
				dialog.hide();
				this.cart = [];
				this.active_held_sale_name = null;
				this.render_cart();
				this.load_recent_orders();
				this.focus_input();
			},
		});
	}

	validate_utang_credit(customer, amount, on_success) {
		frappe.call({
			method: "minimart_pos.api.get_utang_credit_status",
			args: { customer: customer, amount: amount },
			freeze: true,
			callback: (r) => {
				if (!r.message) return;
				if (!r.message.allowed) {
					frappe.msgprint({
						title: __("Utang Not Allowed"),
						indicator: "red",
						message: __(
							"Credit limit exceeded. Current outstanding: {0}, Sale amount: {1}, Credit limit: {2}.",
							[
								flt(r.message.current_outstanding).toFixed(2),
								flt(amount).toFixed(2),
								flt(r.message.credit_limit).toFixed(2),
							],
						),
					});
					return;
				}
				if (on_success) on_success(r.message);
			},
		});
	}

	attach_payment_listeners(original_total) {
		let me = this;
		// operate within the current payment dialog wrapper to avoid clashes
		const $wrapper = this.$payment_wrapper || $(document);
		const $input = $wrapper.find("#numpad-input");

		// Clean existing listeners to prevent duplicates/ghosting
		$wrapper.find(".num-btn, .quick-btn, .disc-btn, .mop-btn").off("click");
		$input.off("input keyup");

		// Numpad Logic
		$wrapper.find(".num-btn").on("click", function (e) {
			e.preventDefault();
			if ($wrapper.find(".mop-btn.active").attr("data-mop") === "Utang") return;
			let val = $(this).attr("data-val");
			let cur = $input.val();

			if (val === "C") {
				$input.val("");
			} else if (val === ".") {
				if (!cur.includes(".")) $input.val(cur + val);
			} else {
				$input.val(cur + val);
			}
			me.update_payment_ui();
		});

		// Quick Cash Logic
		$wrapper.find(".quick-btn").on("click", function (e) {
			e.preventDefault();
			if ($wrapper.find(".mop-btn.active").attr("data-mop") === "Utang") return;
			$input.val($(this).attr("data-amt"));
			me.update_payment_ui();
		});

		// Discount Logic
		$wrapper.find(".disc-btn").on("click", function (e) {
			e.preventDefault();
			let type = $(this).attr("data-type");
			let val = flt($wrapper.find("#discount-val").val());
			if (type === "perc") {
				me.current_payment_total = original_total - original_total * (val / 100);
			} else {
				me.current_payment_total = original_total - val;
			}
			me.update_payment_ui();
			if ($wrapper.find(".mop-btn.active").attr("data-mop") === "Utang") {
				me.handle_payment_method_change();
			}
		});

		// MOP Toggle Logic
		$wrapper.find(".mop-btn").on("click", function (e) {
			e.preventDefault();
			$wrapper
				.find(".mop-btn")
				.removeClass("active btn-primary")
				.addClass("btn-outline-dark");
			$(this).addClass("active btn-primary").removeClass("btn-outline-dark");
			me.handle_payment_method_change();
		});

		// Keyboard Typing
		$input.on("input keyup", () => {
			if ($wrapper.find(".mop-btn.active").attr("data-mop") === "Utang") {
				$input.val("0");
			}
			me.update_payment_ui();
		});

		// Enter key to submit
		$input.on("keypress", function (e) {
			if (e.which == 13) {
				// Enter key
				e.preventDefault();
				me.$payment_dialog.primary_action({});
			}
		});

		me.update_payment_ui();
	}

	handle_payment_method_change() {
		const $wrapper = this.$payment_wrapper || $(document);
		const selected_mop = $wrapper.find(".mop-btn.active").attr("data-mop");
		const $input = $wrapper.find("#numpad-input");
		const $utang_status = $wrapper.find("#utang-credit-status");

		if (selected_mop !== "Utang") {
			this.current_utang_allowed = false;
			$input.prop("disabled", false);
			$utang_status.hide().empty();
			this.update_payment_ui();
			return;
		}

		$input.val("0").prop("disabled", true);
		this.current_utang_allowed = false;

		const customer = this.customer_control ? this.customer_control.get_value() : null;
		$utang_status
			.show()
			.removeClass("text-success text-danger")
			.addClass("text-muted")
			.html(__("Checking credit limit..."));

		frappe.call({
			method: "minimart_pos.api.get_utang_credit_status",
			args: { customer: customer, amount: this.current_payment_total },
			callback: (r) => {
				if (!r.message) return;
				this.current_utang_allowed = Boolean(r.message.allowed);
				$utang_status
					.removeClass("text-muted text-danger text-success")
					.addClass(r.message.allowed ? "text-success" : "text-danger")
					.html(
						`${__("Outstanding")}: ₱${flt(r.message.current_outstanding).toFixed(2)}<br>` +
							`${__("Credit Limit")}: ₱${flt(r.message.credit_limit).toFixed(2)}<br>` +
							`${__("After Sale")}: ₱${flt(r.message.projected_outstanding).toFixed(2)}`,
					);
			},
			error: () => {
				this.current_utang_allowed = false;
				$utang_status
					.removeClass("text-muted text-success")
					.addClass("text-danger")
					.html(__("Utang is not allowed for this customer or amount."));
			},
		});

		this.update_payment_ui();
	}

	update_payment_ui() {
		const $wrapper = this.$payment_wrapper || $(document);
		let selected_mop = $wrapper.find(".mop-btn.active").attr("data-mop");
		let received = selected_mop === "Utang" ? 0 : flt($wrapper.find("#numpad-input").val());
		let change = received - this.current_payment_total;
		let has_outstanding = selected_mop === "Utang" || received < this.current_payment_total;
		let $due_date_wrapper = $wrapper.find("#payment-due-date-wrapper");
		let $due_date = $wrapper.find("#payment-due-date");

		if (has_outstanding) {
			if (!$due_date.val()) {
				$due_date.val(frappe.datetime.get_today());
			}
			$due_date_wrapper.show();
		} else {
			$due_date_wrapper.hide();
		}

		$wrapper.find("#modal-change-val").text("₱" + (change >= 0 ? change.toFixed(2) : "0.00"));
		$wrapper.find("#modal-change-val").css("color", change >= 0 ? "#00ff00" : "#ff4d4d");
		$wrapper.find("#modal-payable-total").text("₱" + this.current_payment_total.toFixed(2));
	}

	void_transaction(invoice_name) {
		frappe.msgprint({
			title: __("Void Not Allowed"),
			indicator: "orange",
			message: __("Checkout has already happened for {0}. Use Return Sale instead.", [
				invoice_name,
			]),
		});
	}

	view_past_order(invoice_name) {
		if (invoice_name) frappe.set_route("Form", "Sales Invoice", invoice_name);
	}
	close_shift() {
		frappe.confirm(__("Close shift?"), () => {
			frappe.call({
				method: "minimart_pos.api.close_pos_shift",
				args: { opening_entry: this.shift_data.opening_entry },
				callback: () => location.reload(),
			});
		});
	}
}
