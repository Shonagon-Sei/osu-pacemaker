'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const log = require('../util/logger');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Minimal static server for the overlay so you can drop a single URL into an
 * OBS "Browser Source": http://localhost:<HTTP_PORT>/
 */
function startStaticServer(port, rootDir, runtimeConfig = {}) {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    // Runtime config the overlay needs (e.g. which port the relay socket is on).
    if (urlPath === '/config.json') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify(runtimeConfig));
    }

    const filePath = path.join(rootDir, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  server.listen(port, () => log.ok(`Overlay served at http://localhost:${port}/  (add as OBS Browser Source)`));
  server.on('error', (e) => log.err('HTTP server error:', e.message));
  return server;
}

module.exports = { startStaticServer };
