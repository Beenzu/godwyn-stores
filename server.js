require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const QUIVERCRM_URL = String(process.env.QUIVERCRM_URL || '').replace(/\/$/, '');
const QUIVERCRM_KEY = process.env.QUIVERCRM_KEY;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSET_DIR = process.env.IMAGE_ASSET_DIR || path.join(PUBLIC_DIR, 'assets');
const IMAGE_UPLOAD_DIR = path.join(ASSET_DIR, '_admin_uploads');
const IMAGE_MAP_FILE = path.join(ASSET_DIR, '.admin-image-map.json');

function envValue(name) {
  let v = String(process.env[name] || '').trim();
  // Remove accidental matching quotes commonly pasted into Render values.
  if (v.length >= 2 && ((v[0] === '"' && v[v.length-1] === '"') || (v[0] === "'" && v[v.length-1] === "'"))) {
    v = v.slice(1,-1).trim();
  }
  return v;
}

const ADMIN_PASSWORD = envValue('IMAGE_ADMIN_PASSWORD') || envValue('ADMIN_PASSWORD');
const ADMIN_SECRET = envValue('IMAGE_ADMIN_SECRET') || envValue('QUIVERCRM_KEY') ||
  (ADMIN_PASSWORD ? crypto.createHash('sha256').update('flavors-tea-admin:' + ADMIN_PASSWORD).digest('hex') : '');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/* ---------- Gmail order notifications ----------
 * GMAIL_USER          the Gmail address that sends the notification
 * GMAIL_APP_PASSWORD  a 16-character Google "App Password" for that account
 *                     (requires 2-Step Verification on the Google account)
 * ORDER_NOTIFY_EMAIL  where order emails go (defaults to GMAIL_USER)
 * If GMAIL_USER or GMAIL_APP_PASSWORD is missing, orders still work and no
 * email is sent.
 */
const GMAIL_USER = envValue('GMAIL_USER');
const GMAIL_APP_PASSWORD = envValue('GMAIL_APP_PASSWORD').replace(/\s+/g, '');
const ORDER_NOTIFY_EMAIL = envValue('ORDER_NOTIFY_EMAIL') || GMAIL_USER;
const mailer = (GMAIL_USER && GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } })
  : null;

fs.mkdirSync(ASSET_DIR, { recursive: true });
fs.mkdirSync(IMAGE_UPLOAD_DIR, { recursive: true });
// Uploads are written to disk. On hosts like Render the default folder is
// wiped on every redeploy, so uploads only survive when IMAGE_ASSET_DIR points
// at a persistent disk.
if (IS_PRODUCTION && !process.env.IMAGE_ASSET_DIR) {
  console.warn('WARNING: IMAGE_ASSET_DIR is not set. Uploaded images will be lost on the next redeploy. Point it at a persistent disk.');
}

function readImageMap() {
  try {
    const data = JSON.parse(fs.readFileSync(IMAGE_MAP_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}
function writeImageMap(map) {
  fs.writeFileSync(IMAGE_MAP_FILE, JSON.stringify(map, null, 2));
}
function mimeForUploadedImage(buffer, filename='', declaredMime='') {
  const declared = String(declaredMime || '').toLowerCase().trim();
  if (declared === 'image/jpg') return 'image/jpeg';
  if (declared.startsWith('image/')) return declared;
  if (buffer.length >= 8 && buffer.slice(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer.slice(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) return 'image/jpeg';
  if (buffer.length >= 6 && (buffer.slice(0,6).toString() === 'GIF87a' || buffer.slice(0,6).toString() === 'GIF89a')) return 'image/gif';
  if (buffer.length >= 12 && buffer.slice(0,4).toString() === 'RIFF' && buffer.slice(8,12).toString() === 'WEBP') return 'image/webp';
  const lower = String(filename).toLowerCase();
  const byExt = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.avif':'image/avif','.bmp':'image/bmp','.tif':'image/tiff','.tiff':'image/tiff','.ico':'image/x-icon'};
  return byExt[path.extname(lower)] || '';
}

app.disable('x-powered-by');
app.use(express.json({ limit: '18mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

app.use('/assets', (req, res, next) => {
  const requested = path.basename(decodeURIComponent(req.path || ''));
  const map = readImageMap();
  const mapped = map[requested];
  if (!mapped) return next();
  const file = path.join(IMAGE_UPLOAD_DIR, mapped.file);
  if (!fs.existsSync(file)) return next();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Content-Type', mapped.mime || 'application/octet-stream');
  res.sendFile(file);
});
app.use('/assets', express.static(ASSET_DIR, { maxAge: 0, etag: true }));

// Always serve the admin page fresh so an old browser/CDN copy cannot keep the old login code.
app.get('/admin.html', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

function clean(v, max=500) { return String(v ?? '').trim().slice(0, max); }
function phone(v) { return String(v ?? '').replace(/[^0-9+]/g, '').slice(0, 25); }

/*
 * These five slots are the exact image URLs used by public/index.html.
 * Uploading to a slot replaces that image on the storefront without changing
 * the HTML. Do not rename these files unless index.html is changed to match.
 */
const STOREFRONT_IMAGES = ["home-1-poor-sleep.webp", "home-2-weight.webp", "home-3-bad-breath.webp", "home-4-good-health.webp", "home-5-brighter-day.webp"];

const IMAGE_SLOTS = STOREFRONT_IMAGES.map((filename, i) => ({
  id: 'image-' + (i + 1),
  label: 'Storefront image ' + (i + 1),
  filename
}));

function safeSlot(id) {
  return IMAGE_SLOTS.find(s => s.id === id);
}

function safeImageExtension(mime, originalName='') {
  const normalized = String(mime || '').toLowerCase().trim();
  const known = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico'
  };
  if (known[normalized]) return known[normalized];

  // No image-format allowlist: preserve a safe extension for any image/*
  // MIME type supplied by the browser.
  if (normalized.startsWith('image/')) {
    const subtype = normalized.slice(6).split(';')[0].replace(/[^a-z0-9]+/gi, '');
    if (subtype) return '.' + subtype.slice(0, 12).toLowerCase();
  }

  const ext = path.extname(String(originalName || '')).toLowerCase();
  return /^[.][a-z0-9]{1,12}$/.test(ext) ? ext : '.img';
}

/* ---------- Admin session ---------- */
function signSession() {
  const payload = `${Date.now()}:${crypto.randomBytes(12).toString('hex')}`;
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function validSession(token) {
  if (!ADMIN_SECRET || !token) return false;
  try {
    const raw = Buffer.from(String(token), 'base64url').toString();
    const parts = raw.split(':');
    if (parts.length !== 3) return false;
    const [time, nonce, sig] = parts;
    const timestamp = Number(time);
    if (!Number.isFinite(timestamp) || Date.now() - timestamp > 7 * 24 * 60 * 60 * 1000) return false;
    const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(`${time}:${nonce}`).digest('hex');
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { return false; }
}

function cookieToken(req) {
  const m = /(?:^|;\s*)ft_admin=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function requireImageAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ok:false,error:'Image admin is not configured. Set IMAGE_ADMIN_PASSWORD in Render.'});
  if (!validSession(cookieToken(req))) return res.status(401).json({ok:false,error:'Please log in.'});
  next();
}

app.post('/api/admin/image-login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ok:false,error:'Image admin is not configured. Set IMAGE_ADMIN_PASSWORD in Render.'});
  const supplied = String(req.body?.password ?? '').trim();
  const ok = supplied === ADMIN_PASSWORD;
  if (!ok) return res.status(401).json({ok:false,error:'Incorrect admin password.'});
  const token = signSession();
  res.setHeader('Set-Cookie', `ft_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${IS_PRODUCTION ? '; Secure' : ''}; Max-Age=604800`);
  res.json({ok:true});
});

app.post('/api/admin/image-logout', (_req, res) => {
  res.setHeader('Set-Cookie', `ft_admin=; Path=/; HttpOnly; SameSite=Lax${IS_PRODUCTION ? '; Secure' : ''}; Max-Age=0`);
  res.json({ok:true});
});

app.get('/api/admin/image-me', requireImageAdmin, (_req, res) => res.json({ok:true}));

app.get('/api/admin/image-slots', requireImageAdmin, (_req, res) => {
  const map = readImageMap();
  res.json({slots: IMAGE_SLOTS.map(s => {
    const p = path.join(ASSET_DIR, s.filename);
    let exists = false, version = 0;
    try {
      const st = fs.statSync(p);
      exists = st.isFile();
      version = exists ? st.mtimeMs : 0;
    } catch {}
    // An uploaded replacement counts as an image even when the original
    // file is not in the assets folder.
    const overridden = Boolean(map[s.filename]);
    if (overridden) exists = true;
    if (map[s.filename]?.uploadedAt) version = new Date(map[s.filename].uploadedAt).getTime();
    return {...s, group:'Storefront images', exists, version, overridden, mime:map[s.filename]?.mime || null, url:`/assets/${encodeURIComponent(s.filename)}`};
  })});
});

// IMPORTANT: no image-format or source-folder whitelist.
// Any data:image/* upload is accepted and stored as uploaded.
function parseImageUpload(raw) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(raw || '').trim());
  if (!m) return {error:'Please choose a valid image file.'};
  const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  const buffer = Buffer.from(m[2].replace(/\s/g,''), 'base64');
  if (!buffer.length) return {error:'The selected image is empty.'};
  if (buffer.length > 12 * 1024 * 1024) return {error:'Image must be 12 MB or smaller.'};
  return {mime, buffer};
}

function storeImageFile(buffer, mime) {
  const storedName = crypto.randomBytes(16).toString('hex') + safeImageExtension(mime);
  fs.writeFileSync(path.join(IMAGE_UPLOAD_DIR, storedName), buffer);
  return storedName;
}

app.post('/api/admin/image-slots/:id', requireImageAdmin, (req, res) => {
  const slot = safeSlot(req.params.id);
  if (!slot) return res.status(404).json({ok:false,error:'Unknown image slot.'});

  const parsed = parseImageUpload(req.body?.data);
  if (parsed.error) return res.status(400).json({ok:false,error:parsed.error});

  const storedName = storeImageFile(parsed.buffer, parsed.mime);
  const map = readImageMap();
  const previous = map[slot.filename];
  map[slot.filename] = { file: storedName, mime: parsed.mime, uploadedAt: new Date().toISOString() };
  writeImageMap(map);

  // Keep the original storefront URL/filename unchanged. The browser receives
  // the correct MIME type for whatever image the admin uploaded.
  if (previous?.file && previous.file !== storedName) {
    try { fs.unlinkSync(path.join(IMAGE_UPLOAD_DIR, previous.file)); } catch {}
  }

  res.json({ok:true,url:`/assets/${encodeURIComponent(slot.filename)}`,filename:slot.filename,mime:parsed.mime});
});

// General uploads: any image, not tied to a storefront slot or the assets folder.
// Each upload gets its own URL under /assets/.
const FREE_UPLOAD_PREFIX = 'free-upload-';

app.get('/api/admin/uploads', requireImageAdmin, (_req, res) => {
  const map = readImageMap();
  const uploads = Object.entries(map)
    .filter(([key]) => key.startsWith(FREE_UPLOAD_PREFIX))
    .map(([key, v]) => ({
      filename: key,
      mime: v.mime || null,
      uploadedAt: v.uploadedAt || null,
      url: `/assets/${encodeURIComponent(key)}`
    }))
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  res.json({uploads});
});

app.post('/api/admin/uploads', requireImageAdmin, (req, res) => {
  const parsed = parseImageUpload(req.body?.data);
  if (parsed.error) return res.status(400).json({ok:false,error:parsed.error});

  const storedName = storeImageFile(parsed.buffer, parsed.mime);
  // Public name keeps the original file extension when there is one.
  const key = FREE_UPLOAD_PREFIX + crypto.randomBytes(8).toString('hex') + safeImageExtension(parsed.mime);
  const map = readImageMap();
  map[key] = { file: storedName, mime: parsed.mime, uploadedAt: new Date().toISOString() };
  writeImageMap(map);
  res.json({ok:true,filename:key,mime:parsed.mime,url:`/assets/${encodeURIComponent(key)}`});
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok:true,
    service:'Flavors Tea Website',
    quiverConfigured:Boolean(QUIVERCRM_URL && QUIVERCRM_KEY),
    imageAdminConfigured:Boolean(ADMIN_PASSWORD),
    persistentImageStorage:Boolean(process.env.IMAGE_ASSET_DIR),
    gmailNotificationsConfigured:Boolean(mailer && ORDER_NOTIFY_EMAIL)
  });
});

function orderEmailText(order, orderId) {
  const lines = [
    'A new order was received from the Flavors Tea website.',
    '',
    `QuiverCRM order ID: ${orderId || '(not returned)'}`,
    `Reference: ${order.externalId}`,
    `Placed: ${order.createdAt}`,
    '',
    `Customer: ${order.customerName}`,
    `Phone: ${order.phone}`,
    `WhatsApp: ${order.altPhone}`,
    `Delivery address: ${order.address}`,
    `State/Province: ${order.province}`,
    '',
    'Items:',
    ...order.items.map(i => `- ${i.name} x${i.qty} (ZMW ${i.price})`),
    '',
    `Total: ZMW ${Number(order.total).toLocaleString('en-US')}`,
  ];
  if (order.notes) lines.push('', `Notes: ${order.notes}`);
  return lines.join('\n');
}

// Fire-and-forget: a mail problem is logged but never fails the customer's order.
function notifyOrderByGmail(order, orderId) {
  if (!mailer || !ORDER_NOTIFY_EMAIL) return;
  const subject = `New Flavors Tea order: ${order.customerName} (ZMW ${order.total})`.replace(/[\r\n]+/g, ' ');
  mailer.sendMail({
    from: `"Flavors Tea Website" <${GMAIL_USER}>`,
    to: ORDER_NOTIFY_EMAIL,
    subject,
    text: orderEmailText(order, orderId),
  }).catch(err => console.error('Gmail order notification failed:', err.message));
}

app.post('/api/order', async (req,res) => {
  if (!QUIVERCRM_URL || !QUIVERCRM_KEY) return res.status(503).json({ok:false,error:'Order service is not configured yet.'});
  const b=req.body||{};
  const customerName=clean(b.customerName,150), callPhone=phone(b.phone), whatsapp=phone(b.altPhone);
  const address=clean(b.address,500), province=clean(b.province,100);
  const items=Array.isArray(b.items) ? b.items.slice(0,5).map(i=>({id:clean(i?.id,100),name:clean(i?.name,150),price:Number(i?.price)||0,qty:Math.max(1,Math.min(20,Number(i?.qty)||1))})) : [];
  const total=Number(b.total)||items.reduce((sum,i)=>sum+i.price*i.qty,0);
  if(!customerName || !callPhone || !whatsapp || !address || !province || !items.length) return res.status(400).json({ok:false,error:'Please provide your name, phone numbers, delivery address, delivery state and package.'});
  const payload={externalId:`FT-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,source:'Flavors Tea Website',customerName,phone:callPhone,altPhone:whatsapp,address,province,items,total,currency:'ZMW',notes:clean(b.notes,500),createdAt:new Date().toISOString()};
  try {
    const upstream=await fetch(`${QUIVERCRM_URL}/api/integrations/orders`,{method:'POST',headers:{'Content-Type':'application/json','X-QuiverCRM-Key':QUIVERCRM_KEY},body:JSON.stringify(payload)});
    const data=await upstream.json().catch(()=>({}));
    if(!upstream.ok) return res.status(upstream.status>=500?502:upstream.status).json({ok:false,error:data.error||'QuiverCRM could not accept the order.'});
    notifyOrderByGmail(payload, data.orderId||null);
    return res.json({ok:true,orderId:data.orderId||null});
  } catch(err) {
    console.error('QuiverCRM order submission failed:',err.message);
    return res.status(502).json({ok:false,error:'We could not reach the order system. Please try again in a moment.'});
  }
});

app.use((_req,res) => res.sendFile(path.join(PUBLIC_DIR,'index.html')));
app.listen(PORT,()=>console.log(`Flavors Tea website running on port ${PORT}`));
