#!/usr/bin/env node
// Hook: Stop → auto-rename ghost-term tab from conversation context.
// Reads the transcript to get recent user messages, extracts the most
// frequent topic words, and posts a slug to ghost-term's rename API.
// Silently exits if ghost-term isn't running.

const http = require('http');
const fs = require('fs');

const STOP = new Set([
  'the','a','an','is','are','was','were','be','been','have','has','had',
  'do','does','did','will','would','could','should','may','might','can',
  'to','of','in','for','on','with','at','by','from','as','into','through',
  'during','before','after','between','out','off','up','down','over','under',
  'again','then','here','there','when','where','why','how','all','each',
  'every','both','few','more','most','other','some','such','no','nor','not',
  'only','own','same','so','than','too','very','just','because','but','and',
  'or','if','it','its','this','that','these','those','i','me','my','we',
  'our','you','your','he','him','his','she','her','they','them','their',
  'what','which','who','whom','about','also','like','really','want','need',
  'yeah','yes','ok','okay','sure','please','thanks','right','well','now',
  'dont','im','ive','gonna','wanna','lets','hey','hi','hello','yo',
  'make','get','put','set','go','went','going','come','take','give',
  'know','think','see','look','tell','say','said','thing','stuff',
  'actually','basically','something','anything','everything',
  'work','working','works','using','used','file','code','run','running',
  'change','changed','changes','way','new','first','last','still',
  'already','try','trying','tried','keep','back','start','done',
]);

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join(' ');
  }
  return '';
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // Prevent infinite loops
    if (data.stop_hook_active) process.exit(0);

    const tp = data.transcript_path;
    if (!tp || !fs.existsSync(tp)) process.exit(0);

    // Read transcript, collect recent user messages (last 8)
    const lines = fs.readFileSync(tp, 'utf8').trim().split('\n');
    const userTexts = [];
    for (let i = lines.length - 1; i >= 0 && userTexts.length < 8; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.type === 'human' || msg.role === 'user') {
          const text = extractText(msg.content);
          // Skip slash commands and very long (skill-expanded) prompts
          if (text && text.length < 300 && !text.startsWith('/')) {
            userTexts.push(text);
          }
        }
      } catch {}
    }

    if (userTexts.length === 0) process.exit(0);

    // Tokenize all messages, count frequencies
    const freq = {};
    for (const text of userTexts) {
      const words = text.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .split(/[\s-]+/)
        .filter(w => w.length > 2 && !STOP.has(w));
      for (const w of words) freq[w] = (freq[w] || 0) + 1;
    }

    // Pick top 2-3 words by frequency, break ties by first appearance
    const ranked = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);

    if (ranked.length === 0) process.exit(0);
    const slug = ranked.join('-');
    if (slug.length < 3) process.exit(0);

    const body = JSON.stringify({ name: slug });
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/rename-tab',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 1000,
    }, () => process.exit(0));

    req.on('error', () => process.exit(0));
    req.on('timeout', () => { req.destroy(); process.exit(0); });
    req.write(body);
    req.end();
  } catch {
    process.exit(0);
  }
});
