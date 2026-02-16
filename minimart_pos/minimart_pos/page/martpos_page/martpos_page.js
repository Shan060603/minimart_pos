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
        this.last_transaction = null; 
        this.customer_control = null;
        
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
        // Handle Enter key for Barcodes
        this.$scan_input.on('keypress', (e) => {
            if (e.which == 13) {
                let code = this.$scan_input.val().trim();
                if (code) this.fetch_item(code);
                this.$scan_input.val('');
            }
        });

        // NEW: Real-time filtering as you type
        this.$scan_input.on('input', (e) => {
            let keyword = $(e.currentTarget).val().toLowerCase();
            this.filter_products(keyword);
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
                <div class="product-card" data-item-name="${item.item_name.toLowerCase()}" data-item-code="${item.item_code.toLowerCase()}" onclick="pos_instance.add_to_cart(${itemJSON})">
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

    // NEW: Logic to hide/show cards based on search
    filter_products(keyword) {
        this.$product_grid.find('.product-card').each(function() {
            let name = $(this).data('item-name');
            let code = $(this).data('item-code');
            
            if (name.includes(keyword) || code.includes(keyword)) {
                $(this).show();
            } else {
                $(this).hide();
            }
        });

        if (this.$product_grid.find('.product-card:visible').length === 0) {
            if (!$('.no-search-results').length) {
                this.$product_grid.append('<div class="no-search-results p-5 text-center text-muted">No matching items found</div>');
            }
        } else {
            $('.no-search-results').remove();
        }
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
            existing.qty = flt(existing.qty) + 1;
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

    manual_qty_update(index, value) {
        let val = flt(value);
        if (val <= 0) {
            this.remove_item(index);
        } else {
            this.cart[index].qty = val;
            this.update_total();
            let row_total = (this.cart[index].qty * this.cart[index].price).toFixed(2);
            $(`.cart-row[data-index="${index}"] .item-total-val`).text(row_total);
        }
    }

    render_cart() {
        let html = this.cart.map((item, index) => `
            <div class="cart-row" data-index="${index}">
                <div class="item-meta">
                    <div class="item-name">${item.item_name || item.item_code}</div>
                    <div class="item-price">₱${item.price.toFixed(2)}</div>
                </div>
                
                <div class="qty-controls">
                    <button onclick="pos_instance.update_qty(${index}, -1)" class="btn-qty">-</button>
                    <input type="number" step="any" class="cart-qty-input" 
                        value="${item.qty}" 
                        onchange="pos_instance.manual_qty_update(${index}, this.value)">
                    <button onclick="pos_instance.update_qty(${index}, 1)" class="btn-qty">+</button>
                </div>

                <div class="item-total">
                    ₱<span class="item-total-val">${(item.qty * item.price).toFixed(2)}</span>
                </div>
                
                <button onclick="pos_instance.remove_item(${index})" class="btn-remove">×</button>
            </div>
        `).join('');

        if (this.cart.length === 0) {
            html = `<div class="empty-cart-msg">${__('No items in cart')}</div>`;
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
                { label: __('Total Payable'), fieldname: 'total_payable', fieldtype: 'Currency', default: grand_total, read_only: 1 },
                { label: __('Mode of Payment'), fieldname: 'mode_of_payment', fieldtype: 'Select', 
                  options: me.shift_data.payment_methods || ['Cash'], 
                  default: me.shift_data.payment_methods ? me.shift_data.payment_methods[0] : 'Cash' },
                { label: __('Amount Received'), fieldname: 'amount_received', fieldtype: 'Currency', default: grand_total,
                  onchange: function() {
                        let received = flt(this.get_value());
                        let change = received - grand_total;
                        d.set_df_property('change_display', 'options', 
                            `<div class="text-right mt-2">
                                <span class="text-muted">Change to return:</span><br>
                                <span style="font-size: 1.8rem; font-weight: bold; color: ${change >= 0 ? '#27ae60' : '#e74c3c'}">
                                    ₱${change >= 0 ? change.toFixed(2) : '0.00'}
                                </span>
                            </div>`
                        );
                  }
                },
                { fieldtype: 'HTML', fieldname: 'change_display', 
                  options: `<div class="text-right mt-2"><span class="text-muted">Change to return:</span><br><span style="font-size: 1.8rem; font-weight: bold; color: #27ae60;">₱0.00</span></div>` }
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
                        let change = flt(values.amount_received) - grand_total;
                        
                        me.last_transaction = {
                            name: r.message,
                            cart: [...me.cart],
                            total: grand_total,
                            paid: flt(values.amount_received),
                            change: change,
                            customer: customer
                        };

                        me.print_receipt(r.message, me.last_transaction.cart, grand_total, flt(values.amount_received), change);
                        
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
        setTimeout(() => d.get_field('amount_received').$input.select(), 400);
    }

    print_receipt(name, cart, total, paid, change) {
        let print_window = window.open('', 'PRINT', 'height=600,width=400');
        let receipt_html = `
            <html>
            <head>
                <style>
                    body { font-family: 'Courier New', monospace; width: 300px; font-size: 12px; padding: 10px; }
                    .center { text-align: center; }
                    .hr { border-bottom: 1px dashed #000; margin: 5px 0; }
                    table { width: 100%; border-collapse: collapse; }
                    .flex { display: flex; justify-content: space-between; }
                </style>
            </head>
            <body onload="window.print(); window.close();">
                <div class="center">
                    <h3 style="margin:0;">${this.shift_data.company}</h3>
                    <p>OFFICIAL RECEIPT</p>
                </div>
                <div class="hr"></div>
                <div>Inv: ${name}</div>
                <div>Date: ${frappe.datetime.now_datetime()}</div>
                <div class="hr"></div>
                <table>
                    ${cart.map(i => `<tr><td>${i.item_name}</td><td align="right">${i.qty} x ${i.price.toFixed(2)}</td><td align="right">₱${(i.qty * i.price).toFixed(2)}</td></tr>`).join('')}
                </table>
                <div class="hr"></div>
                <div class="flex"><strong>TOTAL:</strong><strong>₱${total.toFixed(2)}</strong></div>
                <div class="flex"><span>PAID:</span><span>₱${paid.toFixed(2)}</span></div>
                <div class="flex"><span>CHANGE:</span><span>₱${change.toFixed(2)}</span></div>
                <div class="hr"></div>
                <div class="center"><p>THANK YOU!</p></div>
            </body>
            </html>
        `;
        print_window.document.write(receipt_html);
        print_window.document.close();
    }

    reprint_last() {
        if (!this.last_transaction) {
            frappe.show_alert({message: __("No recent transaction found"), indicator: 'orange'});
            return;
        }
        let lt = this.last_transaction;
        this.print_receipt(lt.name, lt.cart, lt.total, lt.paid, lt.change);
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