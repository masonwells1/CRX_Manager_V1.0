#!/usr/bin/env node

import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH = path.join(ROOT, 'graphify-out', 'graph.html');
const PORT = Number(process.env.GRAPHIFY_PORT || 8765);
const HOST = '127.0.0.1';

if (!existsSync(GRAPH)) {
  console.error('Graphify view is missing. Run `npm run graph:refresh` first.');
  process.exit(1);
}

const server = createServer((request, response) => {
  if (request.url !== '/' && request.url !== '/graph.html') {
    response.writeHead(404).end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  createReadStream(GRAPH).pipe(response);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/graph.html`;
  console.log(`Graphify view: ${url}`);
  console.log('Keep this terminal open while using the graph. Press Ctrl+C to stop.');

  if (!process.argv.includes('--no-open')) {
    const opener = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    opener.unref();
  }
});

