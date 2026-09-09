// Persistent JSON datastore. Set DATA_DIR=/var/data on Render/Railway
// when using a persistent disk/volume.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const DEFAULT_DATA = {
  admin: null,
  settings: {
    storeName: 'Godwyn Stores',
    tagline: 'Quality goods, delivered across Zambia.',
    currency: 'ZMW',
    whatsappNumber: '0760565047',
    supportPhone: '0760565047'
  },
  products: [],
  orders: [],
  customers: [],
};

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      ...JSON.parse(JSON.stringify(DEFAULT_DATA)),
      ...parsed,
      settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) }
    };
  } catch (e) {
    console.error('Failed to read data.json, starting fresh:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

let data = loadData();
let writeQueue = Promise.resolve();

function persist() {
  writeQueue = writeQueue.then(async () => {
    const tmp = DATA_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.promises.rename(tmp, DATA_FILE);
  });
  return writeQueue;
}

module.exports = {
  getData() { return data; },
  async save() { await persist(); },
  dataFile: DATA_FILE
};
