#!/usr/bin/env node
// Hook: Stop -> auto-rename ghost-term tab using Claude Haiku.
// Reads the Claude transcript, sends recent conversation to Haiku for
// a 2-4 word topic label, and posts it to ghost-term's rename API.
// Silently exits if ghost-term or transcript data is unavailable.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Prevent recursion: spawned claude process would re-trigger this hook
if (process.env.GHOST_TERM_RENAME) process.exit(0);

const MAX_MESSAGES = 10;
const MAX_MSG_LENGTH = 300;
const COOLDOWN_MS = 2.5 * 60 * 1000; // 2.5 minutes between renames

const PROMPT = `You are a tab-naming assistant. Given this conversation between a user and Claude, output ONLY a 2-4 word topic label that captures the current focus. Just the label — no quotes, no explanation, no punctuation, no formatting.

`;

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(item => extractText(item)).filter(Boolean).join(' ');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string' || Array.isArray(content.content)) {
      return extractText(content.content);
    }
  }
  return '';
}

function readTranscriptMessages(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.messages)) return parsed.messages;
  } catch {}

  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    try { messages.push(JSON.parse(line)); } catch {}
  }
  return messages;
}

function collectRecentMessages(transcriptPath) {
  const messages = readTranscriptMessages(transcriptPath);
  const recent = [];

  for (let i = messages.length - 1; i >= 0 && recent.length < MAX_MESSAGES; i--) {
    const msg = messages[i];
    const role = msg.role || msg.type;
    const normalized = role === 'human' ? 'user' : role;
    if (normalized !== 'user' && normalized !== 'assistant') continue;

    const text = extractText(msg.content || msg.message || msg.text);
    if (!text) continue;

    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('/') || trimmed.length < 2) continue;

    recent.push({
      role: normalized,
      text: trimmed.length > MAX_MSG_LENGTH ? trimmed.slice(0, MAX_MSG_LENGTH) + '…' : trimmed,
    });
  }

  return recent.reverse();
}

function postRename(name) {
  return new Promise((resolve) => {
    const tabId = process.env.GHOST_TERM_TAB_ID;
    const body = JSON.stringify(tabId ? { name, tabId } : { name });
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/rename-tab',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 2000,
    }, () => resolve());

    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      const data = JSON.parse(input);
      if (data.stop_hook_active) process.exit(0);

      const transcriptPath = data.transcript_path;
      if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

      // Debounce: per-session stamp so tabs don't block each other
      const stampHash = crypto.createHash('md5').update(transcriptPath).digest('hex').slice(0, 8);
      const stampFile = path.join(os.tmpdir(), `ghost-term-rename-${stampHash}`);
      try {
        const stamp = fs.statSync(stampFile).mtimeMs;
        if (Date.now() - stamp < COOLDOWN_MS) process.exit(0);
      } catch {} // no stamp file = first run, proceed

      const messages = collectRecentMessages(transcriptPath);
      if (messages.length === 0) process.exit(0);

      const conversation = messages.map(m => `${m.role}: ${m.text}`).join('\n');

      let label = execSync('claude -p --model haiku', {
        input: PROMPT + conversation,
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, GHOST_TERM_RENAME: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      // Clean up: strip quotes, trailing punctuation
      label = label.replace(/^["']|["']$/g, '').replace(/[.!?]$/, '').trim();

      if (!label || label.length < 3 || label.length > 40) process.exit(0);
      if (label.split(/\s+/).length > 5) process.exit(0);

      await postRename(label);
      // Touch stamp file so we don't rename again too soon
      fs.writeFileSync(stampFile, '');
    } catch {}
    process.exit(0);
  });
}

if (require.main === module) {
  main();
} else {
  module.exports = { collectRecentMessages, extractText };
}
