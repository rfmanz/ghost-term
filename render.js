#!/usr/bin/env node
//
// render.js — Convert markdown to cyberpunk-styled HTML
//
// Usage:
//   node render.js input.md                    → output to stdout
//   node render.js input.md output.html        → write to file
//   node render.js input.md --open             → write to output/ and open in Chrome
//   node render.js input.md -o out.html --open → write to file and open
//

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('-'));
const openFlag = args.includes('--open');
const outputArg = args[args.indexOf('-o') + 1] || args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '-o' && a !== inputFile);

if (!inputFile) {
  console.error('Usage: node render.js <input.md> [output.html] [--open]');
  process.exit(1);
}

const md = fs.readFileSync(inputFile, 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const template = fs.readFileSync(path.join(__dirname, 'templates', 'narrative.html'), 'utf8');

// ── Simple markdown to HTML converter ──
function mdToHtml(markdown) {
  let html = markdown;

  // Normalize line endings
  html = html.replace(/\r\n/g, '\n');

  // Escape HTML entities (but preserve markdown syntax)
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Merge adjacent blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Tables
  html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (match, header, sep, body) => {
    const headers = header.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
    const rows = body.trim().split('\n').map(row => {
      const cells = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('\n');
    return `<table>\n<thead><tr>${headers}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
  });

  // Unordered lists
  html = html.replace(/^(?:- (.+)\n?)+/gm, (match) => {
    const items = match.trim().split('\n').map(line => {
      const content = line.replace(/^- /, '');
      return `<li>${content}</li>`;
    }).join('\n');
    return `<ul>\n${items}\n</ul>`;
  });

  // Ordered lists
  html = html.replace(/^(?:\d+\. (.+)\n?)+/gm, (match) => {
    const items = match.trim().split('\n').map(line => {
      const content = line.replace(/^\d+\. /, '');
      return `<li>${content}</li>`;
    }).join('\n');
    return `<ol>\n${items}\n</ol>`;
  });

  // Paragraphs — wrap remaining lines
  html = html.split('\n\n').map(block => {
    block = block.trim();
    if (!block) return '';
    if (block.startsWith('<')) return block;
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n\n');

  // Restore > in HTML tags
  html = html.replace(/&lt;(\/?(?:h[1-6]|p|ul|ol|li|table|thead|tbody|tr|th|td|strong|em|code|pre|blockquote|hr|br|a|span|div)[^&]*?)&gt;/g, '<$1>');

  return html;
}

// ── Extract title from first h1 ──
const titleMatch = md.match(/^# (.+)$/m);
const title = titleMatch ? titleMatch[1].replace(/[*_`]/g, '') : path.basename(inputFile, '.md');

// ── Build HTML ──
const content = mdToHtml(md);

// Handle video — use server URL if available, otherwise try relative path
let videoTag = '';
if (config.video) {
  const videoPath = path.isAbsolute(config.video)
    ? config.video
    : path.join(__dirname, config.video);
  if (fs.existsSync(videoPath)) {
    videoTag = `data-src="file:///${videoPath.replace(/\\/g, '/')}"`;
  }
}

let html = template
  .replace('{{TITLE}}', title)
  .replace('{{CONTENT}}', content);

// Inject video src if available
if (videoTag) {
  html = html.replace('<video id="bgvideo" autoplay muted loop playsinline>',
    `<video id="bgvideo" autoplay muted loop playsinline ${videoTag}>`);
  html = html.replace(
    "if (video.dataset.src) video.src = video.dataset.src;",
    "if (video.dataset.src) video.src = video.dataset.src;"
  );
}

// ── Output ──
const outputFile = outputArg || (openFlag
  ? path.join(__dirname, 'output', path.basename(inputFile, '.md') + '.html')
  : null);

if (outputFile) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, html);
  console.log(`Rendered: ${outputFile}`);

  if (openFlag) {
    const chrome = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
    const flags = '--new-window --start-fullscreen --force-device-scale-factor=1.25';
    const dataDir = `--user-data-dir="${process.env.LOCALAPPDATA}\\Google\\Chrome\\GhostTerm"`;
    const url = `file:///${outputFile.replace(/\\/g, '/')}`;
    try {
      execSync(`start "" ${chrome} ${flags} ${dataDir} --no-first-run --allow-file-access-from-files "${url}"`, { shell: 'cmd.exe' });
    } catch (e) {
      console.log(`Open manually: ${url}`);
    }
  }
} else {
  process.stdout.write(html);
}
