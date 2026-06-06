// ============================================================
// ULTIMATE DEE ELECTRICALS - app.js v1.0
// Security: role-based access, session tokens, auto-logout,
//           Supabase login, branch enforcement
// ============================================================

// ---- CONSTANTS ----
const APP_NAME = 'ULTIMATE DEE ELECTRICALS';

const INACTIVITY_MS      = 5 * 60 * 1000;
const WARNING_MS         = 60 * 1000;
const MAX_FAILED_LOGINS  = 5;
const LOCKOUT_MS         = 15 * 60 * 1000;
const TEMP_PW_EXPIRY_MS  = 24 * 60 * 60 * 1000;

const BRANCHES = [
  'Techiman Ahmadiyya Road',
  'Techiman Zongo Traffic',
  'Kintampo'
];

const WAREHOUSE_LOCATION = 'Warehouse';

const STORAGE = {
  users: 'ude_users',
  products: 'ude_products',
  invoices: 'ude_invoices',
  customers: 'ude_customers',
  suppliers: 'ude_suppliers',
  stockhistory: 'ude_stockhistory',
  audit: 'ude_audit',
  invoiceSeq: 'ude_invoice_seq',
  sessions: 'ude_sessions',
  token: 'ude_token',
  allowAutoLogin: 'ude_allow_auto_login'
};

// ---- STATE ----
let currentUser       = null;
let currentLocation   = 'All';
let editingProductId  = null;
let viewingInvoiceId  = null;
let lineItemCount     = 0;
let invoiceSaving     = false;
let inactivityTimer   = null;
let warningTimer      = null;
let countdownInterval = null;
let _lastTempPw       = '';

// ---- LOCAL STORAGE ----
const LS = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: k => localStorage.removeItem(k),
};

const SS = {
  get: k => { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => sessionStorage.setItem(k, JSON.stringify(v)),
  del: k => sessionStorage.removeItem(k),
};

// ---- HASH ----
function hashPw(pw) {
  let h = 5381;
  for (let i = 0; i < pw.length; i++) h = ((h << 5) + h) ^ pw.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, '0');
}

function legacyHashPw(pw) {
  let h = 0;
  for (let i = 0; i < pw.length; i++) h = ((h << 5) - h + pw.charCodeAt(i)) | 0;
  return h.toString(16);
}

function genToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2,'0'))
    .join('');
}

function normalizeUser(user, index) {
  const username = String(user.username || '').trim().toLowerCase();

  const allowedRoles = ['admin', 'manager', 'cashier', 'staff', 'warehouse_manager', 'warehouse_staff'];
  const role = allowedRoles.includes(user.role) ? user.role : 'staff';

  let location = user.location || BRANCHES[0];

  if (role === 'admin') location = 'All';
  if (role === 'warehouse_manager' || role === 'warehouse_staff') location = WAREHOUSE_LOCATION;

  return {
    id: user.id || (username === 'admin' ? 'u_admin' : 'u_' + (username || index)),
    username,
    fullName: user.fullName || (
      username === 'admin'
        ? 'System Administrator'
        : username.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    ),
    passwordHash: user.passwordHash || null,
    role,
    location,
    active: user.active !== false,
    mustChangePassword: !!user.mustChangePassword,
    tempPasswordExpiry: user.tempPasswordExpiry || null,
    failedLogins: user.failedLogins || 0,
    lockedUntil: user.lockedUntil || null,
    createdAt: user.createdAt || Date.now(),
    createdBy: user.createdBy || 'system',
    lastLogin: user.lastLogin || null,
  };
}

function ensureUsers() {
  let users = LS.get(STORAGE.users);

  if (!Array.isArray(users)) {
    users = [];
  } else {
    users = users.map(normalizeUser).filter(u => u.username);
  }

  LS.set(STORAGE.users, users);
}

function safeSetHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

let paymentSearch = '';

function renderPayments() {
  let invoices = filterByLoc(getInvoices())
    .filter(i => i.status === 'paid' && i.payMethod);

  if (paymentSearch) {
    const q = paymentSearch.toLowerCase();

    invoices = invoices.filter(i =>
      String(i.number || '').toLowerCase().includes(q) ||
      String(i.customerName || '').toLowerCase().includes(q) ||
      String(i.payMethod || '').toLowerCase().includes(q)
    );
  }

  const tbody = document.getElementById('payments-body');
  if (!tbody) return;

  tbody.innerHTML = invoices.length === 0
    ? '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--gray-400)">No payment records yet</td></tr>'
    : invoices.map(i =>
        '<tr>' +
          '<td class="mono">' + fmtDateTime(i.createdAt) + '</td>' +
          '<td class="mono">' + escapeHtml(i.number) + '</td>' +
          '<td>' + escapeHtml(i.customerName || "—") + '</td>' +
          '<td>' + paymentLabel(i.payMethod) + '</td>' +
          '<td class="mono">' + fmtGHS(i.total || 0) + '</td>' +
          '<td>' + escapeHtml(i.momoNumber || "—") + '</td>' +
          '<td>' + escapeHtml(i.createdByName || "Admin") + '</td>' +
        '</tr>'
      ).join('');
}

function filterPayments(val) {
  paymentSearch = val;
  renderPayments();
}

let supplierSearch = '';

function renderSuppliers() {
  let suppliers = getSuppliers();

  if (supplierSearch) {
    const q = supplierSearch.toLowerCase();
    suppliers = suppliers.filter(s =>
      String(s.name || '').toLowerCase().includes(q) ||
      String(s.phone || '').toLowerCase().includes(q) ||
      String(s.location || '').toLowerCase().includes(q)
    );
  }

  const tbody = document.getElementById('suppliers-body');
  if (!tbody) return;

  tbody.innerHTML = suppliers.length === 0
    ? '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--gray-400)">No suppliers yet</td></tr>'
    : suppliers.map(s =>
        '<tr>' +
          '<td style="font-weight:600">' + escapeHtml(s.name) + '</td>' +
          '<td>' + escapeHtml(s.phone || '—') + '</td>' +
          '<td>' + escapeHtml(s.location || '—') + '</td>' +
          '<td class="mono">' + fmtGHS(s.totalPurchases || 0) + '</td>' +
          '<td class="mono">' + fmtGHS(s.balance || 0) + '</td>' +
          '<td>' + escapeHtml(s.notes || '—') + '</td>' +
        '</tr>'
      ).join('');
}

function filterSuppliers(val) {
  supplierSearch = val;
  renderSuppliers();
}

function openSupplierModal() {
  document.getElementById('supplier-name').value = '';
  document.getElementById('supplier-phone').value = '';
  document.getElementById('supplier-location').value = '';
  document.getElementById('supplier-notes').value = '';

  openModal('supplier-modal');
}

function openPurchaseModal() {

  const supplierSelect =
    document.getElementById('purchase-supplier');

  const suppliers = getSuppliers();

  supplierSelect.innerHTML =
    suppliers.map(s =>
      `<option value="${s.name}">
        ${s.name}
      </option>`
    ).join('');

  document.getElementById('purchase-items').innerHTML = '';

  addPurchaseItem();

  openModal('purchase-modal');
}

function addPurchaseItem() {

  const box = document.getElementById('purchase-items');

  const row = document.createElement('div');

  row.className = 'grid-4';

  row.style.marginBottom = '10px';

  row.innerHTML = `
    <input class="form-input purchase-name"
      placeholder="Product">

    <input class="form-input purchase-qty"
      type="number"
      placeholder="Qty">

    <input class="form-input purchase-price"
      type="number"
      placeholder="Price">

    <button class="btn btn-danger"
      onclick="this.parentElement.remove()">
      Remove
    </button>
  `;

  box.appendChild(row);
}

async function savePurchase() {

  const supplierName =
    document.getElementById('purchase-supplier').value;

  const location =
    document.getElementById('purchase-location').value;

  const invoiceNumber =
    document.getElementById('purchase-invoice').value.trim();

  const status =
    document.getElementById('purchase-status').value;

  const notes =
    document.getElementById('purchase-notes').value.trim();

  const rows =
    document.querySelectorAll('#purchase-items .grid-4');

  const items = [];

  let total = 0;

  rows.forEach(r => {

    const inputs = r.querySelectorAll('input');

    const name = inputs[0].value.trim();
    const qty = Number(inputs[1].value || 0);
    const price = Number(inputs[2].value || 0);

    if (!name || qty <= 0 || price <= 0) return;

    items.push({
      name,
      qty,
      price,
      total: qty * price
    });

    total += qty * price;
  });

  if (items.length === 0) {
    toast('Add at least one item', 'error');
    return;
  }

  const purchase = {
    id: 'pur_' + Date.now(),
    supplierName,
    invoiceNumber,
    location,
    status,
    notes,
    items,
    total,
    createdBy: currentUser.id,
    createdByName: currentUser.fullName,
    createdAt: Date.now()
  };

  const purchases = getPurchases();

  purchases.unshift(purchase);

  LS.set(STORAGE.purchases, purchases);

  addAudit(
    'Purchase Created',
    currentUser.fullName +
      ' created purchase from "' +
      supplierName +
      '"'
  );

  closeModal('purchase-modal');

  toast('Purchase saved');

  renderPurchases();
}
function getPurchases() {
  return LS.get(STORAGE.purchases) || [];
}



let purchaseSearch = '';

function filterPurchases(val) {
  purchaseSearch = val;
  renderPurchases();
}

function renderPurchases() {
  let purchases = getPurchases();

  purchases.sort((a, b) => asTimestamp(b.createdAt) - asTimestamp(a.createdAt));

  if (purchaseSearch) {
    const q = purchaseSearch.toLowerCase();

    purchases = purchases.filter(p =>
      String(p.supplierName || '').toLowerCase().includes(q) ||
      String(p.invoiceNumber || '').toLowerCase().includes(q) ||
      String(p.location || '').toLowerCase().includes(q)
    );
  }

  const body = document.getElementById('purchases-body');

  if (!body) return;

  body.innerHTML =
    purchases.length === 0
      ? `
        <tr>
          <td colspan="8" style="text-align:center;padding:40px;color:var(--gray-400)">
            No purchases yet
          </td>
        </tr>
      `
      : purchases.map(p => `
        <tr>
          <td>${fmtDate(p.createdAt)}</td>
          <td>${escapeHtml(p.invoiceNumber || '-')}</td>
          <td>${escapeHtml(p.supplierName || '-')}</td>
          <td>${escapeHtml(p.location || '-')}</td>
          <td>${fmtGHS(p.total || 0)}</td>
          <td>${statusBadge(p.status || 'paid')}</td>
          <td>${escapeHtml(p.createdByName || '-')}</td>
          <td>
            <button class="btn btn-secondary btn-sm"
              onclick="viewPurchase('${p.id}')">
              View
            </button>
          </td>
        </tr>
      `).join('');
}

function renderWarehouse() {
  safeSetHTML('warehouse-body',
    '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--gray-400)">Warehouse module coming soon</td></tr>'
  );
}

function renderReports() {
  const invoices = filterByLoc(getInvoices());

  const now = new Date();
  const today = startOfLocalDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const todayInvs = invoices.filter(i => asTimestamp(i.createdAt) >= today);
  const weekInvs = invoices.filter(i => asTimestamp(i.createdAt) >= weekStart);
  const monthInvs = invoices.filter(i => asTimestamp(i.createdAt) >= monthStart);
  const creditInvs = invoices.filter(i => i.status === 'pending' || i.status === 'partial');

  document.getElementById('rep-today').textContent = fmtGHS(sumInvoiceTotal(todayInvs));
  document.getElementById('rep-week').textContent = fmtGHS(sumInvoiceTotal(weekInvs));
  document.getElementById('rep-month').textContent = fmtGHS(sumInvoiceTotal(monthInvs));
  document.getElementById('rep-alltime').textContent = fmtGHS(sumInvoiceTotal(invoices));
  document.getElementById('rep-credit').textContent = fmtGHS(sumInvoiceTotal(creditInvs));

  renderPaymentBreakdown(invoices);
  renderLocationBreakdown(invoices);
  renderTopProducts(invoices);
  renderMonthlyChart(invoices);
}

function renderPaymentBreakdown(invoices) {
  const paid = invoices.filter(i => i.status === 'paid');

  const cash = paid.filter(i => i.payMethod === 'cash').reduce((s, i) => s + Number(i.total || 0), 0);
  const momo = paid.filter(i => i.payMethod === 'momo').reduce((s, i) => s + Number(i.total || 0), 0);
  const bank = paid.filter(i => i.payMethod === 'bank').reduce((s, i) => s + Number(i.total || 0), 0);
  const credit = invoices.filter(i => i.status === 'pending' || i.status === 'partial').reduce((s, i) => s + Number(i.total || 0), 0);

  const el = document.getElementById('payment-breakdown');
  if (!el) return;

  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;padding:8px 0"><span>Cash</span><strong>' + fmtGHS(cash) + '</strong></div>' +
    '<div style="display:flex;justify-content:space-between;padding:8px 0"><span>Mobile Money</span><strong>' + fmtGHS(momo) + '</strong></div>' +
    '<div style="display:flex;justify-content:space-between;padding:8px 0"><span>Bank Transfer</span><strong>' + fmtGHS(bank) + '</strong></div>' +
    '<div style="display:flex;justify-content:space-between;padding:8px 0"><span>Credit / Pending</span><strong>' + fmtGHS(credit) + '</strong></div>';
}

function renderLocationBreakdown(invoices) {
  const branches = [
    'Techiman Ahmadiyya Road',
    'Techiman Zongo Traffic',
    'Kintampo'
  ];

  const el = document.getElementById('location-breakdown');
  if (!el) return;

  el.innerHTML = branches.map(branch => {
    const total = invoices
      .filter(i => i.location === branch)
      .reduce((s, i) => s + Number(i.total || 0), 0);

    return '<div style="display:flex;justify-content:space-between;padding:8px 0">' +
      '<span>' + escapeHtml(branch) + '</span>' +
      '<strong>' + fmtGHS(total) + '</strong>' +
    '</div>';
  }).join('');
}

function renderTopProducts(invoices) {
  const totals = {};

  invoices.forEach(inv => {
    (inv.items || []).forEach(item => {
      const name = item.name || 'Unknown';
      if (!totals[name]) {
        totals[name] = { qty: 0, total: 0 };
      }

      totals[name].qty += Number(item.qty || 0);
      totals[name].total += Number(item.total || (Number(item.qty || 0) * Number(item.price || 0)));
    });
  });

  const top = Object.entries(totals)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const el = document.getElementById('top-products');
  if (!el) return;

  el.innerHTML = top.length === 0
    ? '<div style="padding:24px;text-align:center;color:var(--gray-400)">No product sales yet</div>'
    : top.map(p =>
        '<div style="display:flex;justify-content:space-between;padding:8px 0">' +
          '<span>' + escapeHtml(p.name) + ' <small style="color:var(--gray-400)">x' + p.qty + '</small></span>' +
          '<strong>' + fmtGHS(p.total) + '</strong>' +
        '</div>'
      ).join('');
}

function renderMonthlyChart(invoices) {
  const now = new Date();
  const months = [];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);

    const total = invoices
      .filter(inv => {
        const t = asTimestamp(inv.createdAt);
        return t >= start && t < end;
      })
      .reduce((s, inv) => s + Number(inv.total || 0), 0);

    months.push({
      label: d.toLocaleDateString('en', { month: 'short' }),
      total
    });
  }

  const max = Math.max(...months.map(m => m.total), 1);
  const el = document.getElementById('monthly-chart');
  if (!el) return;

  el.innerHTML = months.map(m => {
    const h = Math.round((m.total / max) * 120);

    return '<div class="chart-bar-wrap">' +
      '<div style="font-size:9px;color:var(--gray-400);font-family:var(--font-mono)">' +
        (m.total > 0 ? 'GH₵' + Math.round(m.total) : '') +
      '</div>' +
      '<div class="chart-bar" style="height:' + h + 'px"></div>' +
      '<div class="chart-bar-label">' + m.label + '</div>' +
    '</div>';
  }).join('');
}


let auditSearch = '';

function renderAuditLog() {
  let logs = LS.get(STORAGE.audit) || [];

  logs.sort((a, b) => asTimestamp(b.createdAt) - asTimestamp(a.createdAt));

  if (auditSearch) {
    const q = auditSearch.toLowerCase();

    logs = logs.filter(l =>
      String(l.action || '').toLowerCase().includes(q) ||
      String(l.detail || '').toLowerCase().includes(q) ||
      String(l.byName || l.by || '').toLowerCase().includes(q)
    );
  }

  const box = document.getElementById('audit-list');
  if (!box) return;

  box.innerHTML = logs.length === 0
    ? '<div style="padding:40px;text-align:center;color:var(--gray-400)">No audit logs yet</div>'
    : logs.map(l =>
        '<div class="card" style="margin-bottom:10px">' +
          '<div style="padding:12px">' +
            '<div style="font-weight:600;font-size:13px">' + escapeHtml(l.action) + '</div>' +
            '<div style="font-size:12px;color:var(--gray-500);margin-top:4px">' +
              escapeHtml(l.detail) +
            '</div>' +
            '<div style="font-size:11px;color:var(--gray-400);margin-top:6px;font-family:var(--font-mono)">' +
              fmtDateTime(l.createdAt) +
              ' • ' +
              escapeHtml(l.byName || l.by || 'System') +
            '</div>' +
          '</div>' +
        '</div>'
      ).join('');
}

function filterAudit(val) {
  auditSearch = val;
  renderAuditLog();
}

function renderUsers() {
  safeSetHTML('users-body',
    '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--gray-400)">User management module coming soon</td></tr>'
  );
}

function renderSessionsPanel() {
  // placeholder
}

function openCreateUserModal() {
  toast('User management module coming soon');
}



function openSupplierModal() {
  const name = prompt('Supplier name:');
  if (!name) return;

  const phone = prompt('Phone number:') || '';
  const location = prompt('Location:') || '';
  const notes = prompt('Notes:') || '';

  const suppliers = getSuppliers();

  suppliers.unshift({
    id: 'sup_' + Date.now(),
    name,
    phone,
    location,
    notes,
    totalPurchases: 0,
    balance: 0,
    createdAt: Date.now()
  });

  LS.set(STORAGE.suppliers, suppliers);

  addAudit('Supplier Added', currentUser.fullName + ' added supplier "' + name + '"');

  toast('Supplier added');
  renderSuppliers();
}

async function saveSupplier() {
  const name = document.getElementById('supplier-name').value.trim();
  const phone = document.getElementById('supplier-phone').value.trim();
  const location = document.getElementById('supplier-location').value.trim();
  const notes = document.getElementById('supplier-notes').value.trim();

  if (!name) {
    toast('Supplier name is required', 'error');
    return;
  }

  if (window.LumodaSupabase && window.LumodaSupabase.isConfigured()) {
    try {
      const res = await window.LumodaSupabase.createSupplier({
        name,
        phone,
        location,
        notes
      });

      if (res.error) throw res.error;

      await syncSupabaseCache();

      addAudit(
        'Supplier Added',
        currentUser.fullName + ' added supplier "' + name + '"'
      );

      closeModal('supplier-modal');
      toast('Supplier added');
      renderSuppliers();
      return;
    } catch (err) {
      console.error(err);
      toast(err.message || 'Could not save supplier', 'error');
      return;
    }
  }

  const suppliers = getSuppliers();

  suppliers.unshift({
    id: 'sup_' + Date.now(),
    name,
    phone,
    location,
    notes,
    totalPurchases: 0,
    balance: 0,
    createdAt: Date.now()
  });

  LS.set(STORAGE.suppliers, suppliers);

  addAudit(
    'Supplier Added',
    currentUser.fullName + ' added supplier "' + name + '"'
  );

  closeModal('supplier-modal');
  toast('Supplier added');
  renderSuppliers();
}

function openWarehouseProductModal() {
  toast('Warehouse products module coming soon');
}

let customerSearch = '';

function renderCustomers() {
  let customers = filterByLoc(getCustomers());
  const invoices = getInvoices();

  if (customerSearch) {
    const q = customerSearch.toLowerCase();
    customers = customers.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q) ||
      (c.location || '').toLowerCase().includes(q)
    );
  }

  const tbody = document.getElementById('customers-body');
  if (!tbody) return;

  tbody.innerHTML = customers.length === 0
    ? '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:40px">No customers yet</td></tr>'
    : customers.map(c => {
        const invs = invoices.filter(i =>
          i.customerName &&
          i.customerName.toLowerCase() === c.name.toLowerCase() &&
          i.location === c.location
        );

        const totalSpent = invs.reduce((s, i) => s + Number(i.total || 0), 0);
        const debt = invs
          .filter(i => i.status === 'pending' || i.status === 'partial')
          .reduce((s, i) => s + Number(i.total || 0), 0);

        return '<tr>' +
          '<td style="font-weight:500">' + escapeHtml(c.name) + '</td>' +
          '<td>' + escapeHtml(c.phone || '—') + '</td>' +
          '<td><span class="badge badge-neutral">' + escapeHtml(c.location || '—') + '</span></td>' +
          '<td class="mono">' + invs.length + '</td>' +
          '<td class="mono">' + fmtGHS(totalSpent) + '</td>' +
          '<td class="mono" style="color:' + (debt > 0 ? '#dc2626' : '#16a34a') + '">' + fmtGHS(debt) + '</td>' +
          '<td class="mono">' + fmtDate(c.createdAt || Date.now()) + '</td>' +
        '</tr>';
      }).join('');
}

function filterCustomers(val) {
  customerSearch = val;
  renderCustomers();
}

function saveCustomerIfNew(name, phone, address, location) {
  const customers = LS.get(STORAGE.customers) || [];

  const existing = customers.find(c =>
    c.name.toLowerCase() === name.toLowerCase() &&
    c.location === location
  );

  if (!existing) {
    customers.unshift({
      id: 'cust_' + Date.now(),
      name,
      phone: phone || '',
      address: address || '',
      location,
      createdAt: Date.now()
    });

    LS.set(STORAGE.customers, customers);
  }
}

function suggestCustomers() {
  // later we can add customer autocomplete here
}

function openCustomerModal() {
  toast('Customer modal not connected yet. Customers are auto-created when you create invoices.');
}



// ============================================================
// DATA INIT
// ============================================================
function initData() {
  if (!LS.get(STORAGE.products)) {
    LS.set(STORAGE.products, [
      {
        id:'p1',
        name:'2.5mm Cable',
        sku:'CAB-2.5MM',
        category:'Cables',
        price:650,
        stockAhmadiyya:20,
        stockZongo:15,
        stockKintampo:10,
        stockWarehouse:50,
        reorder:5
      },
      {
        id:'p2',
        name:'1.5mm Cable',
        sku:'CAB-1.5MM',
        category:'Cables',
        price:480,
        stockAhmadiyya:25,
        stockZongo:18,
        stockKintampo:12,
        stockWarehouse:60,
        reorder:5
      },
      {
        id:'p3',
        name:'13A Socket',
        sku:'SOC-13A',
        category:'Sockets',
        price:35,
        stockAhmadiyya:40,
        stockZongo:30,
        stockKintampo:25,
        stockWarehouse:100,
        reorder:10
      },
      {
        id:'p4',
        name:'Switch',
        sku:'SWT-001',
        category:'Switches',
        price:25,
        stockAhmadiyya:45,
        stockZongo:35,
        stockKintampo:20,
        stockWarehouse:120,
        reorder:10
      },
      {
        id:'p5',
        name:'LED Bulb 9W',
        sku:'BLB-LED-9W',
        category:'Lighting',
        price:18,
        stockAhmadiyya:80,
        stockZongo:60,
        stockKintampo:40,
        stockWarehouse:200,
        reorder:20
      },
      {
        id:'p6',
        name:'LED Bulb 12W',
        sku:'BLB-LED-12W',
        category:'Lighting',
        price:25,
        stockAhmadiyya:70,
        stockZongo:50,
        stockKintampo:35,
        stockWarehouse:180,
        reorder:20
      },
      {
        id:'p7',
        name:'Circuit Breaker',
        sku:'MCB-001',
        category:'Breakers',
        price:60,
        stockAhmadiyya:18,
        stockZongo:12,
        stockKintampo:8,
        stockWarehouse:50,
        reorder:5
      },
      {
        id:'p8',
        name:'Distribution Board',
        sku:'DB-001',
        category:'Distribution Boards',
        price:180,
        stockAhmadiyya:10,
        stockZongo:7,
        stockKintampo:4,
        stockWarehouse:30,
        reorder:3
      },
      {
        id:'p9',
        name:'Extension Board',
        sku:'EXT-001',
        category:'Accessories',
        price:95,
        stockAhmadiyya:20,
        stockZongo:15,
        stockKintampo:10,
        stockWarehouse:40,
        reorder:5
      },
      {
        id:'p10',
        name:'PVC Pipe',
        sku:'PVC-001',
        category:'Conduit',
        price:22,
        stockAhmadiyya:100,
        stockZongo:80,
        stockKintampo:60,
        stockWarehouse:250,
        reorder:30
      }
    ]);
  }

  if (!LS.get(STORAGE.invoices))      LS.set(STORAGE.invoices, []);
  if (!LS.get(STORAGE.customers))     LS.set(STORAGE.customers, []);
  if (!LS.get(STORAGE.suppliers))     LS.set(STORAGE.suppliers, []);
  if (!LS.get(STORAGE.stockhistory))  LS.set(STORAGE.stockhistory, []);
  if (!LS.get(STORAGE.audit))         LS.set(STORAGE.audit, []);
  if (!LS.get(STORAGE.invoiceSeq))    LS.set(STORAGE.invoiceSeq, 1001);
  if (!LS.get(STORAGE.sessions))      LS.set(STORAGE.sessions, []);

  ensureUsers();
}

function getUsers()        { return LS.get(STORAGE.users) || []; }
function getInvoices()     { return (LS.get(STORAGE.invoices) || []).filter(i => !i.deleted); }
function getAllInvoices()  { return LS.get(STORAGE.invoices) || []; }
function getCustomers()    { return LS.get(STORAGE.customers) || []; }
function getSuppliers() { return LS.get(STORAGE.suppliers) || []; }
function getProducts()     { return LS.get(STORAGE.products) || []; }
function getStockHistory() { return LS.get(STORAGE.stockhistory) || []; }
function getSessions()     { return SS.get(STORAGE.sessions) || LS.get(STORAGE.sessions) || []; }

// ============================================================
// TOAST
// ============================================================
let toastTimer;

function toast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' '+type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// ============================================================
// AUDIT
// ============================================================
function addAudit(action, detail) {
  const log = LS.get(STORAGE.audit) || [];

  log.unshift({
    id:'au_' + Date.now(),
    action,
    detail,
    by: currentUser ? currentUser.username : 'system',
    byName: currentUser ? currentUser.fullName : 'system',
    createdAt: Date.now()
  });

  if (log.length > 1000) log.length = 1000;
  LS.set(STORAGE.audit, log);

  if (window.LumodaSupabase && window.LumodaSupabase.isConfigured() && currentUser) {
    void window.LumodaSupabase.logAudit(action, detail).catch(err => {
      console.warn('Server audit write failed:', err);
    });
  }
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================
function registerSession(user) {
  const token = genToken();

  const sessions = (SS.get(STORAGE.sessions) || [])
    .filter(s => s.username !== user.username);

  sessions.push({
    token,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    location: user.location,
    loginAt: Date.now(),
    lastActivity: Date.now()
  });

  SS.set(STORAGE.sessions, sessions);
  SS.set(STORAGE.token, token);

  return token;
}

function getCurrentSession() {
  const token = SS.get(STORAGE.token);
  if (!token) return null;
  return getSessions().find(s => s.token === token) || null;
}

function destroySession() {
  const token = SS.get(STORAGE.token);

  if (token) {
    const remaining = (SS.get(STORAGE.sessions) || [])
      .filter(s => s.token !== token);

    SS.set(STORAGE.sessions, remaining);

    try {
      LS.set(STORAGE.sessions, (LS.get(STORAGE.sessions) || []).filter(s => s.token !== token));
    } catch(e) {}

    SS.del(STORAGE.token);
  }
}

function updateSessionActivity() {
  const token = SS.get(STORAGE.token);
  if (!token) return;

  const sessions = getSessions();
  const idx = sessions.findIndex(s => s.token === token);

  if (idx >= 0) {
    sessions[idx].lastActivity = Date.now();
    LS.set(STORAGE.sessions, sessions);
  }
}

// ============================================================
// INACTIVITY AUTO-LOGOUT
// ============================================================
function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  clearTimeout(warningTimer);
  clearInterval(countdownInterval);

  document.getElementById('session-warning').style.display = 'none';

  updateSessionActivity();

  warningTimer    = setTimeout(showSessionWarning, INACTIVITY_MS - WARNING_MS);
  inactivityTimer = setTimeout(() => forceLogout('5 minutes of inactivity'), INACTIVITY_MS);
}

function showSessionWarning() {
  let secs = Math.floor(WARNING_MS / 1000);

  document.getElementById('session-warning').style.display = 'flex';
  document.getElementById('session-countdown').textContent = secs;

  clearInterval(countdownInterval);

  countdownInterval = setInterval(() => {
    secs--;

    const el = document.getElementById('session-countdown');
    if (el) el.textContent = secs;

    if (secs <= 0) clearInterval(countdownInterval);
  }, 1000);
}

function stayLoggedIn() {
  resetInactivityTimer();
}

function forceLogout(reason) {
  clearTimeout(inactivityTimer);
  clearTimeout(warningTimer);
  clearInterval(countdownInterval);

  if (currentUser) addAudit('Auto Logout', `Session ended — ${reason}`);

  destroySession();

  currentUser = null;
  showAuthScreen();

  toast('You were logged out due to inactivity.', 'error');
}

function startActivityTracking() {
  ['mousemove','keydown','click','touchstart','scroll'].forEach(e => {
    document.addEventListener(e, resetInactivityTimer, { passive:true });
  });

  resetInactivityTimer();
}

function stopActivityTracking() {
  ['mousemove','keydown','click','touchstart','scroll'].forEach(e => {
    document.removeEventListener(e, resetInactivityTimer);
  });

  clearTimeout(inactivityTimer);
  clearTimeout(warningTimer);
  clearInterval(countdownInterval);
}

// ============================================================
// LOGIN
// ============================================================
function supabaseProfileToLocal(profile) {
  return {
    id: profile.id,
    email: profile.email || '',
    username: profile.username,
    fullName: profile.full_name,
    role: profile.role,
    location: profile.location,
    active: profile.active !== false,
    mustChangePassword: !!profile.must_change_password,
    tempPasswordExpiry: null,
    failedLogins: 0,
    lockedUntil: null,
    createdAt: Date.now(),
    createdBy: 'supabase',
    lastLogin: Date.now()
  };
}

async function resolveSupabaseLoginEmail(identifier) {
  if (identifier.includes('@')) return identifier;

  const { data: profile, error } = await window.LumodaSupabase.getProfileByUsername(identifier);

  if (error) throw error;

  if (!profile || !profile.email) {
    throw new Error('This username is not linked to a Supabase account. Ask your administrator to recreate it with an email address.');
  }

  return profile.email;
}

async function syncSupabaseCache() {
  if (!window.LumodaSupabase || !window.LumodaSupabase.isConfigured()) return;

  const [products, customers, invoices] = await Promise.all([
    window.LumodaSupabase.loadProducts(),
    window.LumodaSupabase.loadCustomers().catch(() => []),
    window.LumodaSupabase.loadInvoices().catch(() => [])
  ]);

  LS.set(STORAGE.products, products);
  LS.set(STORAGE.customers, customers);
  LS.set(STORAGE.invoices, invoices);
}

async function doLogin() {
  const username = document.getElementById('auth-user').value.trim().toLowerCase();
  const password = document.getElementById('auth-pass').value;
  const errEl    = document.getElementById('auth-error');

  errEl.style.display = 'none';

  if (!username || !password) {
    errEl.textContent = 'Please enter your username or email and password.';
    errEl.style.display = 'block';
    return;
  }

  if (window.LumodaSupabase && window.LumodaSupabase.isConfigured()) {
    try {
      const loginEmail = await resolveSupabaseLoginEmail(username);

      const { data, error } = await window.LumodaSupabase.signIn(loginEmail, password);
      if (error) throw error;

      const userId = data?.user?.id;
      if (!userId) throw new Error('Login succeeded, but no Supabase user was returned.');

      const { data: profile, error: profileError } = await window.LumodaSupabase.getProfile(userId);
      if (profileError) throw profileError;

      if (!profile || profile.active === false) {
        throw new Error('Account deactivated or profile missing. Contact your administrator.');
      }

      currentUser = supabaseProfileToLocal(profile);
      currentLocation = currentUser.location;
      currentUser.token = registerSession(currentUser);

      setAutoLoginAllowed(!!document.getElementById('remember-login')?.checked);

      await syncSupabaseCache();

      addAudit('Login', `"${currentUser.fullName}" signed in with Supabase [${currentUser.location}]`);

      showApp();
      return;

    } catch (err) {
      errEl.textContent = err.message || 'Supabase login failed.';
      errEl.style.display = 'block';
      return;
    }
  }

  errEl.textContent = 'Supabase is not configured on this deployment. Please check that supabase-config.js is uploaded and loading correctly.';
  errEl.style.display = 'block';
}

// ============================================================
// FORCED PASSWORD CHANGE
// ============================================================
function showChangePwScreen() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('change-pw-screen').style.display = 'flex';

  document.getElementById('change-pw-name').textContent =
    'Welcome, ' + currentUser.fullName.split(' ')[0] + '!';

  document.getElementById('new-pw').value = '';
  document.getElementById('confirm-pw').value = '';
  document.getElementById('change-pw-error').style.display = 'none';
}

function doChangePassword() {
  const np  = document.getElementById('new-pw').value;
  const cp  = document.getElementById('confirm-pw').value;
  const err = document.getElementById('change-pw-error');

  err.style.display = 'none';

  if (np.length < 6) {
    err.textContent = 'Password must be at least 6 characters.';
    err.style.display = 'block';
    return;
  }

  if (np !== cp) {
    err.textContent = 'Passwords do not match.';
    err.style.display = 'block';
    return;
  }

  if (window.LumodaSupabase && window.LumodaSupabase.isConfigured()) {
    (async () => {
      try {
        const sb = window.LumodaSupabase.getClient();

        const { error: updateError } = await sb.auth.updateUser({ password: np });
        if (updateError) throw updateError;

        const { error: profileError } = await window.LumodaSupabase.completePasswordChange();
        if (profileError) throw profileError;

        currentUser.mustChangePassword = false;

        addAudit('Password Changed', `"${currentUser.fullName}" set new password after first login`);

        document.getElementById('change-pw-screen').style.display = 'none';

        showApp();
        toast('Password set. Welcome to Ultimate Dee Electricals!');

      } catch (error) {
        err.textContent = error.message || 'Could not update your password.';
        err.style.display = 'block';
      }
    })();

    return;
  }

  err.textContent = 'Supabase is not configured. Password changes must be handled through Supabase Auth.';
  err.style.display = 'block';
}

// ============================================================
// LOGOUT
// ============================================================
async function doLogout() {
  if (!confirm('Sign out of Ultimate Dee Electricals?')) return;

  addAudit('Logout', `"${currentUser.fullName}" signed out`);

  if (window.LumodaSupabase && window.LumodaSupabase.isConfigured()) {
    try {
      await window.LumodaSupabase.signOut();
    } catch (e) {}
  }

  destroySession();
  stopActivityTracking();

  currentUser = null;

  showAuthScreen();
}

function showAuthScreen(clear = true) {
  document.getElementById('app').style.display = 'none';
  document.getElementById('change-pw-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('session-warning').style.display = 'none';

  if (clear) {
    document.getElementById('auth-user').value = '';
    document.getElementById('auth-pass').value = '';
    document.getElementById('auth-error').style.display = 'none';
  }
}

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('change-pw-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  updateUserUI();
  buildNavForRole();

  const startPage =
    currentUser && ['warehouse_manager', 'warehouse_staff'].includes(currentUser.role)
      ? 'warehouse'
      : 'dashboard';

  navigate(startPage, null);
  startActivityTracking();
}

// ============================================================
// ROLE-BASED ACCESS
// ============================================================
function isAdmin() {
  if (!currentUser || currentUser.role !== 'admin') return false;

  const session = getCurrentSession();

  return !!session &&
    session.username === currentUser.username &&
    session.role === 'admin';
}

function isManager() {
  return currentUser && currentUser.role === 'manager';
}

function isWarehouseUser() {
  return currentUser && ['warehouse_manager', 'warehouse_staff'].includes(currentUser.role);
}

function requireAdmin(action) {
  if (!isAdmin()) {
    toast('Only admin can ' + action, 'error');
    return false;
  }

  return true;
}

function buildNavForRole() {
  const admin = isAdmin();
  const manager = isManager();
  const warehouseUser = isWarehouseUser();

  const allPages = [
    'dashboard',
    'invoices',
    'payments',
    'customers',
    'products',
    'suppliers',
    'purchases',
    'warehouse',
    'stockhistory',
    'reports',
    'audit',
    'users'
  ];

  function showPages(pages) {
    allPages.forEach(page => {
      const el = document.querySelector('.nav-item[data-page="' + page + '"]');
      if (el) el.style.display = pages.includes(page) ? 'flex' : 'none';
    });
  }

  if (warehouseUser) {
    showPages(['warehouse', 'products', 'stockhistory']);
    document.getElementById('loc-filter').style.display = 'none';
    currentLocation = WAREHOUSE_LOCATION;
    return;
  }

  if (admin) {
    showPages(allPages);
    document.getElementById('loc-filter').style.display = 'flex';
    return;
  }

  if (manager) {
    showPages([
      'dashboard',
      'invoices',
      'payments',
      'customers',
      'products',
      'suppliers',
      'warehouse',
      'stockhistory',
      'reports'
    ]);

    document.getElementById('loc-filter').style.display = 'none';
    currentLocation = currentUser.location;
    return;
  }

  showPages([
    'dashboard',
    'invoices',
    'payments',
    'customers',
    'products',
    'stockhistory'
  ]);

  document.getElementById('loc-filter').style.display = 'none';
  currentLocation = currentUser.location;
}
function filterByLoc(arr) {
  const loc = isAdmin() ? currentLocation : currentUser.location;
  if (loc === 'All') return arr;
  return arr.filter(i => i.location === loc);
}

// ============================================================
// USER UI
// ============================================================
function updateUserUI() {
  if (!currentUser) return;

  const u = currentUser;
  const firstName = u.fullName.split(' ')[0];
  const initials = u.fullName
    .split(' ')
    .map(n => n[0])
    .join('')
    .substring(0,2)
    .toUpperCase();

  document.getElementById('topbar-username').textContent = u.fullName;
  document.getElementById('topbar-avatar').textContent = initials;

  document.getElementById('sidebar-user-info').textContent =
    '@' + u.username + ' · ' + u.location;

  document.getElementById('loc-name').textContent = u.location;

  const hr = new Date().getHours();

  const greet =
    hr < 12 ? 'Good morning'
    : hr < 17 ? 'Good afternoon'
    : 'Good evening';

  const el = document.getElementById('dash-greeting');

  if (el) {
    el.textContent = greet + ', ' + firstName + ' 👋';
  }

  const dateEl = document.getElementById('dash-date');

  if (dateEl) {
    const now = new Date();

    dateEl.textContent =
      now.toLocaleDateString(
        'en-GB',
        {
          weekday:'long',
          day:'numeric',
          month:'long',
          year:'numeric'
        }
      ) + ' · Ultimate Dee Electricals';
  }

  const roleEl = document.getElementById('topbar-role');

  if (roleEl) {
    roleEl.textContent =
      u.role === 'admin'
        ? 'Admin'
        : u.location;

    roleEl.style.background =
      u.role === 'admin'
        ? 'var(--brand-red)'
        : 'var(--brand-brown)';
  }
}

// ============================================================
// NAVIGATION
// ============================================================
function navigate(page, el) {
  if (!isAdmin() && ['reports','audit','users'].includes(page)) { toast('Access denied', 'error'); return; }
  if (currentUser && currentUser.role === 'warehouse_manager' && page !== 'warehouse' && page !== 'settings') { toast('Access denied', 'error'); return; }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById('page-' + page);
  if (!pageEl) return;
  pageEl.classList.add('active');
  if (el) el.classList.add('active');
  else document.querySelector('.nav-item[data-page="' + page + '"]')?.classList.add('active');
  const titles = {
  dashboard:'Dashboard',
  invoices:'Invoices',
  payments:'Payments',
  customers:'Customers & Debtors',
  suppliers:'Suppliers',
  purchases:'Purchases',
  products:'Products',
  warehouse:'Warehouse',
  stockhistory:'Stock History',
  reports:'Reports',
  audit:'Audit Log',
  users:'User Management'
};
  document.getElementById('page-title').textContent = titles[page] || page;
  renderPage(page);
}

function renderPage(page) {
  ({
    dashboard: renderDashboard,
    invoices: renderInvoices,
    payments: renderPayments,
    customers: renderCustomers,
    suppliers: renderSuppliers,
    purchases: renderPurchases,
    products: renderProducts,
    warehouse: renderWarehouse,
    stockhistory: renderStockHistory,
    reports: renderReports,
    audit: renderAuditLog,
    users: renderUsers
  })[page]?.();
}

function switchLocFilter(loc, el) {
  if (!isAdmin()) return;
  document.querySelectorAll('.loc-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active'); currentLocation = loc; refreshAll();
}

function refreshAll() {
  const ap = document.querySelector('.page.active');
  if (ap) renderPage(ap.id.replace('page-', ''));
}

// ============================================================
// FORMAT
// ============================================================
function fmtGHS(n)    { return 'GH₵ ' + Number(n).toLocaleString('en', { minimumFractionDigits:2, maximumFractionDigits:2 }); }
function fmtDate(ts)  { return new Date(ts).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }); }
function fmtDateTime(ts) { return new Date(ts).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
function fmtAgo(ts)   { const d = Date.now()-ts, m = Math.floor(d/60000); if (m<1) return 'just now'; if (m<60) return m+'m ago'; const h=Math.floor(m/60); if(h<24) return h+'h ago'; return fmtDate(ts); }
function asTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (value.trim() !== '' && Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}
function startOfLocalDay(value = new Date()) {
  const day = new Date(value);
  day.setHours(0,0,0,0);
  return day;
}
function startOfWeek(value = new Date()) {
  const weekStart = startOfLocalDay(value);
  const mondayOffset = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - mondayOffset);
  return weekStart;
}
function weekRange(value = new Date()) {
  const start = startOfWeek(value);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}
// Simple HTML escape for user-supplied strings to reduce XSS risk
function escapeHtml(v){
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function autoLoginAllowed() {
  return LS.get(STORAGE.allowAutoLogin) === '1';
}

function setAutoLoginAllowed(enabled) {
  if (enabled) {
    LS.set(STORAGE.allowAutoLogin, '1');
  } else {
    LS.del(STORAGE.allowAutoLogin);
  }
}
function sumInvoiceTotal(invoices) {
  return invoices.reduce((sum, invoice) => sum + invoice.total, 0);
}
function weekComparisonLabel(currentTotal, previousTotal) {
  const delta = currentTotal - previousTotal;
  const direction = delta >= 0 ? 'up' : 'down';
  const sign = delta >= 0 ? '+' : '-';
  return '<span class="stat-delta ' + direction + '">' + sign + fmtGHS(Math.abs(delta)) + ' vs last week</span>';
}

function statusBadge(s) {
  const m = { paid:'badge-success', pending:'badge-warning', partial:'badge-info', refunded:'badge-neutral', cancelled:'badge-danger' };
  return '<span class="badge ' + (m[s]||'badge-neutral') + '">' + s + '</span>';
}
function stockBadge(stock, reorder) {
  if (stock === 0) return '<span class="badge badge-danger">Out of Stock</span>';
  if (stock <= reorder) return '<span class="badge badge-warning">Low Stock</span>';
  return '<span class="badge badge-success">In Stock</span>';
}

function renderSalesByLocation() {
  const invoices = getInvoices();

  const ahmadiyya = invoices
    .filter(i => i.location === 'Techiman Ahmadiyya Road')
    .reduce((s, i) => s + Number(i.total || 0), 0);

  const zongo = invoices
    .filter(i => i.location === 'Techiman Zongo Traffic')
    .reduce((s, i) => s + Number(i.total || 0), 0);

  const kintampo = invoices
    .filter(i => i.location === 'Kintampo')
    .reduce((s, i) => s + Number(i.total || 0), 0);

  const el = document.getElementById('sales-by-location');
  if (!el) return;

  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;padding:8px 0"><span>Ahmadiyya</span><strong>' + fmtGHS(ahmadiyya) + '</strong></div>' +
    '<div style="display:flex;justify-content:space-between;padding:8px 0"><span>Zongo</span><strong>' + fmtGHS(zongo) + '</strong></div>' +
    '<div style="display:flex;justify-content:space-between;padding:8px 0"><span>Kintampo</span><strong>' + fmtGHS(kintampo) + '</strong></div>';
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  updateUserUI();
  const invoices   = filterByLoc(getInvoices());
  const now        = new Date();
  const today      = startOfLocalDay(now);
  const weekStart  = startOfWeek(now);
  const nextWeek   = new Date(weekStart); nextWeek.setDate(nextWeek.getDate() + 7);
  const prevWeek   = new Date(weekStart); prevWeek.setDate(prevWeek.getDate() - 7);
  const todayInvs  = invoices.filter(i => asTimestamp(i.createdAt) >= today);
  const weekInvs   = invoices.filter(i => {
    const createdAt = asTimestamp(i.createdAt);
    return createdAt >= weekStart && createdAt < nextWeek;
  });
  const lastWeekInvs = invoices.filter(i => {
    const createdAt = asTimestamp(i.createdAt);
    return createdAt >= prevWeek && createdAt < weekStart;
  });
  const pendingInvs = invoices.filter(i => i.status==='pending'||i.status==='partial');
  const weekTotal = sumInvoiceTotal(weekInvs);
  const lastWeekTotal = sumInvoiceTotal(lastWeekInvs);

  const statToday = document.getElementById('stat-today');
const statTodayD = document.getElementById('stat-today-d');
const statWeek = document.getElementById('stat-week');
const statWeekD = document.getElementById('stat-week-d');
const statPending = document.getElementById('stat-pending');
const statPendingD = document.getElementById('stat-pending-d');
const statCustomers = document.getElementById('stat-customers');

if (statToday) statToday.textContent = fmtGHS(sumInvoiceTotal(todayInvs));
if (statTodayD) statTodayD.textContent = todayInvs.length + ' invoice' + (todayInvs.length !== 1 ? 's' : '');
if (statWeek) statWeek.textContent = fmtGHS(weekTotal);
if (statWeekD) statWeekD.innerHTML = weekInvs.length + ' invoices ' + weekComparisonLabel(weekTotal, lastWeekTotal);
if (statPending) statPending.textContent = fmtGHS(sumInvoiceTotal(pendingInvs));
if (statPendingD) statPendingD.textContent = pendingInvs.length + ' outstanding';
if (statCustomers) statCustomers.textContent = filterByLoc(getCustomers()).length;
   // Recent invoices
  const recent = [...invoices]
    .sort((a, b) => asTimestamp(b.createdAt) - asTimestamp(a.createdAt))
    .slice(0, 6);

  const dashRecentBody = document.getElementById('dash-recent-body');

  if (dashRecentBody) {
    dashRecentBody.innerHTML = recent.length === 0
      ? '<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:32px">No invoices yet</td></tr>'
      : recent.map(i =>
          '<tr style="cursor:pointer" onclick="viewInvoice(\'' + i.id + '\')">' +
            '<td class="mono">' + i.number + '</td>' +
            '<td>' + escapeHtml(i.customerName) + '</td>' +
            '<td class="mono">' + fmtGHS(i.total) + '</td>' +
            '<td>' + statusBadge(i.status) + '</td>' +
          '</tr>'
        ).join('');
  }
  // Low stock
const effLoc = isAdmin() ? currentLocation : currentUser.location;

const lowStock = getProducts()
  .filter(p => {

    let stock = 0;

    if (effLoc === 'Techiman Ahmadiyya Road') {
      stock = p.stockAhmadiyya || 0;
    } 
    else if (effLoc === 'Techiman Zongo Traffic') {
      stock = p.stockZongo || 0;
    } 
    else if (effLoc === 'Kintampo') {
      stock = p.stockKintampo || 0;
    } 
    else {
      stock = Math.min(
        p.stockAhmadiyya || 0,
        p.stockZongo || 0,
        p.stockKintampo || 0
      );
    }

    return stock <= p.reorder;

  })
  .slice(0, 6);

document.getElementById('low-stock-list').innerHTML =
  lowStock.length === 0
    ? '<div style="padding:32px;text-align:center;color:var(--gray-400);font-size:13px">All products well-stocked ✓</div>'
    : lowStock.map(p => {

        let stock = 0;

        if (effLoc === 'Techiman Ahmadiyya Road') {
          stock = p.stockAhmadiyya || 0;
        } 
        else if (effLoc === 'Techiman Zongo Traffic') {
          stock = p.stockZongo || 0;
        } 
        else if (effLoc === 'Kintampo') {
          stock = p.stockKintampo || 0;
        } 
        else {
          stock = Math.min(
            p.stockAhmadiyya || 0,
            p.stockZongo || 0,
            p.stockKintampo || 0
          );
        }

        const pct = Math.min(
          100,
          Math.round(stock / Math.max(p.reorder * 2, 1) * 100)
        );

        const cls = stock === 0 ? 'critical' : 'low';

        const adjBtn = isAdmin()
          ? '<button class="btn btn-secondary btn-sm" onclick="openStockAdjust(\'' + p.id + '\')">Adjust</button>'
          : '';

        return `
          <div class="low-stock-item">
            <div style="flex:1">
              <div style="font-size:13px;font-weight:500">${p.name}</div>
              <div style="font-size:11px;color:var(--gray-400);font-family:var(--font-mono)">
                Stock: ${stock} · Reorder: ${p.reorder}
              </div>
              <div class="stock-bar-wrap" style="margin-top:6px">
                <div class="stock-bar ${cls}" style="width:${pct}%"></div>
              </div>
            </div>
            ${adjBtn}
          </div>
        `;
      }).join('');

    // Payment summary today
  const paidToday = todayInvs.filter(i => i.status === 'paid');

  const todayCash = paidToday
    .filter(i => i.payMethod === 'cash')
    .reduce((s, i) => s + Number(i.total || 0), 0);

  const todayMomo = paidToday
    .filter(i => i.payMethod === 'momo')
    .reduce((s, i) => s + Number(i.total || 0), 0);

  const cashEl = document.getElementById('stat-cash');
  const momoEl = document.getElementById('stat-momo');

  if (cashEl) cashEl.textContent = fmtGHS(todayCash);
  if (momoEl) momoEl.textContent = fmtGHS(todayMomo);

  // Active sessions (admin only)
  renderSessionsPanel();
  renderWeeklyChart(invoices);
  renderSalesByLocation();
}

function renderWeeklyChart(invoices) {
  const days = [];
  const { start } = weekRange();
  for (let i = 0; i < 7; i++) {
    const day = new Date(start);
    day.setDate(day.getDate() + i);
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    const total = invoices.filter(inv => {
      const createdAt = asTimestamp(inv.createdAt);
      return createdAt >= day && createdAt < next;
    }).reduce((sum, inv) => sum + inv.total, 0);
    days.push({label:day.toLocaleDateString('en',{weekday:'short'}),total});
  }
  const max = Math.max(...days.map(d=>d.total),1);
  document.getElementById('weekly-chart').innerHTML = days.map(d => { const h=Math.round(d.total/max*100); return '<div class="chart-bar-wrap"><div style="font-size:9px;color:var(--gray-400);font-family:var(--font-mono)">'+(d.total>0?'GH₵'+Math.round(d.total):'')+'</div><div class="chart-bar" style="height:'+h+'px"></div><div class="chart-bar-label">'+d.label+'</div></div>'; }).join('');
}

// ============================================================
// INVOICES
// ============================================================
let invoiceFilter = { text:'', status:'' };

function renderInvoices() {
  let invoices = filterByLoc(getInvoices());
  if (invoiceFilter.text) { const q=invoiceFilter.text.toLowerCase(); invoices=invoices.filter(i=>i.customerName.toLowerCase().includes(q)||i.number.toLowerCase().includes(q)); }
  if (invoiceFilter.status) invoices = invoices.filter(i=>i.status===invoiceFilter.status);
  invoices.sort((a,b)=>asTimestamp(b.createdAt)-asTimestamp(a.createdAt));
  const tbody = document.getElementById('invoices-body');
  tbody.innerHTML = invoices.length===0
  ? '<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:40px">No invoices found</td></tr>'
  : invoices.map(i=>'<tr><td class="mono" style="cursor:pointer" onclick="viewInvoice(\''+i.id+'\')">'+i.number+'</td><td class="mono">'+fmtDate(i.createdAt)+'</td><td>'+i.customerName+'</td><td><span class="badge badge-neutral">'+i.location+'</span></td><td style="color:var(--gray-600)">'+i.items.length+' item'+(i.items.length!==1?'s':'')+'</td><td class="mono" style="font-weight:500">'+fmtGHS(i.total)+'</td><td>'+statusBadge(i.status)+'</td><td>'+(i.payMethod==='cash'?'💵 Cash':i.payMethod==='momo'?'📱 MoMo':'—')+'</td><td style="color:var(--gray-400);font-size:12px">'+(i.createdByName || 'Unknown')+'</td><td><button class="btn btn-secondary btn-sm" onclick="viewInvoice(\''+i.id+'\')">View</button></td></tr>').join('');
}
function filterInvoices(val)      { invoiceFilter.text=val;   renderInvoices(); }
function filterInvoiceStatus(val) { invoiceFilter.status=val; renderInvoices(); }

function openInvoiceModal() {
  lineItemCount = 0;
  document.getElementById('line-items-body').innerHTML = '';
  ['inv-cust-name','inv-cust-phone','inv-cust-addr','inv-notes','inv-momo-number'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('inv-status').value = 'pending';
  document.getElementById('invoice-total-display').textContent = 'Total: GH₵ 0.00';
  const _pmRow  = document.getElementById('payment-method-row');
  const _momoRow = document.getElementById('momo-number-row');
  const _pmCash = document.getElementById('pm-cash');
  const _pmMomo = document.getElementById('pm-momo');
  if (_pmRow)   _pmRow.style.display   = 'none';
  if (_momoRow) _momoRow.style.display = 'none';
  if (_pmCash)  _pmCash.style.cssText  = 'border:1px solid var(--gray-200);border-radius:var(--radius);padding:10px 14px;cursor:pointer;font-size:13px;font-weight:500;text-align:center';
  if (_pmMomo)  _pmMomo.style.cssText  = 'border:1px solid var(--gray-200);border-radius:var(--radius);padding:10px 14px;cursor:pointer;font-size:13px;font-weight:500;text-align:center';
  window._selectedPayMethod = '';
  const locSel = document.getElementById('inv-location');
  if (!isAdmin()) { locSel.value = currentUser.location; locSel.disabled = true; } else locSel.disabled = false;
  addLineItem(); openModal('invoice-modal');
}

function onStatusChange() {
  const status  = document.getElementById('inv-status').value;
  const pmRow   = document.getElementById('payment-method-row');
  const momoRow = document.getElementById('momo-number-row');
  if (pmRow)   pmRow.style.display = (status==='paid') ? 'block' : 'none';
  if (status !== 'paid') {
    window._selectedPayMethod = '';
    if (momoRow) momoRow.style.display = 'none';
  }
}

function selectPayMethod(method) {
  window._selectedPayMethod = method;
  const on  = 'border:2px solid var(--brand-brown);border-radius:var(--radius);padding:10px 14px;cursor:pointer;font-size:13px;font-weight:600;text-align:center;background:var(--gray-50)';
  const off = 'border:1px solid var(--gray-200);border-radius:var(--radius);padding:10px 14px;cursor:pointer;font-size:13px;font-weight:500;text-align:center';
  document.getElementById('pm-cash').style.cssText = method==='cash' ? on : off;
  document.getElementById('pm-momo').style.cssText = method==='momo' ? on : off;
  document.getElementById('momo-number-row').style.display = method==='momo' ? 'block' : 'none';
}

function addLineItem() {
  const id   = lineItemCount++;
  const opts = getProducts().map(p=>'<option value="'+p.name+'" data-price="'+p.price+'">'+p.name+'</option>').join('');
  const priceLocked = true;
  const priceExtra  = priceLocked ? ' readonly title="Only admin can change prices"' : '';
  const priceBg     = priceLocked ? 'background:var(--gray-50);color:var(--gray-400);cursor:not-allowed;' : '';
  const row  = document.createElement('div');
  row.className = 'line-item-row'; row.id = 'li-'+id;
  row.innerHTML =
    '<input type="text" list="pl-'+id+'" placeholder="Product name" oninput="onLineItemInput('+id+')" style="padding:5px 7px;border:1px solid var(--gray-200);border-radius:var(--radius);font-size:12px;width:100%;font-family:var(--font-sans);outline:none">'+
    '<datalist id="pl-'+id+'">'+opts+'</datalist>'+
    '<input type="number" placeholder="1" min="1" value="1" oninput="calcTotal()" style="padding:5px 7px;border:1px solid var(--gray-200);border-radius:var(--radius);font-size:12px;width:100%;font-family:var(--font-sans);outline:none">'+
    '<input type="number" placeholder="0.00" min="0" step="0.01" oninput="calcTotal()"'+priceExtra+' style="padding:5px 7px;border:1px solid var(--gray-200);border-radius:var(--radius);font-size:12px;width:100%;font-family:var(--font-sans);outline:none;'+priceBg+'">'+
    '<button class="remove-item" onclick="removeLineItem('+id+')">×</button>';
  document.getElementById('line-items-body').appendChild(row);
}

function onLineItemInput(id) {
  const row = document.getElementById('li-'+id);
  const ni  = row.querySelector('input[type=text]');
  const pi  = row.querySelectorAll('input')[2];
  const m   = getProducts().find(p=>p.name.toLowerCase()===ni.value.toLowerCase());
  if (m) {
    // Always auto-fill price; staff can't override (field is readonly)
    pi.value = m.price;
  }
  calcTotal();
}

function removeLineItem(id) { const r=document.getElementById('li-'+id); if(r) r.remove(); calcTotal(); }

function calcTotal() {
  let subtotal = 0;

  document.querySelectorAll('#line-items-body .line-item-row').forEach(row => {
    const inp = row.querySelectorAll('input');
    subtotal += (parseFloat(inp[1].value) || 0) * (parseFloat(inp[2].value) || 0);
  });

  const discount = parseFloat(document.getElementById('inv-discount')?.value) || 0;
  const total = Math.max(0, subtotal - discount);

  document.getElementById('invoice-total-display').textContent =
    'Subtotal: ' + fmtGHS(subtotal) +
    ' | Discount: ' + fmtGHS(discount) +
    ' | Total: ' + fmtGHS(total);
}

async function createInvoice() {
  if (invoiceSaving) return;
  invoiceSaving = true;

  const name = document.getElementById('inv-cust-name').value.trim();
  const phone = document.getElementById('inv-cust-phone').value.trim();
  const addr = document.getElementById('inv-cust-addr').value.trim();
  const loc = document.getElementById('inv-location').value;
  const status = document.getElementById('inv-status').value;
  const notes = document.getElementById('inv-notes').value.trim();
  const discount = parseFloat(document.getElementById('inv-discount')?.value) || 0;
  const momoEl = document.getElementById('inv-momo-number');
  const momoNumber = momoEl ? momoEl.value.trim() : '';

  if (status === 'paid' && !window._selectedPayMethod) {
    invoiceSaving = false;
    toast('Please select Cash, Mobile Money, Bank Transfer or Credit', 'error');
    return;
  }

  const payMethod = status === 'paid' ? (window._selectedPayMethod || '') : '';

  if (!name) {
    invoiceSaving = false;
    toast('Customer name is required', 'error');
    return;
  }

  const rows = document.querySelectorAll('#line-items-body .line-item-row');

  if (rows.length === 0) {
    invoiceSaving = false;
    toast('Add at least one item', 'error');
    return;
  }

  const items = [];
  let valid = true;

  rows.forEach(row => {
    const inp = row.querySelectorAll('input');
    const pn = inp[0].value.trim();
    const qty = parseInt(inp[1].value) || 0;
    const price = parseFloat(inp[2].value) || 0;

    if (!pn || qty < 1 || price <= 0) {
      valid = false;
      return;
    }

    items.push({
      name: pn,
      qty,
      price,
      total: qty * price
    });
  });

  if (!valid) {
    invoiceSaving = false;
    toast('Please complete all invoice items correctly', 'error');
    return;
  }

  const subtotal = items.reduce((s, i) => s + i.total, 0);
  const total = Math.max(0, subtotal - discount);

  const seq = LS.get(STORAGE.invoiceSeq) || 1001;
  const number = String(seq).padStart(6, '0');
  LS.set(STORAGE.invoiceSeq, seq + 1);

  const invoice = {
    id: 'inv_' + Date.now(),
    number,
    customerName: name,
    customerPhone: phone,
    customerAddress: addr,
    location: loc,
    items,
    subtotal,
    discount,
    total,
    status,
    payMethod,
    momoNumber,
    notes,
    createdBy: currentUser.id,
    createdByName: currentUser.fullName,
    createdAt: Date.now(),
    deleted: false
  };

  if (window.LumodaSupabase && window.LumodaSupabase.isConfigured()) {
    try {
      const cachedProducts = getProducts();

      const p_items = items.map(it => {
        const prod = cachedProducts.find(
          p => p.name.toLowerCase() === it.name.toLowerCase()
        );

        return {
          product_id: prod ? prod.id : null,
          name: it.name,
          qty: it.qty,
          price: it.price
        };
      });

      const res = await window.LumodaSupabase.createInvoiceNoStock({
  p_customer_name: name,
  p_location: loc,
  p_items,
  p_customer_phone: phone || null,
  p_customer_address: addr || null,
  p_status: status,
  p_pay_method: payMethod || null,
  p_momo_number: momoNumber || null,
  p_notes: notes || null,
  p_discount: discount || 0
});

if (res.error) throw res.error;

await syncSupabaseCache();

addAudit(
  'Invoice Created',
  currentUser.fullName +
    ' created ' +
    number +
    ' for ' +
    name +
    ' — ' +
    fmtGHS(total) +
    ' [' +
    loc +
    ']'
);

invoiceSaving = false;
closeModal('invoice-modal');
toast('Invoice ' + number + ' created!');

currentLocation = 'All';

navigate('invoices');
renderInvoices();
renderCustomers();
renderDashboard();

try {
  navigator.clipboard.writeText(generateInvoiceText(invoice));
} catch (e) {}

return;

} catch (err) {
  console.error('Invoice creation error:', err);
  invoiceSaving = false;
  toast(err.message || 'Could not create invoice', 'error');
  return;
}
  }
}

function viewInvoice(id) {
  viewingInvoiceId = id;

  const inv = getAllInvoices().find(i => i.id === id);
  if (!inv) return;

  document.getElementById('view-inv-title').textContent = 'Invoice No: ' + inv.number;
  document.getElementById('view-inv-body').innerHTML = buildInvoiceHTML(inv);

  const delBtn = document.getElementById('view-inv-delete');

  delBtn.style.display = isAdmin() && !inv.deleted ? 'inline-flex' : 'none';
  delBtn.onclick = () => deleteInvoice(id);

  openModal('view-invoice-modal');
}

function paymentLabel(method) {
  switch (method) {
    case 'cash':
      return '💵 Cash';

    case 'momo':
      return '📱 Mobile Money';

    case 'bank':
      return '🏦 Bank Transfer';

    case 'credit':
      return '📌 Credit Sale';

    default:
      return '—';
  }
}

function buildInvoiceHTML(inv) {
  const blanks = Array(Math.max(0, 6 - inv.items.length))
    .fill('<tr><td style="padding:9px 10px">&nbsp;</td><td></td><td></td><td></td></tr>')
    .join('');

  return '' +
    '<div style="border:2px solid var(--brand-brown);border-radius:var(--radius);overflow:hidden;margin-bottom:14px">' +

      '<div style="background:#00184A;color:white;padding:8px 14px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
        '<div>' +
          '<div style="font-family:var(--font-serif);font-size:16px;font-weight:700;letter-spacing:.04em">ULTIMATE DEE ELECTRICALS</div>' +
          '<div style="font-size:11px;opacity:.85;margin-top:2px">Dealers in Quality Electrical Materials & Accessories</div>' +
        '</div>' +

        '<div style="background:#F6C400;color:#00184A;border-radius:4px;padding:3px 10px;font-size:11px;font-weight:800;letter-spacing:.06em;white-space:nowrap;align-self:center">SALES INVOICE</div>' +

        '<div style="text-align:right;font-size:9px;opacity:.9;font-family:var(--font-mono)">' +
          '<div>Techiman Ahmadiyya Road</div>' +
          '<div>Techiman Zongo Traffic</div>' +
          '<div>Kintampo Branch</div>' +
          '<div>TEL: 0554898010 / 0553789807</div>' +
        '</div>' +
      '</div>' +

      '<div style="background:#F6C400;color:#00184A;padding:5px 14px;display:flex;justify-content:space-between;align-items:center">' +
        '<div style="font-weight:800;font-size:13px;letter-spacing:.08em">INVOICE</div>' +
        '<div style="font-family:var(--font-mono);font-size:12px">No: <strong>' + escapeHtml(inv.number) + '</strong></div>' +
        '<div style="font-family:var(--font-mono);font-size:11px">' + fmtDate(inv.createdAt) + '</div>' +
      '</div>' +

      '<div style="padding:10px 14px;background:var(--white)">' +
        '<div style="display:flex;gap:16px;font-size:13px;flex-wrap:wrap">' +
          '<span style="color:var(--gray-400)">Customer:</span><strong>' + escapeHtml(inv.customerName) + '</strong>' +
          (inv.customerPhone
            ? '<span style="color:var(--gray-400)">Tel:</span><span>' + escapeHtml(inv.customerPhone) + '</span>'
            : '') +
        '</div>' +

        (inv.customerAddress
          ? '<div style="font-size:13px;margin-top:4px"><span style="color:var(--gray-400)">Address:</span> ' + escapeHtml(inv.customerAddress) + '</div>'
          : '') +
      '</div>' +

      '<table style="margin:0">' +
        '<thead>' +
          '<tr style="background:#00184A">' +
            '<th style="color:white;padding:8px 10px;font-size:11px;width:56px;text-align:center">QTY</th>' +
            '<th style="color:white;padding:8px 10px;font-size:11px">DESCRIPTION</th>' +
            '<th style="color:white;padding:8px 10px;font-size:11px;text-align:right;width:100px">UNIT PRICE</th>' +
            '<th style="color:white;padding:8px 10px;font-size:11px;text-align:right;width:110px">AMOUNT</th>' +
          '</tr>' +
        '</thead>' +

        '<tbody>' +
          inv.items.map(item =>
            '<tr>' +
              '<td style="text-align:center;padding:9px 10px;font-weight:500">' + escapeHtml(item.qty) + '</td>' +
              '<td style="padding:9px 10px">' + escapeHtml(item.name) + '</td>' +
              '<td style="text-align:right;padding:9px 10px;font-family:var(--font-mono)">' + Number(item.price || 0).toFixed(2) + '</td>' +
              '<td style="text-align:right;padding:9px 10px;font-family:var(--font-mono);font-weight:600">' + Number(item.total || 0).toFixed(2) + '</td>' +
            '</tr>'
          ).join('') +
          blanks +
        '</tbody>' +
      '</table>' +

      '<div style="display:flex;flex-direction:column;align-items:flex-end;border-top:2px solid #00184A;padding:10px 14px;gap:6px">' +
        '<div><span style="font-size:13px;color:var(--gray-400)">Subtotal:</span> <span style="font-family:var(--font-mono)">' + fmtGHS(inv.subtotal || inv.total) + '</span></div>' +
        '<div><span style="font-size:13px;color:var(--gray-400)">Discount:</span> <span style="font-family:var(--font-mono)">-' + fmtGHS(inv.discount || 0) + '</span></div>' +
        '<div><span style="font-size:13px;font-weight:500">Total </span> <span style="font-family:var(--font-mono);font-size:18px;font-weight:700;color:#00184A">' + fmtGHS(inv.total) + '</span></div>' +
      '</div>' +

      '<div style="padding:8px 14px;border-top:1px solid var(--gray-100);display:flex;justify-content:space-between;align-items:center;background:var(--gray-50)">' +
        '<span style="font-size:11px;color:var(--gray-400);font-style:italic">Goods sold are not returnable after successful purchase</span>' +
        statusBadge(inv.status) +
        (inv.payMethod
          ? '&nbsp;&nbsp;<span class="badge badge-neutral">' + paymentLabel(inv.payMethod) + '</span>'
          : '') +
        (inv.momoNumber
          ? '&nbsp;<span style="font-size:11px;color:var(--gray-400);font-family:var(--font-mono)">' + escapeHtml(inv.momoNumber) + '</span>'
          : '') +
      '</div>' +

      '<div style="font-size:11px;color:var(--gray-400);font-family:var(--font-mono);padding:8px 14px">' +
        'Branch: ' + escapeHtml(inv.location) +
        ' · By: ' + escapeHtml(inv.createdByName || 'Unknown') +
        ' · ' + fmtDateTime(inv.createdAt) +
      '</div>' +

      (inv.notes
        ? '<div style="margin:10px 14px;padding:10px;background:var(--gray-50);border-radius:var(--radius);font-size:13px;color:var(--gray-600)">' + escapeHtml(inv.notes) + '</div>'
        : '') +

      (inv.deleted
        ? '<div style="margin:10px 14px;padding:8px 12px;background:#fee2e2;border-radius:var(--radius);font-size:12px;color:#991b1b">⚠ Deleted by ' + escapeHtml(inv.deletedBy) + ' on ' + fmtDateTime(inv.deletedAt) + '</div>'
        : '') +

    '</div>';
}
// ============================================================
// PRODUCTS
// ============================================================
let productSearch = '';

function getProductStock(product, location) {
  if (location === 'Techiman Ahmadiyya Road') return product.stockAhmadiyya || 0;
  if (location === 'Techiman Zongo Traffic') return product.stockZongo || 0;
  if (location === 'Kintampo') return product.stockKintampo || 0;
  if (location === 'Warehouse') return product.stockWarehouse || 0;

  return Math.min(
    product.stockAhmadiyya || 0,
    product.stockZongo || 0,
    product.stockKintampo || 0
  );
}

function setProductStock(product, location, value) {
  if (location === 'Techiman Ahmadiyya Road') product.stockAhmadiyya = value;
  else if (location === 'Techiman Zongo Traffic') product.stockZongo = value;
  else if (location === 'Kintampo') product.stockKintampo = value;
  else if (location === 'Warehouse') product.stockWarehouse = value;
}

function renderProducts() {
  const csvBtn = document.getElementById('btn-import-csv');
  const addBtn = document.getElementById('btn-add-product');
  const orderBtn = document.getElementById('btn-order-stock');

  if (csvBtn) csvBtn.style.display = isAdmin() ? 'inline-flex' : 'none';
  if (addBtn) addBtn.style.display = isAdmin() ? 'inline-flex' : 'none';
  if (orderBtn) orderBtn.style.display = isAdmin() ? 'inline-flex' : 'none';

  let products = getProducts();

  if (productSearch) {
    const q = productSearch.toLowerCase();
    products = products.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q)
    );
  }

  const effLoc = isAdmin() ? currentLocation : currentUser.location;

  document.getElementById('products-body').innerHTML = products.length
    ? products.map(p => {
        const ahm = p.stockAhmadiyya || 0;
        const zon = p.stockZongo || 0;
        const kin = p.stockKintampo || 0;
        const wh = p.stockWarehouse || 0;
        const selectedStock = getProductStock(p, effLoc);

        const adjBtn = isAdmin()
          ? '<button class="btn btn-secondary btn-sm" onclick="openStockAdjust(\'' + p.id + '\')">Adjust</button>'
          : '';

        const editBtn = isAdmin()
          ? '<button class="btn btn-secondary btn-sm" onclick="editProduct(\'' + p.id + '\')">Edit</button>'
          : '';

        return '<tr>' +
          '<td style="font-weight:500">' + escapeHtml(p.name) + '</td>' +
          '<td class="mono">' + escapeHtml(p.sku || '—') + '</td>' +
          '<td style="color:var(--gray-400)">' + escapeHtml(p.category || 'General') + '</td>' +
          '<td class="mono">' + fmtGHS(p.price || 0) + '</td>' +
          '<td class="mono" style="text-align:center;color:' + (ahm <= p.reorder ? '#dc2626' : 'inherit') + '">' + ahm + '</td>' +
          '<td class="mono" style="text-align:center;color:' + (zon <= p.reorder ? '#dc2626' : 'inherit') + '">' + zon + '</td>' +
          '<td class="mono" style="text-align:center;color:' + (kin <= p.reorder ? '#dc2626' : 'inherit') + '">' + kin + '</td>' +
          '<td class="mono" style="text-align:center;color:' + (wh <= p.reorder ? '#dc2626' : 'inherit') + '">' + wh + '</td>' +
          '<td>' + stockBadge(selectedStock, p.reorder) + '</td>' +
          '<td class="mono" style="color:var(--gray-400)">' + p.reorder + '</td>' +
          '<td style="display:flex;gap:6px">' + adjBtn + editBtn + '</td>' +
        '</tr>';
      }).join('')
    : '<tr><td colspan="11" style="text-align:center;color:var(--gray-400);padding:40px">No products found</td></tr>';
}

function filterProducts(val) {
  productSearch = val;
  renderProducts();
}

function openProductModal() {
  if (!requireAdmin('add products')) return;

  editingProductId = null;
  document.getElementById('prod-modal-title').textContent = 'New Product';

  [
    'prod-name',
    'prod-sku',
    'prod-category',
    'prod-price',
    'prod-stock-ahmadiyya',
    'prod-stock-zongo',
    'prod-stock-kintampo',
    'prod-stock-warehouse',
    'prod-reorder'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  openModal('product-modal');
}

function editProduct(id) {
  if (!requireAdmin('edit products')) return;

  const prod = getProducts().find(p => p.id === id);
  if (!prod) return;

  editingProductId = id;
  document.getElementById('prod-modal-title').textContent = 'Edit Product';

  document.getElementById('prod-name').value = prod.name || '';
  document.getElementById('prod-sku').value = prod.sku || '';
  document.getElementById('prod-category').value = prod.category || '';
  document.getElementById('prod-price').value = prod.price || 0;
  document.getElementById('prod-stock-ahmadiyya').value = prod.stockAhmadiyya || 0;
  document.getElementById('prod-stock-zongo').value = prod.stockZongo || 0;
  document.getElementById('prod-stock-kintampo').value = prod.stockKintampo || 0;
  document.getElementById('prod-stock-warehouse').value = prod.stockWarehouse || 0;
  document.getElementById('prod-reorder').value = prod.reorder || 5;

  openModal('product-modal');
}

function saveProduct() {
  if (!requireAdmin('save products')) return;

  const name = document.getElementById('prod-name').value.trim();
  const price = parseFloat(document.getElementById('prod-price').value);

  if (!name || isNaN(price)) {
    toast('Name and price required', 'error');
    return;
  }

  const products = getProducts();

  const sku = document.getElementById('prod-sku').value.trim() || 'UDE-' + Date.now();
  const category = document.getElementById('prod-category').value.trim() || 'General';
  const stockAhmadiyya = parseInt(document.getElementById('prod-stock-ahmadiyya').value) || 0;
  const stockZongo = parseInt(document.getElementById('prod-stock-zongo').value) || 0;
  const stockKintampo = parseInt(document.getElementById('prod-stock-kintampo').value) || 0;
  const stockWarehouse = parseInt(document.getElementById('prod-stock-warehouse').value) || 0;
  const reorder = parseInt(document.getElementById('prod-reorder').value) || 5;

  if (editingProductId) {
    const idx = products.findIndex(p => p.id === editingProductId);

    if (idx >= 0) {
      products[idx] = {
        ...products[idx],
        name,
        sku,
        category,
        price,
        stockAhmadiyya,
        stockZongo,
        stockKintampo,
        stockWarehouse,
        reorder
      };

      addAudit('Product Updated', currentUser.fullName + ' updated "' + name + '" @ ' + fmtGHS(price));
    }
  } else {
    products.push({
      id: 'p_' + Date.now(),
      name,
      sku,
      category,
      price,
      stockAhmadiyya,
      stockZongo,
      stockKintampo,
      stockWarehouse,
      reorder
    });

    addAudit('Product Added', currentUser.fullName + ' added "' + name + '" @ ' + fmtGHS(price));
  }

  LS.set(STORAGE.products, products);
  closeModal('product-modal');
  toast('Product saved');
  renderProducts();
  renderDashboard();
}

function orderStock() {
  if (!requireAdmin('order stock')) return;

  const low = getProducts().filter(p =>
    (p.stockAhmadiyya || 0) <= p.reorder ||
    (p.stockZongo || 0) <= p.reorder ||
    (p.stockKintampo || 0) <= p.reorder ||
    (p.stockWarehouse || 0) <= p.reorder
  );

  if (low.length === 0) {
    toast('No restocking needed');
    return;
  }

  const text =
    'ULTIMATE DEE ELECTRICALS — RESTOCK ORDER\n\n' +
    low.map(p =>
      '• ' + p.name + ' (' + p.sku + ')\n' +
      '  Ahmadiyya: ' + (p.stockAhmadiyya || 0) +
      ' | Zongo: ' + (p.stockZongo || 0) +
      ' | Kintampo: ' + (p.stockKintampo || 0) +
      ' | Warehouse: ' + (p.stockWarehouse || 0) +
      ' | Reorder at: ' + p.reorder
    ).join('\n\n');

  try {
    navigator.clipboard.writeText(text);
    toast('Restock list copied');
  } catch {
    alert(text);
  }
}

// ============================================================
// STOCK ADJUSTMENT
// ============================================================
let adjustingProductId = null;

function openStockAdjust(pid) {
  if (!requireAdmin('adjust stock')) return;

  adjustingProductId = pid;

  const prod = getProducts().find(p => p.id === pid);
  if (!prod) return;

  document.getElementById('stock-prod-name').value = prod.name;
  document.getElementById('stock-qty').value = '';
  document.getElementById('stock-note').value = '';
  document.getElementById('stock-type').value = 'Purchase';

  openModal('stock-modal');
}

function applyStockAdjustment() {
  if (!requireAdmin('adjust stock')) return;

  const loc = document.getElementById('stock-location').value;
  const type = document.getElementById('stock-type').value;
  const qty = parseInt(document.getElementById('stock-qty').value);
  const note = document.getElementById('stock-note').value.trim();

  if (isNaN(qty) || qty === 0) {
    toast('Enter a valid quantity', 'error');
    return;
  }

  const products = getProducts();
  const idx = products.findIndex(p => p.id === adjustingProductId);
  if (idx < 0) return;

  const prod = products[idx];
  const isAdd = ['Purchase', 'Return', 'Correction'].includes(type);
  const absQty = Math.abs(qty);
  const change = isAdd ? absQty : -absQty;

  const currentStock = getProductStock(prod, loc);

  if (!isAdd && currentStock < absQty) {
    toast('Insufficient stock at ' + loc, 'error');
    return;
  }

  setProductStock(prod, loc, Math.max(0, currentStock + change));

  products[idx] = prod;
  LS.set(STORAGE.products, products);

  addStockHistory(
    prod.id,
    prod.name,
    loc,
    change,
    type,
    note || 'Manual ' + type
  );

  addAudit(
    'Stock Adjusted',
    currentUser.fullName +
      ' adjusted "' +
      prod.name +
      '" ' +
      (change > 0 ? '+' : '') +
      change +
      ' at ' +
      loc +
      ' (' +
      type +
      ')'
  );

  closeModal('stock-modal');
  toast('Stock updated');
  renderProducts();
  renderDashboard();
}

function addStockHistory(productId, productName, location, change, type, note) {
  const h = getStockHistory();

  h.unshift({
    id: 'sh_' + Date.now(),
    productId,
    productName,
    location,
    change,
    type,
    note,
    by: currentUser.username,
    byName: currentUser.fullName,
    createdAt: Date.now()
  });

  LS.set(STORAGE.stockhistory, h);
}

function renderStockHistory() {
  let h = filterByLoc(getStockHistory());

  h.sort((a, b) => asTimestamp(b.createdAt) - asTimestamp(a.createdAt));

  document.getElementById('stockhistory-body').innerHTML = h.length === 0
    ? '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:40px">No stock history yet</td></tr>'
    : h.map(x =>
        '<tr>' +
          '<td class="mono">' + fmtDateTime(x.createdAt) + '</td>' +
          '<td><span class="badge badge-neutral">' + escapeHtml(x.type) + '</span></td>' +
          '<td>' + escapeHtml(x.productName) + '</td>' +
          '<td>' + escapeHtml(x.location) + '</td>' +
          '<td class="mono" style="color:' + (x.change > 0 ? '#16a34a' : '#dc2626') + '">' + (x.change > 0 ? '+' : '') + x.change + '</td>' +
          '<td>' + escapeHtml(x.note || '—') + '</td>' +
          '<td>' + escapeHtml(x.byName || x.by) + '</td>' +
        '</tr>'
      ).join('');
}

function filterStockHistory(val) {
  const q = val.toLowerCase();

  document.querySelectorAll('#stockhistory-body tr').forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}
// ============================================================
// MODALS
// ============================================================
function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

// ============================================================
// CSV IMPORT
// ============================================================
let csvRows = [];

function openCsvModal() {
  if (!requireAdmin('import CSV')) return;

  csvRows = [];
  document.getElementById('csv-file-input').value = '';
  document.getElementById('csv-preview').style.display = 'none';
  document.getElementById('csv-import-btn').style.display = 'none';

  showCsvError('');
  openModal('csv-modal');
}

function showCsvError(msg) {
  const e = document.getElementById('csv-error');
  if (!e) return;

  e.textContent = msg;
  e.style.display = msg ? 'block' : 'none';
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === ',' && !inQ) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }

  out.push(cur.trim());
  return out;
}

function parseCsvFile(input) {
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    try {
      const text = String(reader.result || '');
      const lines = text.split(/\r?\n/).filter(l => l.trim());

      if (lines.length < 2) {
        throw new Error('CSV must include headers and at least one product row.');
      }

      const headers = parseCsvLine(lines[0]).map(h =>
        h.toLowerCase().replace(/\s+/g, '')
      );

      const idx = {
        name: headers.indexOf('name'),
        price: headers.indexOf('price'),
        sku: headers.indexOf('sku'),
        category: headers.indexOf('category'),
        ahmadiyya: headers.indexOf('ahmadiyyastock'),
        zongo: headers.indexOf('zongostock'),
        kintampo: headers.indexOf('kintampostock'),
        warehouse: headers.indexOf('warehousestock'),
        reorder: headers.indexOf('reorderlevel')
      };

      if (idx.name < 0 || idx.price < 0) {
        throw new Error('Missing required columns: Name and Price.');
      }

      csvRows = lines.slice(1)
        .map((line, i) => {
          const c = parseCsvLine(line);

          return {
            name: c[idx.name] || '',
            price: parseFloat(c[idx.price] || '0'),
            sku: idx.sku >= 0 ? c[idx.sku] : '',
            category: idx.category >= 0 ? c[idx.category] : 'General',
            stockAhmadiyya: idx.ahmadiyya >= 0 ? parseInt(c[idx.ahmadiyya] || '0') : 0,
            stockZongo: idx.zongo >= 0 ? parseInt(c[idx.zongo] || '0') : 0,
            stockKintampo: idx.kintampo >= 0 ? parseInt(c[idx.kintampo] || '0') : 0,
            stockWarehouse: idx.warehouse >= 0 ? parseInt(c[idx.warehouse] || '0') : 0,
            reorder: idx.reorder >= 0 ? parseInt(c[idx.reorder] || '5') : 5,
            row: i + 2
          };
        })
        .filter(r => r.name);

      renderCsvPreview();

    } catch (err) {
      showCsvError(err.message);
    }
  };

  reader.readAsText(file);
}

function renderCsvPreview() {
  document.getElementById('csv-preview').style.display = 'block';
  document.getElementById('csv-import-btn').style.display = csvRows.length ? 'inline-flex' : 'none';
  document.getElementById('csv-preview-title').textContent = csvRows.length + ' product(s) ready to import';

  document.getElementById('csv-preview-body').innerHTML = csvRows.map((r, i) =>
    '<tr>' +
      '<td>' + escapeHtml(r.name) + '</td>' +
      '<td>' + escapeHtml(r.sku || '—') + '</td>' +
      '<td>' + escapeHtml(r.category || 'General') + '</td>' +
      '<td class="mono">' + fmtGHS(r.price || 0) + '</td>' +
      '<td class="mono">' + (r.stockAhmadiyya || 0) + '</td>' +
      '<td class="mono">' + (r.stockZongo || 0) + '</td>' +
      '<td class="mono">' + (r.stockKintampo || 0) + '</td>' +
      '<td class="mono">' + (r.stockWarehouse || 0) + '</td>' +
      '<td class="mono">' + (r.reorder || 5) + '</td>' +
      '<td><button class="btn btn-danger btn-sm" onclick="removeCsvRow(' + i + ')">Remove</button></td>' +
    '</tr>'
  ).join('');
}

function removeCsvRow(i) {
  csvRows.splice(i, 1);
  renderCsvPreview();
}

async function importCsvProducts() {
  if (!requireAdmin('import products')) return;
  if (!csvRows.length) return;

  if (window.LumodaSupabase && window.LumodaSupabase.isConfigured()) {
    try {
      const res = await window.LumodaSupabase.importProducts(
        csvRows.map(r => ({
          name: r.name,
          sku: r.sku,
          category: r.category || 'General',
          price: r.price || 0,
          stock_ahmadiyya: r.stockAhmadiyya || 0,
          stock_zongo: r.stockZongo || 0,
          stock_kintampo: r.stockKintampo || 0,
          stock_warehouse: r.stockWarehouse || 0,
          reorder_level: r.reorder || 5
        }))
      );

      if (res.error) throw res.error;

      await syncSupabaseCache();

      addAudit(
        'CSV Imported',
        currentUser.fullName + ' imported ' + csvRows.length + ' products [server]'
      );

      closeModal('csv-modal');
      toast(csvRows.length + ' products imported');
      renderProducts();
      return;

    } catch (err) {
      showCsvError(err.message || 'Could not import products to Supabase.');
      return;
    }
  }

  const products = getProducts();

  csvRows.forEach(r => {
    products.push({
      id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: r.name,
      sku: r.sku || 'UDE-' + Date.now(),
      category: r.category || 'General',
      price: r.price || 0,
      stockAhmadiyya: r.stockAhmadiyya || 0,
      stockZongo: r.stockZongo || 0,
      stockKintampo: r.stockKintampo || 0,
      stockWarehouse: r.stockWarehouse || 0,
      reorder: r.reorder || 5
    });
  });

  LS.set(STORAGE.products, products);

  addAudit(
    'CSV Imported',
    currentUser.fullName + ' imported ' + csvRows.length + ' products locally'
  );

  closeModal('csv-modal');
  toast(csvRows.length + ' products imported');
  renderProducts();
  renderDashboard();
}

function downloadCsvTemplate() {
  const csv =
    'Name,Price,SKU,Category,AhmadiyyaStock,ZongoStock,KintampoStock,WarehouseStock,ReorderLevel\n' +
    'Example Cable 2.5mm,650,CAB-2.5MM,Cables,20,15,10,50,5';

  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');

  a.href = URL.createObjectURL(blob);
  a.download = 'ultimate-dee-products-template.csv';
  a.click();

  URL.revokeObjectURL(a.href);
}

function exportCSV() {
  const h = getStockHistory();

  const csv =
    'Date,Type,Product,Location,Change,Note,By\n' +
    h.map(x =>
      [
        fmtDateTime(x.createdAt),
        x.type,
        x.productName,
        x.location,
        x.change,
        x.note,
        x.byName || x.by
      ].map(v => '"' + String(v || '').replace(/"/g, '""') + '"').join(',')
    ).join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');

  a.href = URL.createObjectURL(blob);
  a.download = 'ultimate-dee-stock-history.csv';
  a.click();

  URL.revokeObjectURL(a.href);
}

// ============================================================
// MOBILE
// ============================================================
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('open');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// ============================================================
// OFFLINE
// ============================================================
window.addEventListener('offline', () => {
  document.getElementById('offline-badge').style.display = 'block';
});

window.addEventListener('online', () => {
  document.getElementById('offline-badge').style.display = 'none';
});

if (!navigator.onLine) {
  document.getElementById('offline-badge').style.display = 'block';
}

// ============================================================
// GLOBAL SEARCH
// ============================================================
function globalSearch(val) {
  if (val && /^\d{4,}$/.test(val)) {
    navigate('invoices', null);
    filterInvoices(val);
  }
}

document.getElementById('global-search')?.addEventListener('input', e => {
  globalSearch(e.target.value.trim());
});

// ============================================================
// INIT
// ============================================================
initData();

// ============================================================
// PRINT INVOICE
// ============================================================
function printInvoice() {
  const inv = getAllInvoices().find(i => i.id === viewingInvoiceId);
  if (!inv) return;

  const pmLine = inv.payMethod
    ? '<div style="margin-top:6px;font-size:12px"><strong>Payment:</strong> ' +
      paymentLabel(inv.payMethod) +
      (inv.momoNumber ? ' — ' + escapeHtml(inv.momoNumber) : '') +
      '</div>'
    : '';

  const noteLine = inv.notes
    ? '<div style="margin-top:6px;font-size:12px"><strong>Notes:</strong> ' +
      escapeHtml(inv.notes) +
      '</div>'
    : '';

  const blanks = Array(Math.max(0, 8 - inv.items.length))
    .fill(`
      <tr>
        <td style="padding:8px 6px;border-bottom:1px solid #eee">&nbsp;</td>
        <td style="border-bottom:1px solid #eee"></td>
        <td style="border-bottom:1px solid #eee"></td>
        <td style="border-bottom:1px solid #eee"></td>
      </tr>
    `).join('');

  const rows = inv.items.map(item => `
    <tr>
      <td style="text-align:center;padding:8px 6px;border-bottom:1px solid #eee">
        ${item.qty}
      </td>

      <td style="padding:8px 6px;border-bottom:1px solid #eee">
        ${escapeHtml(item.name)}
      </td>

      <td style="text-align:right;padding:8px 6px;border-bottom:1px solid #eee;font-family:monospace">
        ${Number(item.price || 0).toFixed(2)}
      </td>

      <td style="text-align:right;padding:8px 6px;border-bottom:1px solid #eee;font-family:monospace;font-weight:700">
        ${Number(item.total || 0).toFixed(2)}
      </td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family:'DM Sans',Arial,sans-serif;font-size:12px;color:#000;max-width:620px;margin:0 auto">

      <table width="100%" cellpadding="0" cellspacing="0" style="background:#00184A;color:white;padding:12px 16px">
        <tr>
          <td>
            <div style="font-size:20px;font-weight:800;letter-spacing:1px">
              ULTIMATE DEE ELECTRICALS
            </div>

            <div style="font-size:11px;opacity:.85;margin-top:3px">
              Dealers in Quality Electrical Materials & Accessories
            </div>

            <div style="font-size:10px;opacity:.85;margin-top:4px">
              Techiman Ahmadiyya Road | Techiman Zongo Traffic | Kintampo
            </div>

            <div style="font-size:10px;opacity:.85;margin-top:3px">
              Tel: 0554898010 / 0553789807
            </div>
          </td>

          <td align="right">
            <div style="background:#F6C400;color:#00184A;padding:5px 10px;font-size:11px;font-weight:800;border-radius:4px">
              SALES INVOICE
            </div>
          </td>
        </tr>
      </table>

      <div style="background:#F6C400;color:#00184A;padding:8px 14px;display:flex;justify-content:space-between;font-weight:800;letter-spacing:.08em">
        <span>INVOICE</span>
        <span>No: ${escapeHtml(inv.number)}</span>
        <span>${fmtDate(inv.createdAt)}</span>
      </div>

      <div style="padding:12px 14px;border-left:2px solid #00184A;border-right:2px solid #00184A">
        <div><strong>Customer:</strong> ${escapeHtml(inv.customerName)}</div>
        ${inv.customerPhone ? '<div><strong>Tel:</strong> ' + escapeHtml(inv.customerPhone) + '</div>' : ''}
        ${inv.customerAddress ? '<div><strong>Address:</strong> ' + escapeHtml(inv.customerAddress) + '</div>' : ''}
      </div>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-left:2px solid #00184A;border-right:2px solid #00184A">
        <thead>
          <tr style="background:#00184A;color:white">
            <th style="padding:8px 6px;width:56px;text-align:center">QTY</th>
            <th style="padding:8px 6px;text-align:left">DESCRIPTION</th>
            <th style="padding:8px 6px;text-align:right">UNIT PRICE</th>
            <th style="padding:8px 6px;text-align:right">AMOUNT</th>
          </tr>
        </thead>

        <tbody>
          ${rows}
          ${blanks}
        </tbody>
      </table>

      <div style="border:2px solid #00184A;border-top:0;padding:12px 14px">
        <div style="text-align:right;font-size:13px">
          Subtotal: ${fmtGHS(inv.subtotal || inv.total)}
        </div>

        <div style="text-align:right;font-size:13px">
          Discount: -${fmtGHS(inv.discount || 0)}
        </div>

        <div style="text-align:right;font-size:17px;font-weight:800;color:#00184A">
          Total: ${fmtGHS(inv.total)}
        </div>

        <div style="margin-top:8px;font-size:11px;color:#555">
          <strong>Status:</strong> ${escapeHtml(String(inv.status || '').toUpperCase())}
          ${pmLine}
          ${noteLine}
        </div>
      </div>

      <div style="margin-top:10px;font-size:11px;color:#555">
        Branch: ${escapeHtml(inv.location || '')}
      </div>

      <div style="margin-top:4px;font-size:11px;color:#555">
        Prepared By: ${escapeHtml(inv.createdByName || 'System')}
      </div>

      <div style="margin-top:16px;text-align:center;font-size:10px;color:#666">
        Goods sold are not returnable after successful purchase
      </div>
    </div>
  `;

  const printArea = document.getElementById('print-area');
  printArea.innerHTML = html;
  window.print();
}

// ============================================================
// INITIAL SESSION RESTORE
// ============================================================
(async function restoreSession() {
  try {
    if (
      window.LumodaSupabase &&
      window.LumodaSupabase.isConfigured() &&
      autoLoginAllowed()
    ) {
      const sb = window.LumodaSupabase.getClient();
      const { data } = await sb.auth.getUser();
      const user = data?.user;

      if (user) {
        const { data: profile } = await window.LumodaSupabase.getProfile(user.id);

        if (profile && profile.active !== false) {
          currentUser = supabaseProfileToLocal(profile);
          currentLocation = currentUser.location;
          currentUser.token = registerSession(currentUser);

          await syncSupabaseCache();

          showApp();
          return;
        }
      }
    }
  } catch (e) {
    console.warn('Session restore failed', e);
  }

  showAuthScreen();
})();