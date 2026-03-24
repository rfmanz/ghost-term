(async function () {
  // Check if video is configured
  const res = await fetch('/config');
  const config = await res.json();

  if (config.video) {
    document.getElementById('bgvideo').src = '/video';
  }

  // Initialize xterm.js
  const term = new Terminal({
    fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
    fontSize: 14,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowTransparency: true,
    theme: {
      background: 'rgba(10, 14, 20, 0.4)',
      foreground: '#c8d6e5',
      cursor: '#00e5ff',
      cursorAccent: '#0a0e14',
      selectionBackground: 'rgba(0, 229, 255, 0.25)',
      black: '#1e2127',
      red: '#ff5252',
      green: '#00e5a0',
      yellow: '#ffd740',
      blue: '#40c4ff',
      magenta: '#c792ea',
      cyan: '#00e5ff',
      white: '#c8d6e5',
      brightBlack: '#5c6370',
      brightRed: '#ff6e6e',
      brightGreen: '#69f0ae',
      brightYellow: '#ffe57f',
      brightBlue: '#82b1ff',
      brightMagenta: '#d4bfff',
      brightCyan: '#84ffff',
      brightWhite: '#ffffff',
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();

  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();

  // WebSocket connection
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    // Send initial size
    ws.send('\x01' + JSON.stringify({ cols: term.cols, rows: term.rows }));
  };

  ws.onmessage = (event) => {
    term.write(event.data);
  };

  ws.onclose = () => {
    term.write('\r\n\x1b[38;2;0;229;255m[connection closed]\x1b[0m\r\n');
  };

  term.onData((data) => {
    ws.send(data);
  });

  // Resize handling
  const sendResize = () => {
    fitAddon.fit();
    ws.send('\x01' + JSON.stringify({ cols: term.cols, rows: term.rows }));
  };

  window.addEventListener('resize', sendResize);
  new ResizeObserver(sendResize).observe(document.getElementById('terminal'));

  // Intercept browser shortcuts before xterm captures them
  term.attachCustomKeyEventHandler((e) => {
    // Ctrl+W — close window
    if (e.ctrlKey && e.key === 'w') {
      window.close();
      return false;
    }
    // Ctrl+R — reload
    if (e.ctrlKey && e.key === 'r') {
      location.reload();
      return false;
    }
    // F5 — reload
    if (e.key === 'F5') {
      location.reload();
      return false;
    }
    // F11 — toggle fullscreen
    if (e.key === 'F11') {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
      } else {
        document.exitFullscreen();
      }
      return false;
    }
    // Let everything else go to xterm
    return true;
  });

  term.focus();
})();
