const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const http = require('http');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// Resolve relative video path from project root
if (config.video && !path.isAbsolute(config.video)) {
  config.video = path.join(__dirname, config.video);
}

const pidFile = path.join(__dirname, 'ghost-term.pid');

// Write PID file so launch.bat can find and kill stale processes
fs.writeFileSync(pidFile, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(pidFile); } catch (e) {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SSE clients for pushing new-tab events to the browser
const sseClients = new Set();

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Health check endpoint — includes connected browser count
app.get('/health', (req, res) => res.json({ ok: true, pid: process.pid, clients: sseClients.size }));

app.post('/api/new-tab', (req, res) => {
  const name = (req.body && req.body.name) || 'scratch';
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify({ type: 'new-tab', name })}\n\n`);
  }
  res.json({ ok: true, clients: sseClients.size });
});

app.post('/api/rename-tab', (req, res) => {
  const { name, index } = req.body || {};
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify({ type: 'rename-tab', name, index })}\n\n`);
  }
  res.json({ ok: true, clients: sseClients.size });
});

// Serve config (sans sensitive fields) to frontend
app.get('/config', (req, res) => {
  res.json({ video: !!config.video });
});

// Stream video file if configured
if (config.video && fs.existsSync(config.video)) {
  app.get('/video', (req, res) => {
    const stat = fs.statSync(config.video);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(config.video, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(config.video).pipe(res);
    }
  });
}

// Strip ANSI escape sequences for pattern matching
const stripAnsi = (s) => s.replace(/\x1B(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|\(B)/g, '');

// WebSocket terminal
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const shell = pty.spawn(config.shell, config.shellArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.env.HOME || process.env.USERPROFILE,
    env: process.env,
  });

  // Auto-launch state machine
  const autoCmd = config.autoCommand;
  let auto = autoCmd ? 'shell' : 'done';
  let buf = '';
  let idle = null;

  shell.onData((data) => {
    try { ws.send(data); } catch (e) {}

    if (auto === 'done') return;
    buf += stripAnsi(data);

    switch (auto) {
      case 'shell':
        // Wait for bash prompt
        if (/\$\s*$/.test(buf)) {
          buf = '';
          auto = 'launched';
          setTimeout(() => shell.write(autoCmd + '\r'), 300);
        }
        break;

      case 'launched':
        // Auto-accept trust dialog if it appears
        if (/Do you trust|trust.*folder/i.test(buf)) {
          shell.write('\r');
          buf = '';
        }
        // After output settles for 3s, auto-launch is complete
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          auto = 'done';
          buf = '';
        }, 3000);
        break;
    }
  });

  ws.on('message', (msg) => {
    const data = msg.toString();
    // Handle resize messages
    if (data.startsWith('\x01')) {
      try {
        const size = JSON.parse(data.slice(1));
        shell.resize(size.cols, size.rows);
      } catch (e) {}
      return;
    }
    shell.write(data);
  });

  ws.on('close', () => shell.kill());
  shell.onExit(() => ws.close());
});

server.listen(config.port, () => {
  console.log(`ghost-term running at http://localhost:${config.port}`);
});
