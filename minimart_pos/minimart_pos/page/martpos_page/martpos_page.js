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

/**
 * Dialog to initialize a new POS Opening Entry (Shift)
 */
function show_opening_dialog(profile) {
    let d = new frappe.ui.Dialog({
        title: __('Open POS Shift'),
        fields: [
            { 
                label: __('Opening Amount'), 
                fieldname: 'amount', 
                fieldtype: 'Currency', 
                default: 0 
            }
        ],
        primary_action_label: __('Start Shift'),
        primary_action(values) {
            frappe.call({
                method: "minimart_pos.api.create_opening_entry",
                args: { 
                    pos_profile: profile, 
                    amount: values.amount 
                },
                callback: (r) => {
                    d.hide();
                    location.reload(); 
                }
            });
        }
    });
    d.show();
}

/**
 * Initializes the POS UI and Class Instance
 */
function render_pos_ui(page, shift_data) {
    $(frappe.render_template("martpos_page", {})).appendTo(page.main);
    
    window.pos_instance = new MiniMartPOS(page, shift_data);
    window.pos_instance.init();

    page.add_menu_item(__('Close Shift'), () => {
        window.pos_instance.close_shift();
    });

    page.set_secondary_action(__('Sync Stock'), () => {
        window.pos_instance.load_products();
        frappe.show_alert({message: __('Stock levels updated from server'), indicator: 'blue'});
    });
}

class MiniMartPOS {
    constructor(page, shift_data) {
        this.page = page;
        this.shift_data = shift_data;
        this.cart = [];
        this.customer_control = null;
        this.serialPort = null; 
        
        // Selectors
        this.$scan_input = $('#barcode-scan');
        this.$cart_container = $('#cart-table');
        this.$total_display = $('#grand-total');
        this.$product_grid = $('#product-grid');
        this.$recent_orders_list = $('#recent-orders-list');
    }

    init() {
        this.setup_customer_control();
        this.bind_events();
        this.load_products();
        this.load_recent_orders();
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
        // Barcode / Search Input
        this.$scan_input.on('keypress', (e) => {
            if (e.which == 13) {
                let code = this.$scan_input.val().trim();
                if (code) this.fetch_item(code);
                this.$scan_input.val('');
            }
        });

        this.$scan_input.on('input', (e) => {
            let keyword = $(e.currentTarget).val().toLowerCase();
            this.filter_products(keyword);
        });

        // Global click listener to refocus input
        $(document).on('click', (e) => {
            if (!$(e.target).closest('#barcode-scan, #customer-search-container, .awesomplete, .modal-dialog, .cart-qty-input').length) {
                setTimeout(() => this.focus_input(), 1000);
            }
        });

        $(document).on('click', '#checkout-btn', () => this.process_payment());
    }

    async trigger_cash_drawer() {
        try {
            if (!("serial" in navigator)) return;
            if (!this.serialPort) this.serialPort = await navigator.serial.requestPort();
            await this.serialPort.open({ baudRate: 9600 });
            const writer = this.serialPort.writable.getWriter();
            await writer.write(new Uint8Array([0x01])); 
            writer.releaseLock();
            await this.serialPort.close();
        } catch (err) {
            console.error("Serial Port Error:", err);
            this.serialPort = null;
        }
    }

    load_products() {
        let me = this;
        frappe.call({
            method: "minimart_pos.api.get_products",
            callback: (r) => {
                if (r.message) me.render_products(r.message);
            }
        });
    }

    render_products(products) {
        let html = products.map(item => {
            const itemJSON = JSON.stringify(item).replace(/"/g, '&quot;');
            const stockColor = item.actual_qty > 5 ? '#27ae60' : (item.actual_qty > 0 ? '#f39c12' : '#e74c3c');
            
            return `
                <div class="product-card" 
                     data-item-code="${item.item_code.toLowerCase()}" 
                     data-item-name="${item.item_name.toLowerCase()}"
                     onclick="pos_instance.add_to_cart(${itemJSON})">
                    <div class="product-image">
                        <span class="stock-badge" style="background: ${stockColor};">
                            ${Math.floor(item.actual_qty)}
                        </span>
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

    filter_products(keyword) {
        this.$product_grid.find('.product-card').each(function() {
            let name = $(this).attr('data-item-name') || "";
            let code = $(this).attr('data-item-code') || "";
            if (name.includes(keyword) || code.includes(keyword)) $(this).show();
            else $(this).hide();
        });
    }

    fetch_item(barcode) {
        frappe.call({
            method: "minimart_pos.api.get_item_by_barcode",
            args: { barcode: barcode },
            callback: (r) => {
                if (r.message) {
                    this.add_to_cart(r.message);
                    frappe.utils.play_sound("submit");
                    this.$scan_input.val(''); 
                    this.filter_products(''); 
                } else {
                    frappe.show_alert({message: __('Item not found'), indicator: 'red'});
                    frappe.utils.play_sound("error");
                }
                this.focus_input();
            }
        });
    }

    add_to_cart(item) {
        let $card = $(`.product-card[data-item-code="${item.item_code.toLowerCase()}"]`);
        let $badge = $card.find('.stock-badge');
        let current_stock = parseFloat($badge.text());

        if (current_stock <= 0) {
            frappe.show_alert({message: __('Out of stock!'), indicator: 'red'});
            return;
        }

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

        // Update UI Badge
        let new_stock = current_stock - 1;
        $badge.text(new_stock);
        $badge.css('background', new_stock > 5 ? '#27ae60' : (new_stock > 0 ? '#f39c12' : '#e74c3c'));

        this.render_cart();
    }

    update_qty(index, delta) {
        let item = this.cart[index];
        let $card = $(`.product-card[data-item-code="${item.item_code.toLowerCase()}"]`);
        let $badge = $card.find('.stock-badge');
        let current_stock = parseFloat($badge.text());

        if (delta > 0 && current_stock <= 0) {
            frappe.show_alert({message: __('No more stock'), indicator: 'orange'});
            return;
        }

        item.qty = flt(item.qty) + delta;
        
        // Restore/Deduct Badge
        let new_stock = current_stock - delta;
        $badge.text(new_stock);
        $badge.css('background', new_stock > 5 ? '#27ae60' : (new_stock > 0 ? '#f39c12' : '#e74c3c'));

        if (item.qty <= 0) {
            this.remove_item(index, false);
        } else {
            this.render_cart();
        }
    }

    manual_qty_update(index, value) {
        let item = this.cart[index];
        let old_qty = item.qty;
        let new_qty = flt(value);
        let diff = new_qty - old_qty;

        let $card = $(`.product-card[data-item-code="${item.item_code.toLowerCase()}"]`);
        let $badge = $card.find('.stock-badge');
        let current_stock = parseFloat($badge.text());

        if (diff > current_stock) {
            frappe.show_alert({message: __('Insufficient Stock'), indicator: 'orange'});
            this.render_cart(); 
            return;
        }

        item.qty = new_qty;
        let new_stock = current_stock - diff;
        $badge.text(new_stock);
        $badge.css('background', new_stock > 5 ? '#27ae60' : (new_stock > 0 ? '#f39c12' : '#e74c3c'));

        if (item.qty <= 0) {
            this.remove_item(index, false);
        } else {
            this.render_cart();
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
                    <input type="number" step="any" class="cart-qty-input" value="${item.qty}" onchange="pos_instance.manual_qty_update(${index}, this.value)">
                    <button onclick="pos_instance.update_qty(${index}, 1)" class="btn-qty">+</button>
                </div>
                <div class="item-total">₱<span>${(item.qty * item.price).toFixed(2)}</span></div>
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

    remove_item(index, reload = true) {
        let item = this.cart[index];
        let $card = $(`.product-card[data-item-code="${item.item_code.toLowerCase()}"]`);
        let $badge = $card.find('.stock-badge');
        
        if ($badge.length) {
            let restored_stock = parseFloat($badge.text()) + item.qty;
            $badge.text(restored_stock);
            $badge.css('background', restored_stock > 5 ? '#27ae60' : (restored_stock > 0 ? '#f39c12' : '#e74c3c'));
        }

        this.cart.splice(index, 1);
        this.render_cart();
        this.focus_input();
    }

    update_total() {
        let total = this.cart.reduce((sum, i) => sum + (i.qty * i.price), 0);
        this.$total_display.text(total.toFixed(2));
    }

    load_recent_orders() {
        let me = this;
        frappe.call({
            method: "minimart_pos.api.get_recent_invoices", 
            args: { opening_entry: this.shift_data.opening_entry },
            callback: (r) => { if (r.message) me.render_recent_orders(r.message); }
        });
    }

    render_recent_orders(orders) {
        if (!orders.length) {
            this.$recent_orders_list.html('<div class="text-center p-2 text-muted">No recent orders</div>');
            return;
        }

        let html = orders.map(order => `
            <div class="recent-order-item">
                <div class="d-flex justify-content-between" onclick="pos_instance.view_past_order('${order.name}')" style="cursor:pointer; flex-grow:1;">
                    <span class="order-id">#${order.name.split('-').pop()}</span>
                    <span class="order-total">₱${flt(order.grand_total).toFixed(2)}</span>
                </div>
                <div class="d-flex justify-content-between align-items-center mt-1">
                    <span class="order-customer text-muted" style="font-size: 10px;">${order.customer}</span>
                    <button class="btn btn-xs btn-danger" onclick="pos_instance.void_transaction('${order.name}')">${__('Void')}</button>
                </div>
            </div>
        `).join('');
        this.$recent_orders_list.html(html);
    }

    void_transaction(invoice_name) {
        let me = this;
        frappe.confirm(__('Void order {0}?', [invoice_name]), () => {
            frappe.call({
                method: "minimart_pos.api.void_invoice",
                args: { invoice_name: invoice_name },
                callback: (r) => {
                    if (r.message) {
                        r.message.forEach(item => {
                            let $badge = $(`.product-card[data-item-code="${item.item_code.toLowerCase()}"] .stock-badge`);
                            if ($badge.length) {
                                let restored = parseFloat($badge.text()) + item.qty;
                                $badge.text(restored).css('background', restored > 5 ? '#27ae60' : (restored > 0 ? '#f39c12' : '#e74c3c'));
                            }
                        });
                        this.load_recent_orders();
                        frappe.show_alert({message: __('Voided Successfully'), indicator: 'green'});
                    }
                }
            });
        });
    }

    view_past_order(invoice_name) {
        if (invoice_name) frappe.set_route("Form", "POS Invoice", invoice_name);
    }

    process_payment() {
        let me = this;
        let grand_total = flt(this.$total_display.text());
        if (!this.cart.length) return;

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
                        let $change_val = d.get_field('change_display').$wrapper.find('.change-val');
                        
                        $change_val.text('₱' + (change >= 0 ? change.toFixed(2) : '0.00'));
                        $change_val.css('color', change >= 0 ? '#27ae60' : '#e74c3c');
                    }
                },
                { 
                    fieldtype: 'HTML', 
                    fieldname: 'change_display', 
                    options: `
                        <div class="text-right mt-2">
                            <span class="text-muted">Change:</span><br>
                            <span class="change-val" style="font-size: 1.8rem; font-weight: bold; color: #27ae60;">₱0.00</span>
                        </div>
                    ` 
                }
            ],
            primary_action_label: __('Complete Sale'),
            primary_action(values) {
                if (flt(values.amount_received) < grand_total) {
                    frappe.msgprint(__("Insufficient amount received."));
                    return;
                }

                frappe.call({
                    method: "minimart_pos.api.create_invoice",
                    args: { 
                        cart: JSON.stringify(me.cart),
                        customer: me.customer_control ? me.customer_control.get_value() : "Guest",
                        mode_of_payment: values.mode_of_payment,
                        amount_paid: values.amount_received
                    },
                    freeze: true,
                    callback: (r) => {
                        me.trigger_cash_drawer();
                        d.hide();
                        let change = flt(values.amount_received) - grand_total;
                        me.print_receipt(r.message, [...me.cart], grand_total, flt(values.amount_received), change);
                        
                        frappe.show_alert({message: __('Paid Successfully!'), indicator: 'green'});
                        
                        me.cart = [];
                        me.render_cart();
                        me.load_recent_orders();
                        me.focus_input();
                    }
                });
            }
        });
        d.show();
        // Auto-select amount received for quick typing
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
                    table { width: 100%; }
                    .flex { display: flex; justify-content: space-between; }
                </style>
            </head>
            <body onload="window.print(); window.close();">
                <div class="center">
                    <h3 style="margin:0;">${this.shift_data.company}</h3>
                    <p>OFFICIAL RECEIPT</p>
                </div>
                <div class="hr"></div>
                <div>Invoice: ${name}</div>
                <div class="hr"></div>
                <table>
                    ${cart.map(i => `
                        <tr>
                            <td>${i.item_name}</td>
                            <td align="right">${i.qty} x ${i.price.toFixed(2)}</td>
                            <td align="right">₱${(i.qty * i.price).toFixed(2)}</td>
                        </tr>
                    `).join('')}
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

    close_shift() {
        frappe.confirm(__('Close shift?'), () => {
            frappe.call({
                method: "minimart_pos.api.close_pos_shift",
                args: { opening_entry: this.shift_data.opening_entry },
                callback: () => location.reload()
            });
        });
    }
}