require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const store = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const SETUP_KEY = process.env.SETUP_KEY;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.env.DATA_DIR || __dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Missing/weak JWT_SECRET. Set a random secret of at least 32 characters.');
  process.exit(1);
}
if (!SETUP_KEY || SETUP_KEY.length < 12) {
  console.error('Missing/weak SETUP_KEY. Set a private setup key of at least 12 characters.');
  process.exit(1);
}

app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // The storefront renders HTML with inline event handlers (onclick/onsubmit).
  // Keep Helmet's other protections, but disable CSP so those handlers can run.
  contentSecurityPolicy: false,
}));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Please try again later.' } });
const setupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many setup attempts. Please try again later.' } });
const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many orders from this connection. Please try again later.' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

const imageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(12).toString('hex') + ext);
  }
});
const upload = multer({
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP and GIF images are allowed.'));
  }
});

function newId(prefix) { return prefix + '-' + crypto.randomBytes(5).toString('hex'); }
function cleanText(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function normalizePhone(value) { return String(value ?? '').replace(/[^\d+]/g, '').slice(0, 20); }
function validMoney(value) { return Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000000; }
function validQty(value) { return Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000000; }

/* ---------- Auth ---------- */
function requireAdmin(req, res, next) {
  const token = req.cookies.gw_token;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('gw_token', cookieOptions());
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
}
function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' };
}
function issueSession(res, username) {
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('gw_token', token, cookieOptions());
}

app.get('/api/admin/status', (_req, res) => res.json({ hasAdmin: !!store.getData().admin }));

app.post('/api/admin/setup', setupLimiter, async (req, res) => {
  const data = store.getData();
  if (data.admin) return res.status(400).json({ error: 'Admin account already exists' });
  const { username, password, setupKey } = req.body || {};
  if (setupKey !== SETUP_KEY) return res.status(403).json({ error: 'Invalid setup key' });
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(String(username || ''))) return res.status(400).json({ error: 'Username must be 3–40 letters, numbers, dots, dashes or underscores' });
  if (!password || String(password).length < 10) return res.status(400).json({ error: 'Use a password of at least 10 characters' });
  data.admin = { username: String(username), passwordHash: await bcrypt.hash(String(password), 12) };
  await store.save();
  issueSession(res, data.admin.username);
  res.json({ ok: true });
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const data = store.getData();
  const { username, password } = req.body || {};
  if (!data.admin) return res.status(400).json({ error: 'No admin account yet' });
  const ok = data.admin.username === username && await bcrypt.compare(String(password || ''), data.admin.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect username or password' });
  issueSession(res, username);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (_req, res) => {
  res.clearCookie('gw_token', { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, path: '/' });
  res.json({ ok: true });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ username: req.admin.username }));

/* ---------- Settings ---------- */
app.get('/api/settings', (_req, res) => {
  const { storeName, tagline, currency, whatsappNumber, supportPhone } = store.getData().settings;
  res.json({ storeName, tagline, currency, whatsappNumber, supportPhone });
});
app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const data = store.getData();
  const { storeName, tagline, currency, whatsappNumber, supportPhone } = req.body || {};
  if (storeName !== undefined) data.settings.storeName = cleanText(storeName, 80) || 'Godwyn Stores';
  if (tagline !== undefined) data.settings.tagline = cleanText(tagline, 160);
  if (currency !== undefined) data.settings.currency = cleanText(currency, 10) || 'ZMW';
  if (whatsappNumber !== undefined) data.settings.whatsappNumber = String(whatsappNumber).replace(/\D/g, '').slice(0, 20);
  if (supportPhone !== undefined) data.settings.supportPhone = cleanText(supportPhone, 30);
  await store.save();
  res.json(data.settings);
});

/* ---------- Products ---------- */
app.get('/api/products', (_req, res) => res.json(store.getData().products));

function validateProductInput(body, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = cleanText(body.name, 100);
    if (!out.name) throw new Error('Product name is required');
  }
  if (!partial || body.price !== undefined) {
    if (!validMoney(body.price)) throw new Error('Enter a valid price');
    out.price = Number(body.price);
  }
  if (!partial || body.qty !== undefined) {
    if (!validQty(body.qty)) throw new Error('Enter a valid stock quantity');
    out.qty = Number(body.qty);
  }
  if (body.emoji !== undefined) out.emoji = cleanText(body.emoji, 10) || '📦';
  if (body.description !== undefined) out.description = cleanText(body.description, 500);
  if (body.imageUrl !== undefined) out.imageUrl = cleanText(body.imageUrl, 1000);
  return out;
}

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const p = validateProductInput(req.body || {});
    const product = { id: newId('P'), ...p, emoji: p.emoji || '📦', description: p.description || '', imageUrl: p.imageUrl || '' };
    store.getData().products.push(product);
    await store.save();
    res.json(product);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const product = store.getData().products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  try {
    Object.assign(product, validateProductInput(req.body || {}, true));
    await store.save();
    res.json(product);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/products/:id/image', requireAdmin, upload.single('image'), async (req, res) => {
  const product = store.getData().products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (!req.file) return res.status(400).json({ error: 'Choose an image first' });
  if (product.imageUrl && product.imageUrl.startsWith('/uploads/')) {
    const old = path.join(UPLOAD_DIR, path.basename(product.imageUrl));
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  product.imageUrl = '/uploads/' + req.file.filename;
  await store.save();
  res.json(product);
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const data = store.getData();
  const product = data.products.find(p => p.id === req.params.id);
  if (product?.imageUrl?.startsWith('/uploads/')) {
    const file = path.join(UPLOAD_DIR, path.basename(product.imageUrl));
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  data.products = data.products.filter(p => p.id !== req.params.id);
  await store.save();
  res.json({ ok: true });
});

/* ---------- Orders ---------- */
app.post('/api/orders', orderLimiter, async (req, res) => {
  const data = store.getData();
  const { items, customerName, phone, address, notes } = req.body || {};
  const name = cleanText(customerName, 100);
  const customerPhone = normalizePhone(phone);
  const deliveryAddress = cleanText(address, 500);
  const orderNotes = cleanText(notes, 500);
  if (!Array.isArray(items) || items.length === 0 || items.length > 50 || !name || customerPhone.length < 7 || !deliveryAddress) {
    return res.status(400).json({ error: 'Please provide valid name, phone, address and at least one item' });
  }

  const resolvedItems = [];
  const requested = new Map();
  for (const item of items) {
    const id = cleanText(item?.id, 100);
    const qty = Number(item?.qty);
    if (!id || !Number.isInteger(qty) || qty < 1 || qty > 1000) return res.status(400).json({ error: 'Invalid cart item' });
    requested.set(id, (requested.get(id) || 0) + qty);
  }
  for (const [id, qty] of requested) {
    const product = data.products.find(p => p.id === id);
    if (!product) return res.status(400).json({ error: 'One of the items in your cart no longer exists' });
    if (product.qty < qty) return res.status(400).json({ error: `"${product.name}" no longer has enough stock` });
    resolvedItems.push({ id: product.id, name: product.name, price: product.price, qty });
  }

  resolvedItems.forEach(item => { data.products.find(p => p.id === item.id).qty -= item.qty; });
  const total = resolvedItems.reduce((sum, i) => sum + i.qty * i.price, 0);
  const order = { id: newId('ORD'), items: resolvedItems, total, customerName: name, phone: customerPhone, address: deliveryAddress, notes: orderNotes, status: 'new', createdAt: new Date().toISOString() };
  data.orders.unshift(order);

  let customer = data.customers.find(c => c.phone === customerPhone);
  if (customer) {
    customer.name = name; customer.address = deliveryAddress;
    customer.orderCount = (customer.orderCount || 0) + 1;
    customer.totalSpent = (customer.totalSpent || 0) + total;
    customer.lastOrderAt = order.createdAt;
  } else {
    data.customers.push({ phone: customerPhone, name, address: deliveryAddress, orderCount: 1, totalSpent: total, lastOrderAt: order.createdAt, crmNotes: '' });
  }
  await store.save();

  const waNumber = String(data.settings.whatsappNumber || '').replace(/\D/g, '');
  const waMessage = encodeURIComponent(`Hello Godwyn Stores, I placed order ${order.id}. Total: ${data.settings.currency} ${total.toFixed(2)}. My name is ${name}.`);
  res.json({ orderId: order.id, whatsappUrl: waNumber ? `https://wa.me/${waNumber}?text=${waMessage}` : null });
});

app.get('/api/admin/orders', requireAdmin, (_req, res) => res.json(store.getData().orders));
app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const order = store.getData().orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { status } = req.body || {};
  if (!['new', 'contacted', 'delivered', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  order.status = status; await store.save(); res.json(order);
});

/* ---------- CRM ---------- */
app.get('/api/admin/customers', requireAdmin, (_req, res) => res.json(store.getData().customers));
app.patch('/api/admin/customers/:phone', requireAdmin, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const customer = store.getData().customers.find(c => c.phone === phone);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (req.body?.crmNotes !== undefined) customer.crmNotes = cleanText(req.body.crmNotes, 1000);
  await store.save(); res.json(customer);
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Image upload failed: ' + err.message });
  if (err?.message?.includes('Only JPG')) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Godwyn Stores running on http://localhost:${PORT}`));
