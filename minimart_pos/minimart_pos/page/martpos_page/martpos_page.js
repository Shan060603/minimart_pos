frappe.pages['martpos_page'].on_page_load = function(wrapper) {
    let page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'Mart POS',
        single_column: true
    });

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
        fields: [{ label: __('Opening Amount'), fieldname: 'amount', fieldtype: 'Currency', default: 0 }],
        primary_action_label: __('Start Shift'),
        primary_action(values) {
            frappe.call({
                method: "minimart_pos.api.create_opening_entry",
                args: { pos_profile: profile, amount: values.amount },
                callback: () => { d.hide(); location.reload(); }
            });
        }
    });
    d.show();
}

function render_pos_ui(page, shift_data) {
    $(frappe.render_template("martpos_page", {})).appendTo(page.main);
    window.pos_instance = new MiniMartPOS(page, shift_data);
    window.pos_instance.init();

    page.add_menu_item(__('Close Shift'), () => {
        window.pos_instance.close_shift();
    });
}

class MiniMartPOS {
    constructor(page, shift_data) {
        this.page = page;
        this.shift_data = shift_data;
        this.cart = [];
        this.customer_control = null;
        
        // Selectors
        this.$scan_input = $('#barcode-scan');
        this.$cart_container = $('#cart-table');
        this.$total_display = $('#grand-total');
        this.$product_grid = $('#product-grid');
    }

    init() {
        this.setup_customer_control();
        this.bind_events();
        this.load_products();
        this.focus_input();
    }

    setup_customer_control() {
        let me = this;
        let cust_container = $('#customer-search-container');
        
        if (cust_container.length) {
            cust_container.empty();
            this.customer_control = frappe.ui.form.make_control({
                df: {
                    fieldtype: "Link", 
                    options: "Customer", 
                    placeholder: "Search Customer...",
                    onchange: function() {
                        me.focus_input();
                    }
                },
                parent: cust_container,
                render_input: true
            });
            
            let default_cust = this.shift_data.customer || "Guest";
            this.customer_control.set_value(default_cust);
        }
    }

    focus_input() {
        if (this.$scan_input.length) {
            this.$scan_input.focus();
        }
    }

    bind_events() {
        this.$scan_input.on('keypress', (e) => {
            if (e.which == 13) {
                let code = this.$scan_input.val().trim();
                if (code) this.fetch_item(code);
                this.$scan_input.val('');
            }
        });

        $(document).on('click', (e) => {
            if (!$(e.target).closest('#barcode-scan, #customer-search-container, .awesomplete, .modal-dialog, .cart-qty-input').length) {
                setTimeout(() => this.focus_input(), 1000);
            }
        });

        $(document).on('click', '#checkout-btn', () => this.process_payment());
    }

    load_products() {
        frappe.call({
            method: "minimart_pos.api.get_products",
            callback: (r) => {
                if (r.message) this.render_products(r.message);
            }
        });
    }

    render_products(products) {
        let html = products.map(item => {
            const itemJSON = JSON.stringify(item).replace(/"/g, '&quot;');
            return `
                <div class="product-card" onclick="pos_instance.add_to_cart(${itemJSON})">
                    <div class="product-image">
                        ${item.image ? `<img src="${item.image}">` : `<div class="img-placeholder">${item.item_name[0]}</div>`}
                    </div>
                    <div class="product-details">
                        <div class="product-name">${item.item_name}</div>
                        <div class="product-price">₱${flt(item.price).toFixed(2)}</div>
                    </div>
                </div>
            `;
        }).join('');
        this.$product_grid.html(html);
    }

    fetch_item(barcode) {
        frappe.call({
            method: "minimart_pos.api.get_item_by_barcode",
            args: { barcode: barcode },
            callback: (r) => {
                if (r.message) {
                    this.add_to_cart(r.message);
                    frappe.utils.play_sound("submit");
                } else {
                    frappe.show_alert({message: __('Item not found'), indicator: 'red'});
                    frappe.utils.play_sound("error");
                }
                this.focus_input();
            }
        });
    }

    add_to_cart(item) {
        let existing = this.cart.find(i => i.item_code === item.item_code);
        if (existing) {
            existing.qty += 1;
        } else {
            this.cart.push({
                item_code: item.item_code,
                item_name: item.item_name,
                price: flt(item.price),
                qty: 1
            });
        }
        this.render_cart();
    }

    update_qty(index, delta) {
        let item = this.cart[index];
        item.qty = flt(item.qty) + delta;

        if (item.qty <= 0) {
            this.remove_item(index);
        } else {
            this.render_cart();
        }
    }

    // --- NEW: Handle manual decimal input ---
    manual_qty_update(index, value) {
        let val = flt(value);
        if (val <= 0) {
            this.remove_item(index);
        } else {
            this.cart[index].qty = val;
            this.update_total();
            
            // Update row total display without full re-render
            let row_total = (this.cart[index].qty * this.cart[index].price).toFixed(2);
            $(`.cart-row[data-index="${index}"] .item-total`).text(`₱${row_total}`);
        }
    }

    render_cart() {
        let html = this.cart.map((item, index) => `
            <div class="cart-row" data-index="${index}" style="display: flex; align-items: center; justify-content: space-between; padding: 10px; border-bottom: 1px solid #f0f0f0;">
                <div class="item-meta" style="flex: 1;">
                    <strong>${item.item_name || item.item_code}</strong><br>
                    <small>₱${item.price.toFixed(2)}</small>
                </div>
                
                <div class="qty-controls" style="display: flex; align-items: center; gap: 5px; margin: 0 15px;">
                    <button onclick="pos_instance.update_qty(${index}, -1)" class="btn btn-xs btn-default" style="font-weight: bold;">-</button>
                    
                    <input type="number" step="any" class="form-control cart-qty-input" 
                        value="${item.qty}" 
                        style="width: 65px; text-align: center; height: 28px; padding: 2px; font-size: 13px;"
                        onchange="pos_instance.manual_qty_update(${index}, this.value)">
                    
                    <button onclick="pos_instance.update_qty(${index}, 1)" class="btn btn-xs btn-default" style="font-weight: bold;">+</button>
                </div>

                <div class="item-total" style="font-weight: bold; min-width: 80px; text-align: right;">
                    ₱${(item.qty * item.price).toFixed(2)}
                </div>
                
                <button onclick="pos_instance.remove_item(${index})" class="btn-remove" style="background: none; border: none; color: #ff5858; margin-left: 10px; cursor: pointer; font-size: 18px;">×</button>
            </div>
        `).join('');

        if (this.cart.length === 0) {
            html = `<div class="p-5 text-center text-muted">${__('No items in cart')}</div>`;
        }

        $('#cart-count').text(`${this.cart.length} Items`);
        this.$cart_container.html(html);
        this.update_total();
    }

    remove_item(index) {
        this.cart.splice(index, 1);
        this.render_cart();
        this.focus_input();
    }

    update_total() {
        let total = this.cart.reduce((sum, i) => sum + (i.qty * i.price), 0);
        this.$total_display.text(total.toFixed(2));
    }

    process_payment() {
        let me = this;
        let grand_total = flt(this.$total_display.text());
        let customer = this.customer_control ? this.customer_control.get_value() : "Guest";

        if (!this.cart.length) {
            frappe.show_alert({message: __("Cart is empty"), indicator: 'orange'});
            return;
        }

        let d = new frappe.ui.Dialog({
            title: __('Finalize Payment'),
            fields: [
                {
                    label: __('Total Payable'),
                    fieldname: 'total_payable',
                    fieldtype: 'Currency',
                    default: grand_total,
                    read_only: 1
                },
                {
                    label: __('Mode of Payment'),
                    fieldname: 'mode_of_payment',
                    fieldtype: 'Select',
                    options: me.shift_data.payment_methods || ['Cash'],
                    default: me.shift_data.payment_methods ? me.shift_data.payment_methods[0] : 'Cash'
                },
                {
                    label: __('Amount Received'),
                    fieldname: 'amount_received',
                    fieldtype: 'Currency',
                    default: grand_total,
                    onchange: function() {
                        let received = flt(this.get_value());
                        let change = received - grand_total;
                        d.set_df_property('change_display', 'options', 
                            `<div style="text-align: right; margin-top: 10px;">
                                <span style="font-size: 0.9rem; color: #666;">Change to return:</span><br>
                                <span style="font-size: 1.8rem; font-weight: bold; color: ${change >= 0 ? '#27ae60' : '#e74c3c'}">
                                    ₱${change >= 0 ? change.toFixed(2) : '0.00'}
                                </span>
                            </div>`
                        );
                    }
                },
                {
                    fieldtype: 'HTML',
                    fieldname: 'change_display',
                    options: `<div style="text-align: right; margin-top: 10px;">
                                <span style="font-size: 0.9rem; color: #666;">Change to return:</span><br>
                                <span style="font-size: 1.8rem; font-weight: bold; color: #27ae60;">₱0.00</span>
                              </div>`
                }
            ],
            primary_action_label: __('Complete Sale'),
            primary_action(values) {
                if (flt(values.amount_received) < grand_total) {
                    frappe.msgprint(__("Received amount cannot be less than the total."));
                    return;
                }

                frappe.call({
                    method: "minimart_pos.api.create_invoice",
                    args: { 
                        cart: JSON.stringify(me.cart),
                        customer: customer,
                        mode_of_payment: values.mode_of_payment,
                        amount_paid: values.amount_received
                    },
                    freeze: true,
                    callback: (r) => {
                        d.hide();
                        frappe.show_alert({message: __('Paid Successfully!'), indicator: 'green'});
                        me.cart = [];
                        me.render_cart();
                        if(me.customer_control) me.customer_control.set_value(me.shift_data.customer || "Guest");
                        me.focus_input();
                    }
                });
            }
        });

        d.show();

        setTimeout(() => {
            d.get_field('amount_received').$input.select();
        }, 400);
    }

    close_shift() {
        frappe.confirm(__('Close POS shift and reconcile?'), () => {
            frappe.call({
                method: "minimart_pos.api.close_pos_shift",
                args: { opening_entry: this.shift_data.opening_entry },
                freeze: true,
                callback: () => {
                    frappe.show_alert({message: __('Shift Closed Successfully'), indicator: 'green'});
                    location.reload();
                }
            });
        });
    }
}