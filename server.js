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

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

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

  shell.onData((data) => {
    try { ws.send(data); } catch (e) {}
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
