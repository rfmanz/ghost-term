(async function () {
  // Intercept Ctrl+W at the browser level to prevent Chrome --app from closing the window
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.altKey && e.key === 'w') {
      e.preventDefault();
    }
  });

  // Lock document.title so shell escape sequences (via xterm.js) can't override it.
  // Only titles starting with "ghost-term" (set by our renderTabBar) are allowed through.
  const _titleDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'title')
    || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'title');
  if (_titleDesc) {
    Object.defineProperty(document, 'title', {
      get() { return _titleDesc.get.call(document); },
      set(val) { if (val.startsWith('ghost-term')) _titleDesc.set.call(document, val); },
      configurable: true,
    });
  }

  const urlName = new URLSearchParams(location.search).get('name') || 'scratch';

  // Check if video is configured
  const res = await fetch('/config');
  const config = await res.json();
  if (config.video) {
    document.getElementById('bgvideo').src = '/video';
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsBase = `${protocol}//${location.host}`;

  const termTheme = {
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
  };

  // ── Helpers ──

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function cleanShellTitle(title) {
    title = title.trim();
    // Ignore generic titles set by CLI tools (e.g. "claude", "✱ Claude Code")
    const letters = title.replace(/[^a-zA-Z\s]/g, '').trim();
    if (/^claude(\s+code)?\s*$/i.test(letters)) return '';
    // Strip MINGW64: or similar prefix
    title = title.replace(/^MINGW\d*:\s*/, '');
    // Collapse /c/Users/<user>/ to ~/
    title = title.replace(/^\/[a-z]\/Users\/[^/]+\/?/, '~/');
    // If it's just ~, show "home"
    if (title === '~' || title === '~/') return '~';
    // Show last two path segments for brevity
    const parts = title.replace(/\/$/, '').split('/');
    if (parts.length > 2) return parts.slice(-2).join('/');
    return title || '';
  }

  // ── Tab state ──

  const tabs = [];
  let activeIdx = 0;

  const tabBar = document.getElementById('tab-bar');
  const terminalsContainer = document.getElementById('terminal-container');

  function displayName(tab) {
    if (tab.explicit) return tab.name;
    return tab.shellTitle || tab.name;
  }

  function renderTabBar() {
    // Only rebuild DOM when tab count changes; otherwise update in-place to preserve CSS animations
    const existingTabs = tabBar.querySelectorAll('.tab:not(.tab-new)');
    const structureChanged = existingTabs.length !== tabs.length;

    if (structureChanged) {
      tabBar.innerHTML = '';

      tabs.forEach((tab, i) => {
        const el = document.createElement('div');
        el.innerHTML = `<span class="tab-index">${i + 1}</span><span class="tab-name">${escHtml(displayName(tab))}</span>`;
        if (tabs.length > 1) {
          const close = document.createElement('span');
          close.className = 'tab-close';
          close.textContent = '\u00d7';
          close.onclick = (e) => { e.stopPropagation(); closeTab(i); };
          el.appendChild(close);
        }
        el.onclick = () => switchTab(i);
        tab.el = el;
        tabBar.appendChild(el);
      });

      // "+" button
      const plus = document.createElement('div');
      plus.className = 'tab tab-new';
      plus.textContent = '+';
      plus.onclick = () => createTab('scratch');
      tabBar.appendChild(plus);
    }

    // Update classes and text in-place (preserves running CSS animations)
    tabs.forEach((tab, i) => {
      const el = tab.el;
      if (!el) return;
      const state = tab.thinking ? ' thinking' : tab.waiting ? ' waiting' : '';
      const newClass = 'tab' + (i === activeIdx ? ' active' : '') + state;
      if (el.className !== newClass) el.className = newClass;

      const nameSpan = el.querySelector('.tab-name');
      const newName = escHtml(displayName(tab));
      if (nameSpan && nameSpan.innerHTML !== newName) nameSpan.innerHTML = newName;

      const indexSpan = el.querySelector('.tab-index');
      const newIdx = String(i + 1);
      if (indexSpan && indexSpan.textContent !== newIdx) indexSpan.textContent = newIdx;
    });

    // Show tab bar when there are 2+ tabs
    tabBar.style.display = tabs.length > 1 ? 'flex' : 'none';

    // Update document title
    if (tabs[activeIdx]) {
      document.title = `ghost-term \u2014 ${displayName(tabs[activeIdx])}`;
    }
  }

  let tabCounter = 0;

  function createTab(name) {
    tabCounter++;
    const explicit = name !== 'scratch';
    if (!explicit) name = `session-${tabCounter}`;

    const container = document.createElement('div');
    container.className = 'tab-terminal';
    container.style.display = 'none';
    terminalsContainer.appendChild(container);

    const term = new Terminal({
      fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: true,
      theme: termTheme,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    term.open(container);

    const ws = new WebSocket(wsBase);

    ws.onopen = () => {
      fitAddon.fit();
      ws.send('\x01' + JSON.stringify({ cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => {
      tab.lastDataAt = Date.now();
      // Detect Claude Code's spinner (braille characters U+2800–U+28FF)
      if (typeof e.data === 'string' && /[\u2800-\u28FF]/.test(e.data)) {
        tab.lastSpinnerAt = Date.now();
        if (!tab.thinking) {
          tab.thinking = true;
          renderTabBar();
        }
      }
      // Detect prompt / question patterns (❯ prompt, Y/n permission prompts)
      if (typeof e.data === 'string' && /[\u276F]|\([Yy]\/[Nn]\)/.test(e.data)) {
        tab.lastPromptAt = Date.now();
      }
      term.write(e.data);
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[38;2;0;229;255m[connection closed]\x1b[0m\r\n');
    };

    term.onData((data) => {
      if (ws.readyState === 1) ws.send(data);
      tab.lastInputAt = Date.now();
      tab.lastPromptAt = 0;
      tab.lastSpinnerAt = 0;
      const wasColored = tab.thinking || tab.waiting;
      tab.thinking = false;
      tab.waiting = false;
      if (wasColored) renderTabBar();
    });

    const tab = { name, term, ws, fitAddon, container, explicit, shellTitle: '', thinking: false, waiting: false, lastSpinnerAt: 0, lastPromptAt: 0, lastDataAt: 0, lastInputAt: 0 };
    tabs.push(tab);

    // Track shell title sequences for auto-naming
    // Only update shellTitle when cleanShellTitle returns something meaningful;
    // this preserves the last good title when Claude Code overrides with "✱ Claude Code"
    term.onTitleChange((title) => {
      const cleaned = cleanShellTitle(title);
      if (cleaned) tab.shellTitle = cleaned;
      if (!tab.explicit) renderTabBar();
    });

    // Keyboard shortcuts
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Alt+<key> → Ctrl+<key> mappings for readline shortcuts Chrome intercepts
      if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        const altMap = { a: '\x01', k: '\x0b' }; // Ctrl+A, Ctrl+K
        const ctrl = altMap[e.key.toLowerCase()];
        if (ctrl) {
          if (ws.readyState === 1) ws.send(ctrl);
          return false;
        }
      }

      // Alt+1–9: switch tabs
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (idx < tabs.length) switchTab(idx);
        return false;
      }

      // Alt+T: new tab
      if (e.altKey && !e.ctrlKey && e.key === 't') {
        createTab('scratch');
        return false;
      }

      // Ctrl+W: close current tab
      if (e.ctrlKey && !e.altKey && e.key === 'w') {
        closeTab(activeIdx);
        return false;
      }

      // Ctrl+R: reload
      if (e.ctrlKey && e.key === 'r') {
        location.reload();
        return false;
      }

      // F5: reload
      if (e.key === 'F5') {
        location.reload();
        return false;
      }

      // Shift+Up/Down: scroll by line, Shift+PageUp/PageDown: scroll by page
      if (e.shiftKey && !e.altKey && !e.ctrlKey) {
        if (e.key === 'ArrowUp')   { term.scrollLines(-1); return false; }
        if (e.key === 'ArrowDown') { term.scrollLines(1);  return false; }
        if (e.key === 'PageUp')    { term.scrollPages(-1); return false; }
        if (e.key === 'PageDown')  { term.scrollPages(1);  return false; }
      }

      // F11: toggle fullscreen
      if (e.key === 'F11') {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen();
        else document.exitFullscreen();
        return false;
      }

      return true;
    });

    switchTab(tabs.length - 1);
    return tab;
  }

  function switchTab(idx) {
    if (idx < 0 || idx >= tabs.length) return;
    activeIdx = idx;

    tabs.forEach((tab, i) => {
      tab.container.style.display = i === idx ? '' : 'none';
    });

    renderTabBar();

    // Fit after layout recalculates
    requestAnimationFrame(() => {
      const tab = tabs[idx];
      tab.fitAddon.fit();
      if (tab.ws.readyState === 1) {
        tab.ws.send('\x01' + JSON.stringify({ cols: tab.term.cols, rows: tab.term.rows }));
      }
      tab.term.focus();
    });
  }

  function closeTab(idx) {
    const tab = tabs[idx];
    tab.ws.close();
    tab.term.dispose();
    tab.container.remove();
    tabs.splice(idx, 1);

    if (tabs.length === 0) {
      window.close();
      return;
    }
    if (activeIdx >= tabs.length) activeIdx = tabs.length - 1;
    switchTab(activeIdx);
  }

  // ── Resize ──
  window.addEventListener('resize', () => {
    const tab = tabs[activeIdx];
    if (!tab) return;
    tab.fitAddon.fit();
    if (tab.ws.readyState === 1) {
      tab.ws.send('\x01' + JSON.stringify({ cols: tab.term.cols, rows: tab.term.rows }));
    }
  });

  // ── SSE for remote tab creation / renaming ──
  const events = new EventSource('/events');
  events.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'new-tab') {
        createTab(data.name || 'scratch');
      }
      if (data.type === 'set-video') {
        const vid = document.getElementById('bgvideo');
        vid.src = '/video?t=' + Date.now();
        vid.load();
        vid.play();
      }
      if (data.type === 'rename-tab') {
        const idx = data.index != null ? data.index : activeIdx;
        if (tabs[idx]) {
          tabs[idx].name = data.name;
          tabs[idx].explicit = true;
          renderTabBar();
        }
      }
    } catch (err) {}
  };

  // ── Create initial tabs ──
  const initialTabs = parseInt(new URLSearchParams(location.search).get('tabs')) || 3;
  for (let i = 0; i < initialTabs; i++) {
    createTab(i === 0 ? urlName : 'scratch');
  }
  switchTab(0);

  // ── State detector ──
  // Tracks Claude's activity: thinking (spinner + data flowing), waiting (prompt after work)
  setInterval(() => {
    let changed = false;
    const now = Date.now();
    tabs.forEach((tab) => {
      const sinceData = now - tab.lastDataAt;
      // Thinking: spinner seen after last user input, no prompt since, data still flowing
      const isThinking = tab.lastSpinnerAt > 0
        && tab.lastSpinnerAt > tab.lastInputAt
        && tab.lastSpinnerAt >= tab.lastPromptAt
        && sinceData < 8000;
      // Waiting: prompt appeared after last spinner, still recent
      const isWaiting = !isThinking
        && tab.lastSpinnerAt > 0
        && tab.lastPromptAt > tab.lastSpinnerAt
        && now - tab.lastPromptAt < 30000;
      if (tab.thinking !== isThinking) {
        tab.thinking = isThinking;
        changed = true;
      }
      if (tab.waiting !== isWaiting) {
        tab.waiting = isWaiting;
        changed = true;
      }
    });
    if (changed) renderTabBar();
  }, 500);

  // ── Clock ──
  const clockEl = document.getElementById('clock');
  const updateClock = () => {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  updateClock();
  setInterval(updateClock, 1000);
})();
