frappe.pages['martpos_page'].on_page_load = function(wrapper) {
    let page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'Mart POS',
        single_column: true
    });

    // Initial Shift Check
    frappe.call({
        method: "minimart_pos.api.check_pos_opening",
        callback: function(r) {
            if (!r.message.opening_entry) {
                show_opening_dialog(r.message.pos_profile);
            } else {
                render_pos_ui(page, r.message);
            }
        }
    });
};

function show_opening_dialog(profile) {
    let d = new frappe.ui.Dialog({
        title: __('Open POS Shift'),
        fields: [
            { label: __('Opening Amount'), fieldname: 'amount', fieldtype: 'Currency', default: 0 }
        ],
        primary_action_label: __('Start Shift'),
        primary_action(values) {
            frappe.call({
                method: "minimart_pos.api.create_opening_entry",
                args: { pos_profile: profile, amount: values.amount },
                callback: (r) => { d.hide(); location.reload(); }
            });
        }
    });
    d.show();
}

function render_pos_ui(page, shift_data) {
    $(frappe.render_template("martpos_page", {})).appendTo(page.main);
    window.pos_instance = new MiniMartPOS(page, shift_data);
    window.pos_instance.init();

    page.set_primary_action(__('Open Drawer'), () => window.pos_instance.trigger_cash_drawer());
    page.add_menu_item(__('Close Shift'), () => window.pos_instance.close_shift());
}

class MiniMartPOS {
    constructor(page, shift_data) {
        this.page = page;
        this.shift_data = shift_data;
        this.cart = [];
        this.customer_control = null;
        this.serialPort = null; 
        // keep track of the currently open payment dialog wrapper
        this.$payment_wrapper = null;
        
        // Modal State
        this.current_payment_total = 0;
        
        // Selectors
        this.$scan_input = $('#barcode-scan');
        this.$group_filter = $('#item-group-filter');
        this.$cart_container = $('#cart-table');
        this.$total_display = $('#grand-total');
        this.$product_grid = $('#product-grid');
        this.$recent_orders_list = $('#recent-orders-list');
    }

    init() {
        this.setup_customer_control();
        this.bind_events();
        this.load_item_groups();
        this.load_products();
        this.load_recent_orders();
        this.focus_input();
    }

    setup_customer_control() {
        let me = this;
        let cust_container = $('#customer-search-container');
        if (cust_container.length) {
            cust_container.empty();
            let $wrapper = $(`<div class="d-flex gap-2 align-items-center">
                <div id="customer-link-field" style="flex:1;"></div>
                <button class="btn btn-sm btn-outline-secondary" id="set-guest-btn" style="height:38px;">Guest</button>
            </div>`).appendTo(cust_container);

            this.customer_control = frappe.ui.form.make_control({
                df: {
                    fieldtype: "Link", options: "Customer", 
                    placeholder: "Search Customer...",
                    onchange: () => me.focus_input()
                },
                parent: $wrapper.find('#customer-link-field'),
                render_input: true
            });
            
            this.customer_control.set_value(this.shift_data.customer || "Guest");

            $wrapper.find('#set-guest-btn').on('click', () => {
                me.customer_control.set_value("Guest");
                me.focus_input();
            });
        }
    }

    focus_input() {
        setTimeout(() => { if (this.$scan_input.length) this.$scan_input.focus(); }, 200);
    }

    bind_events() {
        const handleBarcodeScan = (e) => {
            if (e.key === 'Enter' || e.which == 13) {
                let code = this.$scan_input.val().trim();
                if (code) this.fetch_item(code);
                this.$scan_input.val('');
                this.filter_products();
                e.preventDefault();
            }
        };

        this.$scan_input.on('keypress', handleBarcodeScan);
        this.$scan_input.on('keydown', handleBarcodeScan);

        this.$scan_input.on('input', () => this.filter_products());
        this.$group_filter.on('change', () => { this.filter_products(); this.focus_input(); });

        $(document).on('click', (e) => {
            if (!$(e.target).closest('#barcode-scan, #item-group-filter, #customer-search-container, .awesomplete, .modal-dialog, .cart-qty-input, .btn-qty, .num-btn, .quick-btn').length) {
                this.focus_input();
            }
        });

        $(document).on('click', '#checkout-btn', () => this.process_payment());
    }

    async trigger_cash_drawer() {
        try {
            if (!("serial" in navigator)) return;
            if (!this.serialPort) this.serialPort = await navigator.serial.requestPort({ filters: [] });
            if (!this.serialPort.writable) await this.serialPort.open({ baudRate: 9600 });
            const writer = this.serialPort.writable.getWriter();
            const open_cmd = new Uint8Array([27, 112, 0, 25, 250]);
            await writer.write(open_cmd);
            writer.releaseLock();
        } catch (err) { console.error("Hardware Error:", err); this.serialPort = null; }
    }

    load_item_groups() {
        frappe.call({
            method: "frappe.client.get_list",
            args: { doctype: "Item Group", filters: { "is_group": 0 }, fields: ["name"], limit_page_length: 100 },
            callback: (r) => {
                if (r.message) {
                    let options = r.message.map(g => `<option value="${g.name}">${g.name}</option>`);
                    this.$group_filter.append(options.join(''));
                }
            }
        });
    }

    load_products() {
        frappe.call({
            method: "minimart_pos.api.get_products",
            callback: (r) => { if (r.message) this.render_products(r.message); }
        });
    }

    render_products(products) {
        let html = products.map(item => {
            if (flt(item.actual_qty) <= 0) return '';
            const itemJSON = JSON.stringify(item).replace(/"/g, '&quot;');
            let badge_class = flt(item.actual_qty) <= 5 ? 'bg-warning' : 'bg-success';
            return `
                <div class="product-card" 
                     data-item-code="${item.item_code.toLowerCase()}" 
                     data-item-name="${item.item_name.toLowerCase()}"
                     data-item-group="${item.item_group || ''}"
                     data-actual-qty="${item.actual_qty}"
                     onclick="pos_instance.add_to_cart(${itemJSON})">
                    <span class="stock-badge ${badge_class}">${Math.floor(item.actual_qty)}</span>
                    <div class="product-image">
                        ${item.image ? `<img src="${item.image}">` : `<div class="img-placeholder">${item.item_name[0]}</div>`}
                    </div>
                    <div class="product-name">${item.item_name}</div>
                    <div class="product-price">₱${flt(item.price).toFixed(2)}</div>
                </div>
            `;
        }).join('');
        this.$product_grid.html(html);
        this.filter_products();
    }

    filter_products() {
        let keyword = this.$scan_input.val().toLowerCase().trim();
        let selected_group = this.$group_filter.val();
        this.$product_grid.find('.product-card').each(function() {
            let name = $(this).attr('data-item-name') || "";
            let code = $(this).attr('data-item-code') || "";
            let group = $(this).attr('data-item-group') || "";
            let qty = flt($(this).attr('data-actual-qty'));
            let match = (name.includes(keyword) || code.includes(keyword)) && 
                        (selected_group === "" || group === selected_group) && (qty > 0);
            $(this).toggle(match);
        });
    }

    fetch_item(barcode) {
        frappe.call({
            method: "minimart_pos.api.get_item_by_barcode",
            args: { barcode: barcode },
            callback: (r) => {
                if (r.message) {
                    if (flt(r.message.actual_qty) <= 0) {
                        frappe.show_alert({message: __('Out of stock'), indicator: 'red'});
                    } else {
                        this.add_to_cart(r.message);
                        frappe.utils.play_sound("submit");
                    }
                } else {
                    frappe.show_alert({message: __('Not found'), indicator: 'red'});
                    frappe.utils.play_sound("error");
                }
                this.focus_input();
            }
        });
    }

    add_to_cart(item) {
        let $card = $(`.product-card[data-item-code="${item.item_code.toLowerCase()}"]`);
        let current_stock = flt($card.attr('data-actual-qty'));
        if (current_stock <= 0) {
            frappe.show_alert({message: __('Out of stock!'), indicator: 'red'});
            $card.hide();
            return;
        }

        // Keep discounted lines separate from newly added items.
        let existing = this.cart.find(i => i.item_code === item.item_code && flt(i.discount_pct || 0) === 0);
        if (existing) {
            existing.qty += 1;
        } else {
            this.cart.push({ item_code: item.item_code, item_name: item.item_name, price: flt(item.price), discount_pct: 0, qty: 1 });
        }

        this.sync_grid_stock(item.item_code, -1);
        this.render_cart();
    }

    update_item_discount(index, value) {
        let item = this.cart[index];
        let discount_pct = Math.max(0, Math.min(100, flt(value)));
        if (discount_pct > 100) {
            discount_pct = 100;
            frappe.show_alert({ message: __('Discount cannot exceed 100%'), indicator: 'orange' });
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
            let discountedPrice = basePrice * (1 - (discount_pct / 100));
            discountedPrice = discountedPrice < 0 ? 0 : discountedPrice;
            let savedAmount = basePrice - discountedPrice;
            d.fields_dict.discount_preview.$wrapper.html(
                `<div class="discount-modal-summary">
                    <div><strong>${__('Original Price')}:</strong> ₱${basePrice.toFixed(2)}</div>
                    <div><strong>${__('Discount')}:</strong> ${discount_pct.toFixed(0)}%</div>
                    <div><strong>${__('Discounted Price')}:</strong> ₱${discountedPrice.toFixed(2)}</div>
                    <div><strong>${__('You Save')}:</strong> ₱${savedAmount.toFixed(2)}</div>
                </div>`
            );
        };

        let d = new frappe.ui.Dialog({
            title: __('Item Discount'),
            fields: [
                {
                    fieldtype: 'Float',
                    fieldname: 'discount_pct',
                    label: __('Discount %'),
                    default: flt(item.discount_pct || 0),
                    description: __('Enter discount percentage for this item'),
                    reqd: 1
                },
                {
                    fieldtype: 'HTML',
                    fieldname: 'discount_preview',
                    options: ''
                }
            ],
            primary_action_label: __('Apply'),
            primary_action(values) {
                let discount_pct = Math.max(0, Math.min(100, flt(values.discount_pct)));
                item.discount_pct = discount_pct;
                me.render_cart();
                d.hide();
            }
        });

        d.on_page_show = () => {
            const $input = d.fields_dict.discount_pct.input ? d.fields_dict.discount_pct.input : d.fields_dict.discount_pct.$input;
            updatePreview($input.val());
            $input.on('input', (e) => updatePreview($(e.target).val()));
        };

        d.show();
    }

    sync_grid_stock(item_code, change) {
        let $card = $(`.product-card[data-item-code="${item_code.toLowerCase()}"]`);
        if (!$card.length) return;
        let new_stock = flt($card.attr('data-actual-qty')) + change;
        $card.attr('data-actual-qty', new_stock);
        $card.find('.stock-badge').text(Math.floor(new_stock));
        if (new_stock <= 0) $card.hide();
        else $card.show();
    }

    update_qty(index, delta) {
        let item = this.cart[index];
        let $card = $(`.product-card[data-item-code="${item.item_code.toLowerCase()}"]`);
        let current_stock = flt($card.attr('data-actual-qty'));
        if (delta > 0 && current_stock <= 0) return;
        item.qty = flt(item.qty) + delta;
        this.sync_grid_stock(item.item_code, -delta);
        if (item.qty <= 0) this.cart.splice(index, 1);
        this.render_cart();
    }

    manual_qty_update(index, value) {
        let item = this.cart[index];
        let diff = flt(value) - item.qty;
        let $card = $(`.product-card[data-item-code="${item.item_code.toLowerCase()}"]`);
        let current_stock = flt($card.attr('data-actual-qty'));
        if (diff > current_stock) {
            frappe.show_alert({message: __('Insufficient Stock'), indicator: 'orange'});
            this.render_cart();
            return;
        }
        item.qty = flt(value);
        this.sync_grid_stock(item.item_code, -diff);
        if (item.qty <= 0) this.cart.splice(index, 1);
        this.render_cart();
    }

    render_cart() {
        let html = this.cart.map((item, index) => {
            let discount_pct = flt(item.discount_pct || 0);
            let linePrice = flt(item.price) * (1 - (discount_pct / 100));
            if (linePrice < 0) linePrice = 0;
            let lineTotal = (item.qty * linePrice).toFixed(2);
            return `
            <div class="cart-row">
                <div class="item-name">${item.item_name}</div>
                <div class="qty-controls">
                    <button onclick="pos_instance.update_qty(${index}, -1)" class="btn-qty">-</button>
                    <input type="number" class="cart-qty-input" value="${item.qty}" onchange="pos_instance.manual_qty_update(${index}, this.value)">
                    <button onclick="pos_instance.update_qty(${index}, 1)" class="btn-qty">+</button>
                </div>
                <div class="discount-input-wrapper">
                    <button type="button" class="discount-btn" onclick="pos_instance.open_item_discount_modal(${index})">
                        ${flt(item.discount_pct || 0).toFixed(0)}% <i class="fa fa-percent"></i>
                    </button>
                </div>
                <div class="item-total">₱${lineTotal}</div>
                <button onclick="pos_instance.remove_item(${index})" class="btn-remove">×</button>
            </div>
        `}).join('');
        $('#cart-count').text(`${this.cart.length} Items`);
        this.$cart_container.html(this.cart.length ? html : `<div class="empty-cart-msg">${__('No items in cart')}</div>`);
        this.update_total();
    }

    remove_item(index) {
        let item = this.cart[index];
        this.sync_grid_stock(item.item_code, item.qty);
        this.cart.splice(index, 1);
        this.render_cart();
        this.focus_input();
    }

    update_total() {
        let total = this.cart.reduce((sum, i) => {
            let discount_pct = flt(i.discount_pct || 0);
            let linePrice = flt(i.price) * (1 - (discount_pct / 100));
            if (linePrice < 0) linePrice = 0;
            return sum + (i.qty * linePrice);
        }, 0);
        this.$total_display.text(total.toFixed(2));
    }

    load_recent_orders() {
        frappe.call({
            method: "minimart_pos.api.get_recent_invoices", 
            args: { opening_entry: this.shift_data.opening_entry },
            callback: (r) => { if (r.message) this.render_recent_orders(r.message); }
        });
    }

    render_recent_orders(orders) {
        if (!orders.length) {
            this.$recent_orders_list.html('<div class="text-center p-2 text-muted">No orders</div>');
            return;
        }
        let html = orders.map(order => `
            <div class="recent-order-item">
                <div class="d-flex justify-content-between" onclick="pos_instance.view_past_order('${order.name}')" style="cursor:pointer;">
                    <span class="order-id">#${order.name.split('-').pop()}</span>
                    <span class="order-total">₱${flt(order.grand_total).toFixed(2)}</span>
                </div>
                <div class="d-flex justify-content-between align-items-center mt-1">
                    <span class="order-customer text-muted" style="font-size: 10px;">${order.customer}</span>
                    <button class="btn btn-xs btn-danger" onclick="pos_instance.void_transaction('${order.name}')">Void</button>
                </div>
            </div>
        `).join('');
        this.$recent_orders_list.html(html);
    }

    process_payment() {
        let me = this;
        const original_total = flt(this.$total_display.text());
        this.current_payment_total = original_total;

        const customer = this.customer_control ? this.customer_control.get_value() : null;
        if (!this.cart.length) {
            frappe.msgprint({
                title: __('Cart Empty'),
                indicator: 'red',
                message: __('Please add items to the cart before checkout.')
            });
            return;
        }

        if (!customer) {
            frappe.msgprint({
                title: __('Missing Customer'),
                indicator: 'red',
                message: __('Please select a customer or choose Guest before checkout.')
            });
            return;
        }

        let d = new frappe.ui.Dialog({
            title: __('Finalize Payment'),
            fields: [
                { 
                    fieldtype: 'HTML', 
                    fieldname: 'payment_ui',
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
                                    style="font-size: 2.5rem; height: 70px; border: 2px solid #171717;" value="${original_total}">
                                
                                <div class="numpad-grid">
                                    ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '.', 'C'].map(val => 
                                        `<button class="num-btn" data-val="${val}">${val}</button>`
                                    ).join('')}
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
                                </div>

                                <label class="small font-weight-bold">QUICK CASH</label>
                                <div class="quick-cash-grid mb-3">
                                    ${[50, 100, 500, 1000].map(amt => 
                                        `<button class="btn btn-info quick-btn" data-amt="${amt}">₱${amt}</button>`
                                    ).join('')}
                                </div>

                                <div class="change-display-box p-3 text-center" style="background:#171717; border-radius:8px;">
                                    <div class="small font-weight-bold text-white">CHANGE</div>
                                    <div id="modal-change-val" class="change-amount" style="font-size: 2rem; color: #00ff00; font-weight: bold;">₱0.00</div>
                                </div>
                            </div>
                        </div>
                    </div>`
                }
            ],
            primary_action_label: __('Complete Sale'),
            primary_action(values) {
                // using scoped lookup inside wrapper ensures we target the correct dialog
                const $wrapper = d.$wrapper;
                let received = flt($wrapper.find('#numpad-input').val());
                let selected_mop = $wrapper.find('.mop-btn.active').attr('data-mop');
                let customer = me.customer_control.get_value();

                if (!customer) {
                    frappe.msgprint({
                        title: __('Missing Customer'),
                        indicator: 'red',
                        message: __('Please select a customer or <b>Guest</b>.')
                    });
                    return;
                }

                if (received < me.current_payment_total) {
                    frappe.msgprint(__("Insufficient amount received."));
                    return;
                }
                
                frappe.call({
                    method: "minimart_pos.api.create_invoice",
                    args: { 
                        cart: JSON.stringify(me.cart), 
                        customer: customer, 
                        mode_of_payment: selected_mop, 
                        amount_paid: received,
                        total_payable: me.current_payment_total
                    },
                    freeze: true,
                    callback: (r) => {
                        me.trigger_cash_drawer();
                        d.hide();
                        me.cart = [];
                        me.render_cart();
                        me.load_recent_orders();
                        me.focus_input();
                    }
                });
            }
        });

        // REBIND LISTENERS ON SHOW - Fixes the frozen interface issue
        d.on_page_show = () => {
            // remember wrapper for scoped operations
            me.$payment_wrapper = d.$wrapper;
            me.attach_payment_listeners(original_total);
            // Slight delay for focus to ensure DOM is ready
            setTimeout(() => {
                me.$payment_wrapper.find('#numpad-input').focus().select();
            }, 100);
        };

        // remove old dialog from DOM when hidden so duplicate IDs don't accumulate
        d.on_hide = () => {
            if (me.$payment_wrapper) {
                me.$payment_wrapper.remove();
                me.$payment_wrapper = null;
            }
        };

        d.show();
    }

    attach_payment_listeners(original_total) {
        let me = this;
        // operate within the current payment dialog wrapper to avoid clashes
        const $wrapper = this.$payment_wrapper || $(document);
        const $input = $wrapper.find('#numpad-input');

        // Clean existing listeners to prevent duplicates/ghosting
        $wrapper.find('.num-btn, .quick-btn, .disc-btn, .mop-btn').off('click');
        $input.off('input keyup');

        // Numpad Logic
        $wrapper.find('.num-btn').on('click', function(e) {
            e.preventDefault();
            let val = $(this).attr('data-val');
            let cur = $input.val();
            
            if (val === 'C') {
                $input.val('');
            } else if (val === '.') {
                if (!cur.includes('.')) $input.val(cur + val);
            } else {
                $input.val(cur + val);
            }
            me.update_payment_ui();
        });

        // Quick Cash Logic
        $wrapper.find('.quick-btn').on('click', function(e) {
            e.preventDefault();
            $input.val($(this).attr('data-amt'));
            me.update_payment_ui();
        });

        // Discount Logic
        $wrapper.find('.disc-btn').on('click', function(e) {
            e.preventDefault();
            let type = $(this).attr('data-type');
            let val = flt($wrapper.find('#discount-val').val());
            if (type === 'perc') {
                me.current_payment_total = original_total - (original_total * (val / 100));
            } else {
                me.current_payment_total = original_total - val;
            }
            me.update_payment_ui();
        });

        // MOP Toggle Logic
        $wrapper.find('.mop-btn').on('click', function(e) {
            e.preventDefault();
            $wrapper.find('.mop-btn').removeClass('active btn-primary').addClass('btn-outline-dark');
            $(this).addClass('active btn-primary').removeClass('btn-outline-dark');
        });

        // Keyboard Typing
        $input.on('input keyup', () => me.update_payment_ui());
        
        me.update_payment_ui();
    }

    update_payment_ui() {
        const $wrapper = this.$payment_wrapper || $(document);
        let received = flt($wrapper.find('#numpad-input').val());
        let change = received - this.current_payment_total;
        
        $wrapper.find('#modal-change-val').text('₱' + (change >= 0 ? change.toFixed(2) : '0.00'));
        $wrapper.find('#modal-change-val').css('color', change >= 0 ? '#00ff00' : '#ff4d4d');
        $wrapper.find('#modal-payable-total').text('₱' + this.current_payment_total.toFixed(2));
    }

    void_transaction(invoice_name) {
        frappe.confirm(__('Void order {0}?', [invoice_name]), () => {
            frappe.call({
                method: "minimart_pos.api.void_invoice",
                args: { invoice_name: invoice_name },
                callback: (r) => {
                    if (r.message) {
                        r.message.forEach(item => this.sync_grid_stock(item.item_code, item.qty));
                        this.load_recent_orders();
                        frappe.show_alert({message: __('Voided Successfully'), indicator: 'green'});
                    }
                }
            });
        });
    }

    view_past_order(invoice_name) { if (invoice_name) frappe.set_route("Form", "POS Invoice", invoice_name); }
    close_shift() {
        frappe.confirm(__('Close shift?'), () => {
            frappe.call({ method: "minimart_pos.api.close_pos_shift", args: { opening_entry: this.shift_data.opening_entry }, callback: () => location.reload() });
        });
    }
}