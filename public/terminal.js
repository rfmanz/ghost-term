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

  // ── Tab state ──

  const tabs = [];
  let activeIdx = 0;
  let prevActiveIdx = 0;
  let splitRoot = null; // Tree: { type:'split', dir, ratio, children:[node,node], el, divider } or { type:'leaf', tabId }

  function tabById(id) {
    return tabs.find(t => t.id === id);
  }

  const tabBar = document.getElementById('tab-bar');
  const terminalsContainer = document.getElementById('terminal-container');

  function renderTabBar() {
    // Only rebuild DOM when tab count changes; otherwise update in-place to preserve CSS animations
    const existingTabs = tabBar.querySelectorAll('.tab:not(.tab-new)');
    const structureChanged = existingTabs.length !== tabs.length;

    if (structureChanged) {
      tabBar.innerHTML = '';

      tabs.forEach((tab, i) => {
        const el = document.createElement('div');
        el.innerHTML = `<span class="tab-index">${i + 1}</span><span class="tab-name">${escHtml(tab.name)}</span>`;
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
      let paneClass = '';
      if (splitRoot) {
        const leaf = findLeafByTab(splitRoot, tab.id);
        if (leaf) paneClass = i === activeIdx ? ' in-pane-0' : ' in-pane-1';
      }
      const newClass = 'tab' + (i === activeIdx ? ' active' : '') + state + paneClass;
      if (el.className !== newClass) el.className = newClass;

      const nameSpan = el.querySelector('.tab-name');
      const newName = escHtml(tab.name);
      if (nameSpan && nameSpan.innerHTML !== newName) nameSpan.innerHTML = newName;

      const indexSpan = el.querySelector('.tab-index');
      const newIdx = String(i + 1);
      if (indexSpan && indexSpan.textContent !== newIdx) indexSpan.textContent = newIdx;

      // Visual order: pane tabs first when split
      if (splitRoot) {
        const leaves = allLeaves(splitRoot);
        const leafIdx = leaves.findIndex(l => l.tabId === tab.id);
        el.style.order = leafIdx !== -1 ? String(leafIdx) : String(leaves.length);
      } else {
        el.style.order = '';
      }
    });

    // Show tab bar when there are 2+ tabs
    tabBar.style.display = tabs.length > 1 ? 'flex' : 'none';

    // Update document title
    if (tabs[activeIdx]) {
      document.title = `ghost-term \u2014 ${tabs[activeIdx].name}`;
    }
  }

  let tabCounter = 0;

  // ── Split tree helpers ──

  function findLeafByTab(node, tabId) {
    if (!node) return null;
    if (node.type === 'leaf') return node.tabId === tabId ? node : null;
    return findLeafByTab(node.children[0], tabId) || findLeafByTab(node.children[1], tabId);
  }

  function findParent(root, target) {
    if (!root || root.type === 'leaf') return null;
    if (root.children[0] === target || root.children[1] === target) return root;
    return findParent(root.children[0], target) || findParent(root.children[1], target);
  }

  function allLeaves(node) {
    if (!node) return [];
    if (node.type === 'leaf') return [node];
    return [...allLeaves(node.children[0]), ...allLeaves(node.children[1])];
  }

  function getNodeEl(node) {
    if (node.type === 'leaf') return tabById(node.tabId)?.container;
    return node.el;
  }

  function fitPaneTerminal(tabId) {
    const tab = tabById(tabId);
    if (!tab) return;
    tab.fitAddon.fit();
    if (tab.ws.readyState === 1) {
      tab.ws.send('\x01' + JSON.stringify({ cols: tab.term.cols, rows: tab.term.rows }));
    }
  }

  function focusLeaf(leaf) {
    if (!splitRoot) return;
    allLeaves(splitRoot).forEach(l => {
      tabById(l.tabId).container.classList.remove('pane-focused');
    });
    const tab = tabById(leaf.tabId);
    tab.container.classList.add('pane-focused');
    const idx = tabs.indexOf(tab);
    if (idx !== activeIdx) prevActiveIdx = activeIdx;
    activeIdx = idx;
    tab.term.focus();
    renderTabBar();
  }

  function navigatePane(delta) {
    if (!splitRoot) return;
    const leaves = allLeaves(splitRoot);
    const currentLeaf = findLeafByTab(splitRoot, tabs[activeIdx].id);
    const idx = leaves.indexOf(currentLeaf);
    if (idx === -1) return;
    const newIdx = (idx + delta + leaves.length) % leaves.length;
    focusLeaf(leaves[newIdx]);
  }

  function applyNodeRatio(node) {
    if (!node || node.type === 'leaf') return;
    const child0El = getNodeEl(node.children[0]);
    const child1El = getNodeEl(node.children[1]);
    if (child0El) child0El.style.flex = String(node.ratio);
    if (child1El) child1El.style.flex = String(1 - node.ratio);
    requestAnimationFrame(() => {
      allLeaves(node).forEach(l => fitPaneTerminal(l.tabId));
    });
  }

  function resizeSplit(node, delta) {
    node.ratio = Math.max(0.15, Math.min(0.85, node.ratio + delta));
    applyNodeRatio(node);
  }

  function buildNodeDOM(node) {
    if (node.type === 'leaf') {
      const container = tabById(node.tabId).container;
      container.style.display = '';
      container.classList.add('split-pane');
      return container;
    }
    const el = document.createElement('div');
    el.className = 'split-container ' + (node.dir === 'horizontal' ? 'split-h' : 'split-v');
    node.el = el;
    const child0El = buildNodeDOM(node.children[0]);
    const divider = document.createElement('div');
    divider.className = 'split-divider ' + (node.dir === 'horizontal' ? 'split-divider-h' : 'split-divider-v');
    node.divider = divider;
    const child1El = buildNodeDOM(node.children[1]);
    child0El.style.flex = String(node.ratio);
    child1El.style.flex = String(1 - node.ratio);
    el.appendChild(child0El);
    el.appendChild(divider);
    el.appendChild(child1El);
    return el;
  }

  function rebuildSplitDOM() {
    terminalsContainer.querySelectorAll('.split-container').forEach(el => el.remove());
    tabs.forEach(tab => {
      tab.container.classList.remove('split-pane', 'pane-focused');
      tab.container.style.flex = '';
      tab.container.style.order = '';
      tab.container.style.display = 'none';
      if (tab.container.parentNode !== terminalsContainer) {
        terminalsContainer.appendChild(tab.container);
      }
    });

    if (!splitRoot) {
      if (tabs[activeIdx]) {
        tabs[activeIdx].container.style.display = '';
        requestAnimationFrame(() => {
          tabs[activeIdx].fitAddon.fit();
          if (tabs[activeIdx].ws.readyState === 1) {
            tabs[activeIdx].ws.send('\x01' + JSON.stringify({ cols: tabs[activeIdx].term.cols, rows: tabs[activeIdx].term.rows }));
          }
          tabs[activeIdx].term.focus();
        });
      }
      renderTabBar();
      return;
    }

    const rootEl = buildNodeDOM(splitRoot);
    terminalsContainer.appendChild(rootEl);
    const leaf = findLeafByTab(splitRoot, tabs[activeIdx].id);
    if (leaf) tabById(leaf.tabId).container.classList.add('pane-focused');
    requestAnimationFrame(() => {
      allLeaves(splitRoot).forEach(l => fitPaneTerminal(l.tabId));
      if (tabs[activeIdx]) tabs[activeIdx].term.focus();
    });
    renderTabBar();
  }

  function splitView(direction) {
    const used = splitRoot ? new Set(allLeaves(splitRoot).map(l => l.tabId)) : new Set([tabs[activeIdx].id]);
    let newTab = null;
    for (let i = 1; i < tabs.length; i++) {
      const candidate = tabs[(activeIdx + i) % tabs.length];
      if (!used.has(candidate.id)) { newTab = candidate; break; }
    }
    if (!newTab) {
      newTab = createTab('scratch', { activate: false });
    }

    const activeId = tabs[activeIdx].id;
    if (!splitRoot) {
      splitRoot = {
        type: 'split', dir: direction, ratio: 0.5,
        children: [{ type: 'leaf', tabId: activeId }, { type: 'leaf', tabId: newTab.id }],
        el: null, divider: null
      };
    } else {
      const leaf = findLeafByTab(splitRoot, activeId);
      if (!leaf) return;
      const newSplit = {
        type: 'split', dir: direction, ratio: 0.5,
        children: [{ type: 'leaf', tabId: activeId }, { type: 'leaf', tabId: newTab.id }],
        el: null, divider: null
      };
      const parent = findParent(splitRoot, leaf);
      if (!parent) splitRoot = newSplit;
      else parent.children[parent.children.indexOf(leaf)] = newSplit;
    }
    rebuildSplitDOM();
    const newLeaf = findLeafByTab(splitRoot, newTab.id);
    if (newLeaf) focusLeaf(newLeaf);
  }

  function unsplit() {
    if (!splitRoot) return;
    const leaf = findLeafByTab(splitRoot, tabs[activeIdx].id);
    if (!leaf) return;
    const parent = findParent(splitRoot, leaf);
    if (!parent) {
      splitRoot = null;
    } else {
      const sibling = parent.children[1 - parent.children.indexOf(leaf)];
      const grandparent = findParent(splitRoot, parent);
      if (!grandparent) splitRoot = sibling;
      else grandparent.children[grandparent.children.indexOf(parent)] = sibling;
      if (splitRoot.type === 'leaf') splitRoot = null;
    }
    rebuildSplitDOM();
  }


  function createTab(name, options = {}) {
    const { activate = true } = options;
    tabCounter++;
    if (name === 'scratch') name = 'bash';

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

    // Auto-copy selection to clipboard
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel);
    });

    const ws = new WebSocket(wsBase);

    ws.onopen = () => {
      fitAddon.fit();
      ws.send('\x01' + JSON.stringify({ cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => {
      // Server-side process status update (STX-prefixed JSON)
      if (typeof e.data === 'string' && e.data.charCodeAt(0) === 0x02) {
        try {
          const status = JSON.parse(e.data.slice(1));
          // Shell type detection (ssh, powershell, wsl, bash)
          if ('shellType' in status) {
            tab.name = status.shellType;
            renderTabBar();
          }
          if ('claudeRunning' in status) {
            const wasRunning = tab.claudeRunning;
            tab.claudeRunning = status.claudeRunning;
            if (!status.claudeRunning && (wasRunning || wasRunning === null)) {
              // Claude stopped (or server's first report confirms not running) — reset to idle
              tab.thinking = false;
              tab.waiting = false;
              tab.quietTicks = 0;
              tab.submitted = false;
              renderTabBar();
            } else if (status.claudeRunning && !wasRunning) {
              // Claude just started — show thinking immediately
              tab.thinking = true;
              tab.waiting = false;
              tab.quietTicks = 0;
              renderTabBar();
            }
          }
        } catch (err) {}
        return;
      }

      const now = Date.now();
      tab.lastDataAt = now;
      // Data arriving >200ms after the last keystroke is real output, not an echo
      if (now - tab.lastInputAt > 200) {
        tab.lastOutputAt = now;
      }
      // Data arrived — clear submit trigger and set thinking if Claude is running
      // Only transition from idle→thinking (not waiting→thinking) to avoid echo flicker
      if (tab.submitted) tab.submitted = false;
      if (tab.claudeRunning !== false && !tab.thinking && !tab.waiting) {
        tab.thinking = true;
        tab.quietTicks = 0;
        renderTabBar();
      }
      term.write(e.data);
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[38;2;0;229;255m[connection closed]\x1b[0m\r\n');
    };

    term.onData((data) => {
      if (ws.readyState === 1) ws.send(data);
      tab.lastInputAt = Date.now();
      // On submit: trigger thinking immediately (bridges gap before output starts)
      if (data.includes('\r') || data.includes('\n')) {
        tab.submitted = true;
        tab.quietTicks = 0;
        if (tab.claudeRunning !== false && tab.waiting) {
          tab.thinking = true;
          tab.waiting = false;
          renderTabBar();
        }
      }
    });

    const tab = { id: tabCounter, name, term, ws, fitAddon, container, thinking: false, waiting: false, claudeRunning: null, quietTicks: 0, submitted: false, lastDataAt: 0, lastInputAt: 0, lastOutputAt: 0 };
    tabs.push(tab);

    // Click to focus pane in split mode
    container.addEventListener('mousedown', () => {
      if (splitRoot) {
        const leaf = findLeafByTab(splitRoot, tab.id);
        if (leaf && tabs.indexOf(tab) !== activeIdx) {
          focusLeaf(leaf);
        }
      }
    });
    // Keyboard shortcuts
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Alt+F4: close the entire window
      if (e.altKey && !e.ctrlKey && e.key === 'F4') {
        window.close();
        return false;
      }

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

      // Alt+Q: switch to last used tab
      if (e.altKey && !e.ctrlKey && e.key === 'q') {
        switchTab(prevActiveIdx);
        return false;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: next/previous tab
      if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
        const dir = e.shiftKey ? -1 : 1;
        switchTab((activeIdx + dir + tabs.length) % tabs.length);
        return false;
      }

      // Alt+D: split active pane horizontally
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'd') {
        splitView('horizontal');
        return false;
      }

      // Alt+Shift+D: split active pane vertically
      if (e.altKey && !e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        splitView('vertical');
        return false;
      }

      // Alt+W: unsplit active pane (keep tab)
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'w' && splitRoot) {
        unsplit();
        return false;
      }

      // Alt+S: swap children in parent split
      if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 's' || e.key === 'S') && splitRoot) {
        const leaf = findLeafByTab(splitRoot, tabs[activeIdx].id);
        const parent = findParent(splitRoot, leaf);
        if (parent) {
          parent.children.reverse();
          rebuildSplitDOM();
        }
        return false;
      }

      // Alt+Arrow: switch pane focus
      if (e.altKey && !e.ctrlKey && !e.shiftKey && splitRoot) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          navigatePane(-1);
          return false;
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          navigatePane(1);
          return false;
        }
      }

      // Alt+Shift+Arrow: resize parent split of active pane
      if (e.altKey && !e.ctrlKey && e.shiftKey && splitRoot) {
        const leaf = findLeafByTab(splitRoot, tabs[activeIdx].id);
        const parent = findParent(splitRoot, leaf);
        if (parent) {
          const isH = parent.dir === 'horizontal';
          if ((isH && e.key === 'ArrowRight') || (!isH && e.key === 'ArrowDown')) {
            resizeSplit(parent, 0.05);
            return false;
          }
          if ((isH && e.key === 'ArrowLeft') || (!isH && e.key === 'ArrowUp')) {
            resizeSplit(parent, -0.05);
            return false;
          }
          // Alt+Shift+0: reset split to equal
          if (e.key === '0' || e.key === ')') {
            parent.ratio = 0.5;
            applyNodeRatio(parent);
            return false;
          }
        }
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

      // Ctrl+V: paste from clipboard
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'v') {
        navigator.clipboard.readText().then(text => {
          if (text && ws.readyState === 1) ws.send(text);
        });
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

    if (activate) switchTab(tabs.length - 1);
    else renderTabBar();
    return tab;
  }

  function switchTab(idx) {
    if (idx < 0 || idx >= tabs.length) return;

    if (splitRoot) {
      // If tab is already in a pane, focus it
      const leaf = findLeafByTab(splitRoot, tabs[idx].id);
      if (leaf) {
        focusLeaf(leaf);
        return;
      }
      // Replace active pane's tab with the new one
      const active = findLeafByTab(splitRoot, tabs[activeIdx].id);
      if (active) {
        active.tabId = tabs[idx].id;
        if (idx !== activeIdx) prevActiveIdx = activeIdx;
        activeIdx = idx;
        rebuildSplitDOM();
        return;
      }
    }

    if (idx !== activeIdx) prevActiveIdx = activeIdx;
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
    const closingId = tabs[idx].id;
    const wasSplit = !!splitRoot;

    // Remove from split tree if present
    if (splitRoot) {
      const leaf = findLeafByTab(splitRoot, closingId);
      if (leaf) {
        const parent = findParent(splitRoot, leaf);
        if (parent) {
          const childIdx = parent.children.indexOf(leaf);
          const sibling = parent.children[1 - childIdx];
          const grandparent = findParent(splitRoot, parent);
          if (!grandparent) splitRoot = sibling;
          else grandparent.children[grandparent.children.indexOf(parent)] = sibling;
        } else {
          splitRoot = null;
        }
        if (splitRoot && splitRoot.type === 'leaf') {
          activeIdx = tabs.indexOf(tabById(splitRoot.tabId));
          splitRoot = null;
        } else if (splitRoot) {
          const first = allLeaves(splitRoot)[0];
          if (first) activeIdx = tabs.indexOf(tabById(first.tabId));
        }
      }
    }

    // Remember active/prev by ID before splice
    const activeId = tabs[activeIdx]?.id;
    const prevId = tabs[prevActiveIdx]?.id;

    const tab = tabs[idx];
    tab.ws.close();
    tab.term.dispose();
    tab.container.remove();
    tabs.splice(idx, 1);

    if (tabs.length === 0) {
      window.close();
      return;
    }

    // Collapse tree if fewer than 2 leaves
    if (splitRoot) {
      const leaves = allLeaves(splitRoot);
      if (leaves.length < 2) {
        if (leaves.length === 1) activeIdx = tabs.indexOf(tabById(leaves[0].tabId));
        splitRoot = null;
      }
    }

    // Resolve IDs back to indices after splice
    if (activeId === closingId) {
      activeIdx = Math.min(idx, tabs.length - 1);
    } else {
      activeIdx = tabs.findIndex(t => t.id === activeId);
      if (activeIdx === -1) activeIdx = 0;
    }

    if (prevId === closingId) {
      prevActiveIdx = 0;
    } else {
      prevActiveIdx = tabs.findIndex(t => t.id === prevId);
      if (prevActiveIdx === -1) prevActiveIdx = 0;
    }
    if (prevActiveIdx >= tabs.length) prevActiveIdx = tabs.length - 1;

    if (splitRoot || wasSplit) rebuildSplitDOM();
    else switchTab(activeIdx);
  }

  // ── Resize ──
  window.addEventListener('resize', () => {
    if (splitRoot) {
      requestAnimationFrame(() => {
        allLeaves(splitRoot).forEach(l => fitPaneTerminal(l.tabId));
      });
      return;
    }
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
    } catch (err) {}
  };

  // ── Create initial tabs ──
  const initialTabs = parseInt(new URLSearchParams(location.search).get('tabs')) || 1;
  for (let i = 0; i < initialTabs; i++) {
    createTab(i === 0 ? urlName : 'scratch');
  }
  switchTab(0);

  // ── State detector ──
  // Uses output-rate tracking with hysteresis instead of pattern matching.
  // Primary: server-side process monitoring (claudeRunning) for ground truth.
  // Activity: any terminal data flowing = active (no regex needed).
  // Hysteresis: goes active immediately, requires sustained quiet before transitioning.
  setInterval(() => {
    let changed = false;
    const now = Date.now();
    tabs.forEach((tab) => {
      // Use lastOutputAt (echo-suppressed) for state transitions, not raw lastDataAt
      const sinceOutput = now - tab.lastOutputAt;
      const outputFlowing = sinceOutput < 1500;
      const submitActive = tab.submitted && (now - tab.lastInputAt) < 10000;
      let isThinking, isWaiting;

      if (tab.claudeRunning === false) {
        // Server confirmed Claude is not running — idle
        isThinking = false;
        isWaiting = false;
        tab.quietTicks = 0;
        tab.submitted = false;
      } else if (tab.claudeRunning === true) {
        // Server confirmed Claude is running — determine sub-state
        if (submitActive || outputFlowing) {
          // Real output flowing or user just submitted — thinking
          isThinking = true;
          isWaiting = false;
          tab.quietTicks = 0;
          if (outputFlowing) tab.submitted = false;
        } else {
          // Output stopped — hysteresis before switching to waiting
          tab.quietTicks++;
          if (tab.quietTicks >= 8) {
            // 8 ticks × 500ms = 4s of quiet — waiting for input
            isThinking = false;
            isWaiting = true;
          } else {
            // Still in cooldown — stay thinking
            isThinking = true;
            isWaiting = false;
          }
        }
      } else {
        // null — server hasn't reported yet, use output-based heuristic
        if (outputFlowing || submitActive) {
          isThinking = true;
          isWaiting = false;
          tab.quietTicks = 0;
        } else if (tab.thinking || tab.waiting) {
          // Was active, output stopped — hysteresis with waiting state
          tab.quietTicks++;
          if (tab.quietTicks >= 20) {
            // 20 ticks × 500ms = 10s — probably idle
            isThinking = false;
            isWaiting = false;
          } else if (tab.quietTicks >= 8) {
            // 8 ticks × 500ms = 4s — may be waiting for input
            isThinking = false;
            isWaiting = true;
          } else {
            isThinking = true;
            isWaiting = false;
          }
        } else {
          isThinking = false;
          isWaiting = false;
        }
      }

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
    clockEl.textContent = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Lima' });
  };
  updateClock();
  setInterval(updateClock, 1000);
})();
