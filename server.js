const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');

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
  const { name, index, tabId } = req.body || {};
  // If the hook sent a tabId, route the rename directly through that tab's WebSocket
  if (tabId && tabIdToWs.has(tabId)) {
    const ws = tabIdToWs.get(tabId);
    try { ws.send('\x02' + JSON.stringify({ apiRename: name })); } catch (e) {}
    res.json({ ok: true, routed: true });
    return;
  }
  // Otherwise broadcast via SSE (manual renames, curl, etc.)
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify({ type: 'rename-tab', name, index })}\n\n`);
  }
  res.json({ ok: true, clients: sseClients.size });
});

// Open a URL in the system default browser (main Chrome profile, not the
// isolated --user-data-dir profile that ghost-term itself runs in).
app.post('/api/open-url', (req, res) => {
  const url = req.body && req.body.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'http(s) url required' });
  }
  // spawn with array args avoids cmd metachar issues (& ? etc. in URLs)
  const child = spawn('cmd.exe', ['/c', 'start', '', url], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  res.json({ ok: true });
});

// Serve config (sans sensitive fields) to frontend
app.get('/config', (req, res) => {
  res.json({ video: !!config.video });
});

// List available background video clips
const clipsDir = path.join(__dirname, 'clips');
app.get('/api/videos', (req, res) => {
  const files = fs.readdirSync(clipsDir).filter(f => f.endsWith('.mp4'));
  res.json({ clips: files, current: path.basename(config.video || '') });
});

// Switch background video
app.post('/api/set-video', (req, res) => {
  const { clip } = req.body || {};
  if (!clip) return res.status(400).json({ error: 'clip required' });
  const fullPath = path.join(clipsDir, clip);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'clip not found' });
  config.video = fullPath;
  // Notify all browser clients to reload video
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify({ type: 'set-video', clip })}\n\n`);
  }
  res.json({ ok: true, current: clip });
});

// Stream video file
app.get('/video', (req, res) => {
  if (!config.video || !fs.existsSync(config.video)) {
    return res.status(404).json({ error: 'no video configured' });
  }
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

// Strip ANSI escape sequences for pattern matching
const stripAnsi = (s) => s.replace(/\x1B(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|\(B)/g, '');

// Detect shell type from process descendants (ssh, powershell, wsl, or bash)
function detectShellType(byParent, pid, depth) {
  if (depth <= 0) return null;
  const children = byParent.get(pid) || [];
  for (const child of children) {
    const name = child.name.toLowerCase();
    if (name.startsWith('ssh')) return 'ssh';
    if (name === 'wsl.exe' || name === 'wsl') return 'wsl';
    if (name === 'powershell.exe' || name === 'pwsh.exe') return 'powershell';
  }
  for (const child of children) {
    const type = detectShellType(byParent, child.pid, depth - 1);
    if (type) return type;
  }
  return null;
}

// WebSocket terminal
const wss = new WebSocketServer({ server });

const tabIdToWs = new Map();

wss.on('connection', (ws) => {
  const tabId = crypto.randomUUID();
  const shell = pty.spawn(config.shell, config.shellArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.env.HOME || process.env.USERPROFILE,
    env: { ...process.env, GHOST_TERM_TAB_ID: tabId },
  });
  tabIdToWs.set(tabId, ws);

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

  activeShells.set(ws, { pid: shell.pid, claudeRunning: false, shellType: 'bash' });
  // Send initial state so the client transitions from null immediately
  try { ws.send('\x02' + JSON.stringify({ claudeRunning: false })); } catch (e) {}
  ws.on('close', () => { activeShells.delete(ws); tabIdToWs.delete(tabId); shell.kill(); });
  shell.onExit(() => { activeShells.delete(ws); tabIdToWs.delete(tabId); ws.close(); });
});

// ── Process monitoring: detect if Claude is running in each shell ──
const activeShells = new Map();

function hasClaudeDescendant(byParent, pid, depth) {
  if (depth <= 0) return false;
  const children = byParent.get(pid) || [];
  for (const child of children) {
    if (/^claude/i.test(child.name)) return true;
    if (hasClaudeDescendant(byParent, child.pid, depth - 1)) return true;
  }
  return false;
}

setInterval(() => {
  if (activeShells.size === 0) return;

  exec('wmic process get Name,ProcessId,ParentProcessId /format:csv',
    { windowsHide: true, timeout: 5000 },
    (err, stdout) => {
      if (err) return;

      const lines = stdout.replace(/\r\r/g, '\r').split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return;

      // Parse header to find columns regardless of order
      const header = lines[0].split(',').map(h => h.trim());
      const nameIdx = header.indexOf('Name');
      const pidIdx = header.indexOf('ProcessId');
      const ppidIdx = header.indexOf('ParentProcessId');
      if (nameIdx < 0 || pidIdx < 0 || ppidIdx < 0) return;

      const byParent = new Map();
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        const name = parts[nameIdx]?.trim();
        const pid = parseInt(parts[pidIdx]);
        const ppid = parseInt(parts[ppidIdx]);
        if (!name || isNaN(pid) || isNaN(ppid)) continue;
        if (!byParent.has(ppid)) byParent.set(ppid, []);
        byParent.get(ppid).push({ name, pid });
      }

      for (const [ws, info] of activeShells) {
        const running = hasClaudeDescendant(byParent, info.pid, 4);
        if (running !== info.claudeRunning) {
          info.claudeRunning = running;
          try { ws.send('\x02' + JSON.stringify({ claudeRunning: running })); } catch (e) {}
        }
        const shellType = detectShellType(byParent, info.pid, 4) || 'bash';
        if (shellType !== info.shellType) {
          info.shellType = shellType;
          try { ws.send('\x02' + JSON.stringify({ shellType })); } catch (e) {}
        }
      }
    }
  );
}, 2000);

server.listen(config.port, () => {
  console.log(`ghost-term running at http://localhost:${config.port}`);
});
