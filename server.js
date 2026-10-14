// Local dev server (zero dependencies): serves ./docs and persists app data to ./data/db.json
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 5178;
const PUBLIC = path.join(__dirname, 'docs');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BODY = 100 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

fs.mkdirSync(BACKUP_DIR, { recursive: true });

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Keep one backup per day of the previous db state.
function backupOncePerDay() {
  if (!fs.existsSync(DB_FILE)) return;
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(BACKUP_DIR, `db-${day}.json`);
  if (!fs.existsSync(target)) fs.copyFileSync(DB_FILE, target);
}

function handleDb(req, res) {
  if (req.method === 'GET') {
    if (!fs.existsSync(DB_FILE)) return send(res, 200, '{}', TYPES['.json']);
    return send(res, 200, fs.readFileSync(DB_FILE), TYPES['.json']);
  }
  if (req.method === 'PUT') {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { send(res, 413, 'Too large'); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const body = Buffer.concat(chunks).toString('utf8');
      try { JSON.parse(body); } catch { return send(res, 400, 'Invalid JSON'); }
      try {
        backupOncePerDay();
        const tmp = DB_FILE + '.tmp';
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, DB_FILE);
        send(res, 204, '');
      } catch (e) {
        send(res, 500, String(e));
      }
    });
    return;
  }
  send(res, 405, 'Method not allowed');
}

function handleStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return send(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}

http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/api/db') return handleDb(req, res);
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
  handleStatic(req, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`QB Study running at http://localhost:${PORT}`);
});
