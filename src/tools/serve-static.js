'use strict';

// Tiny static server for the overlay's public/ folder — used only for previewing
// the UI without the full backend. Honors PORT (for auto-port preview tooling).
const http = require('http');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', '..', 'public');
const port = process.env.PORT || 7281;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

http.createServer((req, res) => {
  let u = (req.url || '/').split('?')[0];
  if (u === '/') u = '/index.html';
  const p = path.join(dir, u);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
    res.end(data);
  });
}).listen(port, () => console.log(`static preview on http://localhost:${port}/`));
