window.addEventListener('error', (event) => {
  const app = document.getElementById('app');
  if (app && !app.innerHTML.trim()) {
    app.innerHTML = `<div class="wrap"><div class="panel"><h2>Godwyn Stores</h2><p>There was a problem loading the storefront.</p><p class="muted">Please refresh the page. If the problem continues, contact support.</p></div></div>`;
  }
});

const state = {
  view: 'store', // store | confirm | admin-auth | admin
  loading: true,
  products: [],
  cart: {},
  orders: [],
  customers: [],
  hasAdmin: false,
  isAdmin: false,
  adminTab: 'stock',
  settings: { storeName: 'Godwyn Stores', tagline: 'Quality goods, delivered across Zambia.', currency: 'ZMW', whatsappNumber: '0760565047', supportPhone: '0760565047' },
  cartOpen: false,
  toast: null,
  editingProductId: null,
  authError: '',
  lastOrderId: null,
  lastOrderWhatsappUrl: null,
};

/* ---------------- API helper ---------------- */
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

function money(n) {
  return state.settings.currency + ' ' + Number(n || 0).toFixed(2);
}
function whatsappUrl(message = '') {
  const n = String(state.settings.whatsappNumber || '').replace(/\D/g, '');
  return n ? 'https://wa.me/' + n + (message ? '?text=' + encodeURIComponent(message) : '') : '#';
}
function showToast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => { state.toast = null; render(); }, 2500);
}

/* ---------------- Init ---------------- */
async function init() {
  try {
    const [products, settings, adminStatus] = await Promise.all([
      api('/api/products'),
      api('/api/settings'),
      api('/api/admin/status'),
    ]);
    state.products = products;
    state.settings = settings;
    state.hasAdmin = adminStatus.hasAdmin;
    // If already logged in (valid cookie), /api/admin/me will succeed
    try {
      await api('/api/admin/me');
      state.isAdmin = true;
    } catch (e) { /* not logged in, fine */ }
  } catch (e) {
    showToast('Could not reach the server: ' + e.message);
  }
  state.loading = false;
  render();
}

/* ---------------- Cart ---------------- */
function cartItemsArray() {
  return Object.entries(state.cart).map(([id, qty]) => {
    const p = state.products.find(p => p.id === id);
    return p ? { id, qty, name: p.name, price: p.price } : null;
  }).filter(Boolean);
}
function cartTotal() { return cartItemsArray().reduce((s, i) => s + i.qty * i.price, 0); }
function cartCount() { return Object.values(state.cart).reduce((a, b) => a + b, 0); }
function addToCart(id) {
  const p = state.products.find(p => p.id === id);
  if (!p || p.qty <= 0) return;
  const current = state.cart[id] || 0;
  if (current >= p.qty) { showToast('Only ' + p.qty + ' left in stock'); return; }
  state.cart[id] = current + 1;
  render();
}
function decFromCart(id) {
  if (!state.cart[id]) return;
  state.cart[id] -= 1;
  if (state.cart[id] <= 0) delete state.cart[id];
  render();
}
function removeFromCart(id) { delete state.cart[id]; render(); }
function toggleCart(open) { state.cartOpen = open; render(); }

/* ---------------- Checkout ---------------- */
async function submitOrder(formEl) {
  const data = new FormData(formEl);
  const customerName = (data.get('name') || '').trim();
  const phone = (data.get('phone') || '').trim();
  const address = (data.get('address') || '').trim();
  const notes = (data.get('notes') || '').trim();
  if (!customerName || !phone || !address) { showToast('Please fill in name, phone and address'); return; }
  const items = cartItemsArray().map(i => ({ id: i.id, qty: i.qty }));
  if (items.length === 0) { showToast('Your cart is empty'); return; }

  try {
    const result = await api('/api/orders', { method: 'POST', body: { items, customerName, phone, address, notes } });
    state.cart = {};
    state.cartOpen = false;
    state.lastOrderId = result.orderId;
    state.lastOrderWhatsappUrl = result.whatsappUrl || null;
    state.view = 'confirm';
    // refresh product stock
    state.products = await api('/api/products');
    render();
  } catch (e) {
    showToast(e.message);
  }
}

/* ---------------- Admin auth ---------------- */
async function handleAuthSubmit(formEl) {
  const data = new FormData(formEl);
  const username = (data.get('username') || '').trim();
  const password = (data.get('password') || '').trim();
  if (!username || !password) { showToast('Enter a username and password'); return; }
  state.authError = '';
  try {
    if (!state.hasAdmin) {
      const setupKey = (data.get('setupKey') || '').trim();
      await api('/api/admin/setup', { method: 'POST', body: { username, password, setupKey } });
      state.hasAdmin = true;
    } else {
      await api('/api/admin/login', { method: 'POST', body: { username, password } });
    }
    state.isAdmin = true;
    state.view = 'admin';
    await loadAdminData();
    render();
  } catch (e) {
    state.authError = e.message;
    render();
  }
}
async function logout() {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) {}
  state.isAdmin = false;
  state.view = 'store';
  render();
}
async function loadAdminData() {
  const [orders, customers] = await Promise.all([
    api('/api/admin/orders'),
    api('/api/admin/customers'),
  ]);
  state.orders = orders;
  state.customers = customers;
}

/* ---------------- Admin: settings & stock ---------------- */
async function saveSettingsForm(formEl) {
  const data = new FormData(formEl);
  try {
    state.settings = await api('/api/admin/settings', {
      method: 'PUT',
      body: {
        storeName: (data.get('storeName') || '').trim(),
        tagline: (data.get('tagline') || '').trim(),
        currency: (data.get('currency') || '').trim() || 'ZMW',
        whatsappNumber: (data.get('whatsappNumber') || '').trim(),
        supportPhone: (data.get('supportPhone') || '').trim(),
      },
    });
    showToast('Store details saved');
    render();
  } catch (e) { showToast(e.message); }
}
function startNewProduct() { state.editingProductId = 'new'; render(); }
function startEditProduct(id) { state.editingProductId = id; render(); }
function cancelEditProduct() { state.editingProductId = null; render(); }
async function saveProductForm(formEl) {
  const data = new FormData(formEl);
  const body = {
    name: (data.get('name') || '').trim(),
    price: parseFloat(data.get('price')),
    qty: parseInt(data.get('qty'), 10),
    emoji: (data.get('emoji') || '').trim() || '📦',
    description: (data.get('description') || '').trim(),
    imageUrl: (data.get('imageUrl') || '').trim(),
  };
  if (!body.name || isNaN(body.price) || body.price < 0 || isNaN(body.qty) || body.qty < 0) {
    showToast('Fill in a valid name, price and quantity'); return;
  }
  try {
    let savedProduct;
    if (state.editingProductId === 'new') {
      savedProduct = await api('/api/admin/products', { method: 'POST', body });
      state.products.push(savedProduct);
      showToast('Product added');
    } else {
      const updated = await api('/api/admin/products/' + state.editingProductId, { method: 'PUT', body });
      const idx = state.products.findIndex(p => p.id === updated.id);
      state.products[idx] = updated;
      savedProduct = updated;
      showToast('Product updated');
    }
    const imageFile = formEl.querySelector('[name="image"]')?.files?.[0];
    if (imageFile) {
      const fd = new FormData();
      fd.append('image', imageFile);
      const uploaded = await fetch('/api/admin/products/' + savedProduct.id + '/image', {
        method: 'POST', credentials: 'include', body: fd
      });
      const uploadData = await uploaded.json();
      if (!uploaded.ok) throw new Error(uploadData.error || 'Image upload failed');
      const idx = state.products.findIndex(p => p.id === uploadData.id);
      if (idx >= 0) state.products[idx] = uploadData;
    }
    state.editingProductId = null;
    render();
  } catch (e) { showToast(e.message); }
}
async function deleteProduct(id) {
  if (!confirm('Remove this product from the store?')) return;
  try {
    await api('/api/admin/products/' + id, { method: 'DELETE' });
    state.products = state.products.filter(p => p.id !== id);
    render();
  } catch (e) { showToast(e.message); }
}

/* ---------------- Admin: orders & customers ---------------- */
async function setOrderStatus(orderId, status) {
  try {
    const updated = await api('/api/admin/orders/' + orderId, { method: 'PATCH', body: { status } });
    const idx = state.orders.findIndex(o => o.id === orderId);
    state.orders[idx] = updated;
    render();
  } catch (e) { showToast(e.message); }
}
async function saveCustomerNotes(phone, formEl) {
  const data = new FormData(formEl);
  try {
    const updated = await api('/api/admin/customers/' + encodeURIComponent(phone), {
      method: 'PATCH', body: { crmNotes: (data.get('crmNotes') || '').trim() },
    });
    const idx = state.customers.findIndex(c => c.phone === phone);
    state.customers[idx] = updated;
    showToast('Note saved');
  } catch (e) { showToast(e.message); }
}

/* ---------------- Render ---------------- */
function render() {
  const app = document.getElementById('app');
  if (state.loading) { app.innerHTML = '<div class="wrap"><p class="muted">Loading store…</p></div>'; return; }
  if (state.view === 'store') return renderStore(app);
  if (state.view === 'confirm') return renderConfirm(app);
  if (state.view === 'admin-auth') return renderAuth(app);
  if (state.view === 'admin') return renderAdmin(app);
}

function topbar() {
  return `
  <div class="topbar">
    <div><p class="brand">${escapeHtml(state.settings.storeName)}<small>${escapeHtml(state.settings.tagline)}</small></p></div>
    <div class="topbar-right">
      ${state.view === 'store' ? `<button class="cart-pill" onclick="toggleCart(true)">🧺 Cart · ${cartCount()}</button>` : ''}
      ${state.isAdmin
        ? `<a class="icon-link" href="#" onclick="event.preventDefault(); state.view='admin'; render();">Dashboard</a><a class="icon-link" href="#" onclick="event.preventDefault(); logout();">Log out</a>`
        : `<a class="icon-link" href="#" onclick="event.preventDefault(); state.view='admin-auth'; render();">Store login</a>`}
    </div>
  </div>`;
}

function renderStore(app) {
  const products = state.products;
  app.innerHTML = `
    ${topbar()}
    <div class="wrap">
      <div class="section-head"><h2>Available stock</h2><span class="muted">${products.length} item${products.length===1?'':'s'}</span></div>
      ${products.length === 0 ? `<div class="empty-state">No products posted yet. Check back soon.</div>` : `<div class="grid">${products.map(productCard).join('')}</div>`}
    </div>
    <footer>Orders are confirmed by phone — pay by cash or bank transfer on delivery.<br>
<strong>${escapeHtml(state.settings.supportPhone || '0760565047')}</strong> ·
<a href="${escapeHtml(whatsappUrl())}" target="_blank" rel="noopener">WhatsApp us</a></footer>
    <button class="btn cart-fab" onclick="toggleCart(true)" style="display:${state.cartOpen?'none':'block'}">🧺 ${cartCount()}</button>
    ${cartDrawer()}
    ${toastHtml()}
  `;
}

function productCard(p) {
  const inCart = state.cart[p.id] || 0;
  const out = p.qty <= 0;
  const low = !out && p.qty <= 3;
  return `
  <div class="card">
    <div class="swatch">${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)}" loading="lazy">` : (p.emoji || '📦')}</div>
    <h3>${escapeHtml(p.name)}</h3>
    <div class="desc">${escapeHtml(p.description || '')}</div>
    <div class="price-row">
      <span class="price">${money(p.price)}</span>
      <span class="stock-note ${out?'out':low?'low':''}">${out ? 'Out of stock' : low ? p.qty + ' left' : p.qty + ' in stock'}</span>
    </div>
    ${out ? `<button class="btn full" disabled>Out of stock</button>` :
      inCart > 0 ? `<div class="qty-row"><div class="stepper"><button onclick="decFromCart('${p.id}')">−</button><span>${inCart}</span><button onclick="addToCart('${p.id}')">+</button></div><span class="muted">in cart</span></div>` :
      `<button class="btn full" onclick="addToCart('${p.id}')">Add to cart</button>`}
  </div>`;
}

function cartDrawer() {
  const items = cartItemsArray();
  return `
  <div class="drawer-backdrop ${state.cartOpen?'open':''}" onclick="toggleCart(false)"></div>
  <div class="drawer ${state.cartOpen?'open':''}">
    <div class="drawer-head"><h3 style="margin:0;">Your order</h3><button class="close-x" onclick="toggleCart(false)">✕</button></div>
    <div class="drawer-body">
      ${items.length === 0 ? `<p class="muted">Your cart is empty.</p>` : items.map(i => `
        <div class="cart-line">
          <div><div class="name">${escapeHtml(i.name)}</div><div class="muted">${i.qty} × ${money(i.price)}</div></div>
          <div style="display:flex;align-items:center;gap:8px;"><span>${money(i.qty*i.price)}</span><button class="close-x" onclick="removeFromCart('${i.id}')">✕</button></div>
        </div>`).join('')}
      ${items.length > 0 ? `
      <form id="checkout-form" onsubmit="event.preventDefault(); submitOrder(this);" style="margin-top:16px;">
        <div class="field"><label>Full name</label><input name="name" required></div>
        <div class="field"><label>Phone number</label><input name="phone" required></div>
        <div class="field"><label>Delivery address</label><textarea name="address" required></textarea></div>
        <div class="field"><label>Notes (optional)</label><textarea name="notes"></textarea></div>
      </form>` : ''}
    </div>
    ${items.length > 0 ? `<div class="drawer-foot"><div class="total-row"><span>Total</span><span>${money(cartTotal())}</span></div><button class="btn full" type="submit" form="checkout-form">Place order — pay on delivery</button></div>` : ''}
  </div>`;
}

function renderConfirm(app) {
  app.innerHTML = `
  ${topbar()}
  <div class="wrap">
    <div class="panel" style="max-width:480px;margin:40px auto;text-align:center;">
      <h2>Order placed 🎉</h2>
      <p>Order <strong>${state.lastOrderId}</strong> has been received.</p>
      <p class="muted">We'll call you shortly to confirm delivery. Pay by cash or bank transfer when your order arrives.</p>
      ${state.lastOrderWhatsappUrl ? `<a class="btn" href="${escapeHtml(state.lastOrderWhatsappUrl)}" target="_blank" rel="noopener">Confirm on WhatsApp</a>` : ''}
      <button class="btn ghost" onclick="state.view='store'; render();">Back to store</button>
    </div>
  </div>`;
}

function renderAuth(app) {
  const needsSetup = !state.hasAdmin;
  app.innerHTML = `
  ${topbar()}
  <div class="wrap">
    <div class="login-wrap">
      <h2>${needsSetup ? 'Set up your store login' : 'Store login'}</h2>
      ${needsSetup ? `<p class="muted">No admin account exists yet — create one now to manage stock and orders.</p>` : ''}
      <form onsubmit="event.preventDefault(); handleAuthSubmit(this);">
        ${needsSetup ? `<div class="field"><label>Private setup key</label><input name="setupKey" type="password" required autocomplete="off"><small class="muted">This key is set in your hosting environment and is not your login password.</small></div>` : ''}
        <div class="field"><label>Username</label><input name="username" required autocomplete="username"></div>
        <div class="field"><label>Password</label><input name="password" type="password" required minlength="${needsSetup?6:1}"></div>
        <button class="btn full" type="submit">${needsSetup ? 'Create account & log in' : 'Log in'}</button>
        ${state.authError ? `<p class="error-text">${escapeHtml(state.authError)}</p>` : ''}
      </form>
      <p class="muted" style="margin-top:12px;"><a href="#" onclick="event.preventDefault(); state.view='store'; render();">← Back to store</a></p>
    </div>
  </div>`;
}

function renderAdmin(app) {
  const newCount = state.orders.filter(o => o.status === 'new').length;
  app.innerHTML = `
  ${topbar()}
  <div class="wrap">
    <div class="top-admin-bar"><h2 style="margin:0;">Dashboard</h2><span class="muted">${newCount} new order${newCount===1?'':'s'}</span></div>
    <div class="tabbar">
      <button class="${state.adminTab==='stock'?'active':''}" onclick="state.adminTab='stock'; render();">Stock</button>
      <button class="${state.adminTab==='orders'?'active':''}" onclick="state.adminTab='orders'; render();">Orders</button>
      <button class="${state.adminTab==='customers'?'active':''}" onclick="state.adminTab='customers'; render();">Customers (CRM)</button>
    </div>
    ${state.adminTab === 'stock' ? renderStockTab() : ''}
    ${state.adminTab === 'orders' ? renderOrdersTab() : ''}
    ${state.adminTab === 'customers' ? renderCustomersTab() : ''}
  </div>
  ${toastHtml()}`;
}

function renderStockTab() {
  const editing = state.editingProductId;
  const editingProduct = editing && editing !== 'new' ? state.products.find(p => p.id === editing) : null;
  return `
    <div class="panel">
      <h3 style="margin-top:0;">Store details</h3>
      <form onsubmit="event.preventDefault(); saveSettingsForm(this);">
        <div class="form-grid">
          <div class="field"><label>Store name</label><input name="storeName" value="${escapeHtml(state.settings.storeName)}"></div>
          <div class="field"><label>Tagline</label><input name="tagline" value="${escapeHtml(state.settings.tagline)}"></div>
          <div class="field"><label>Currency</label><input name="currency" value="${escapeHtml(state.settings.currency || 'ZMW')}" style="width:100px;"></div>
          <div class="field"><label>WhatsApp number</label><input name="whatsappNumber" value="${escapeHtml(state.settings.whatsappNumber || '0760565047')}" placeholder="260XXXXXXXXX"></div>
          <div class="field"><label>Support phone</label><input name="supportPhone" value="${escapeHtml(state.settings.supportPhone || '0760565047')}"></div>
        </div>
        <button class="btn" type="submit">Save</button>
      </form>
    </div>
    <div class="section-head"><h2>Stock</h2><button class="btn" onclick="startNewProduct()">+ Add product</button></div>
    ${editing ? `
    <div class="panel">
      <h3 style="margin-top:0;">${editing==='new' ? 'New product' : 'Edit product'}</h3>
      <form onsubmit="event.preventDefault(); saveProductForm(this);">
        <div class="form-grid">
          <div class="field"><label>Name</label><input name="name" required value="${escapeHtml(editingProduct?.name||'')}"></div>
          <div class="field"><label>Product photo</label><input name="image" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></div>
          <div class="field"><label>Image URL (optional)</label><input name="imageUrl" type="url" placeholder="https://..." value="${escapeHtml(editingProduct?.imageUrl||'')}"></div>
          <div class="field"><label>Emoji / icon fallback</label><input name="emoji" placeholder="📦" value="${escapeHtml(editingProduct?.emoji||'')}"></div>
          <div class="field"><label>Price</label><input name="price" type="number" step="0.01" min="0" required value="${editingProduct?.price ?? ''}"></div>
          <div class="field"><label>Quantity in stock</label><input name="qty" type="number" step="1" min="0" required value="${editingProduct?.qty ?? ''}"></div>
        </div>
        <div class="field"><label>Description</label><textarea name="description">${escapeHtml(editingProduct?.description||'')}</textarea></div>
        <div class="row-actions">
          <button class="btn" type="submit">Save product</button>
          <button class="btn ghost" type="button" onclick="cancelEditProduct()">Cancel</button>
        </div>
      </form>
    </div>` : ''}
    ${state.products.length === 0 ? `<div class="empty-state">No products yet — add your first one above.</div>` : `
    <table>
      <thead><tr><th></th><th>Name</th><th>Price</th><th>Qty</th><th></th></tr></thead>
      <tbody>
        ${state.products.map(p => `
        <tr>
          <td>${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px;">` : (p.emoji||'📦')}</td>
          <td>${escapeHtml(p.name)}</td>
          <td>${money(p.price)}</td>
          <td>${p.qty <= 0 ? '<span class="badge cancelled">Out</span>' : p.qty<=3 ? '<span class="badge new">'+p.qty+' low</span>' : p.qty}</td>
          <td class="row-actions">
            <button class="btn small ghost" onclick="startEditProduct('${p.id}')">Edit</button>
            <button class="btn small alert" onclick="deleteProduct('${p.id}')">Remove</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`}
  `;
}

function renderOrdersTab() {
  if (state.orders.length === 0) return `<div class="empty-state">No orders yet.</div>`;
  return `
  <table>
    <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr></thead>
    <tbody>
      ${state.orders.map(o => `
      <tr>
        <td>${o.id}<div class="muted">${new Date(o.createdAt).toLocaleString()}</div></td>
        <td>${escapeHtml(o.customerName)}<div class="muted">${escapeHtml(o.phone)}</div></td>
        <td>${o.items.map(i => i.qty+'× '+escapeHtml(i.name)).join(', ')}</td>
        <td>${money(o.total)}</td>
        <td><span class="badge ${o.status}">${o.status}</span></td>
        <td><select onchange="setOrderStatus('${o.id}', this.value)">${['new','contacted','delivered','cancelled'].map(s=>`<option value="${s}" ${o.status===s?'selected':''}>${s}</option>`).join('')}</select></td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderCustomersTab() {
  if (state.customers.length === 0) return `<div class="empty-state">No customers yet — they'll appear here after their first order.</div>`;
  const sorted = [...state.customers].sort((a, b) => new Date(b.lastOrderAt) - new Date(a.lastOrderAt));
  return sorted.map(c => `
    <div class="panel">
      <div class="section-head">
        <div><h3 style="margin:0;">${escapeHtml(c.name)}</h3><span class="muted">${escapeHtml(c.phone)} · ${escapeHtml(c.address)}</span></div>
        <div style="text-align:right;"><div>${c.orderCount} order${c.orderCount===1?'':'s'} · ${money(c.totalSpent)} total</div><div class="muted">Last order: ${new Date(c.lastOrderAt).toLocaleDateString()}</div></div>
      </div>
      <form onsubmit="event.preventDefault(); saveCustomerNotes('${c.phone}', this);">
        <div class="field"><label>Support notes</label><textarea name="crmNotes" placeholder="e.g. prefers evening delivery, called about a refund...">${escapeHtml(c.crmNotes||'')}</textarea></div>
        <button class="btn small" type="submit">Save note</button>
      </form>
    </div>`).join('');
}

function toastHtml() { return state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''; }
function escapeHtml(str) { return String(str ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

init();
