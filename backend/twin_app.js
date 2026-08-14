'use strict';

const http = require('node:http');
const port = Number(process.argv[2]);
const component = String(process.argv[3] || 'inventory-app');
const parentPid = Number(process.argv[4] || 0);
if (!Number.isInteger(port) || port < 1024 || port > 65535) process.exit(2);

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/work') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, component, pid: process.pid, mode: 'managed_child_process' }));
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, '127.0.0.1');
function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (Number.isSafeInteger(parentPid) && parentPid > 0) {
  const watchdog = setInterval(() => { try { process.kill(parentPid, 0); } catch (_) { shutdown(); } }, 1000);
  watchdog.unref();
}
