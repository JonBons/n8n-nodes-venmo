#!/usr/bin/env node
/**
 * Turn whatever you copied out of the browser into the single `Cookie` header
 * value to paste into n8n (Header Auth credential: Name = Cookie).
 *
 * Usage:
 *   node tools/parse-cookies.js input.txt
 *   Get-Clipboard | node tools/parse-cookies.js          (PowerShell)
 *   node tools/parse-cookies.js input.txt | clip         (copy result to clipboard)
 *
 * Accepted input (auto-detected):
 *   1. "Copy as cURL" from a DevTools Network request   <- recommended, includes HttpOnly cookies
 *   2. A raw Cookie header:  "Cookie: a=1; b=2"  or just  "a=1; b=2"
 *   3. HAR file (Network tab -> Export HAR)
 *   4. JSON cookie export (Cookie-Editor / EditThisCookie)
 *   5. Netscape cookies.txt
 *   6. Rows copied from DevTools -> Application -> Cookies (tab separated)
 *
 * stdout = the header value only. stderr = cookie NAMES and warnings (never values).
 */
const fs = require('fs');

const file = process.argv[2];
const raw = (file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8')).replace(/^﻿/, '').trim();
if (!raw) {
  console.error('No input. Pipe text in or pass a file path.');
  process.exit(1);
}

const isVenmoDomain = (d) => /(^|\.)venmo\.com$/i.test(String(d || '').replace(/^\./, ''));
const jar = new Map(); // name -> value (later entries win)

function parseHeaderString(s) {
  for (const part of s.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && !/^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(name)) jar.set(name, value);
  }
}

function fromJson(data) {
  // HAR
  if (data && data.log && Array.isArray(data.log.entries)) {
    const venmo = data.log.entries.filter((e) => {
      try { return isVenmoDomain(new URL(e.request.url).hostname); } catch { return false; }
    });
    let best = '';
    for (const e of venmo) {
      const h = (e.request.headers || []).find((x) => x.name.toLowerCase() === 'cookie');
      if (h && h.value.length >= best.length) best = h.value; // longest = most complete
    }
    if (best) return parseHeaderString(best);
    for (const e of venmo) for (const c of e.request.cookies || []) jar.set(c.name, c.value);
    return;
  }
  // Array of cookie objects
  const arr = Array.isArray(data) ? data : data && Array.isArray(data.cookies) ? data.cookies : null;
  if (arr) {
    for (const c of arr) if (c.name && (!c.domain || isVenmoDomain(c.domain))) jar.set(c.name, c.value);
  }
}

function fromCurl(s) {
  const flat = s.replace(/\\\r?\n|\^\r?\n/g, ' '); // bash and cmd line continuations
  const re = /(?:-H|--header)\s+(?:\$?'([^']*)'|"((?:[^"\\]|\\.)*)")|(?:-b|--cookie)\s+(?:\$?'([^']*)'|"((?:[^"\\]|\\.)*)")/g;
  let m, found = false;
  while ((m = re.exec(flat))) {
    const hdr = m[1] ?? m[2];
    const cookieArg = m[3] ?? m[4];
    if (cookieArg) { parseHeaderString(cookieArg); found = true; }
    else if (hdr && /^cookie\s*:/i.test(hdr)) { parseHeaderString(hdr.replace(/^cookie\s*:\s*/i, '')); found = true; }
  }
  return found;
}

function fromTable(s) {
  let found = false;
  for (const line of s.split(/\r?\n/)) {
    if (!line.includes('\t') || line.startsWith('#HttpOnly_') === false && line.startsWith('#')) continue;
    const f = line.replace(/^#HttpOnly_/, '').split('\t');
    if (f.length >= 7 && /^(TRUE|FALSE)$/i.test(f[1])) {           // Netscape
      if (isVenmoDomain(f[0])) { jar.set(f[5], f[6]); found = true; }
    } else if (f.length >= 3 && /\./.test(f[2])) {                  // DevTools Application tab
      if (isVenmoDomain(f[2])) { jar.set(f[0].trim(), f[1].trim()); found = true; }
    }
  }
  return found;
}

let done = false;
if (/^[\[{]/.test(raw)) {
  try { fromJson(JSON.parse(raw)); done = jar.size > 0; } catch { /* fall through */ }
}
if (!done && /\bcurl\b/i.test(raw)) done = fromCurl(raw);
if (!done && raw.includes('\t')) done = fromTable(raw);
if (!done) {
  const m = raw.match(/^\s*cookie\s*:\s*(.+)$/im);
  parseHeaderString(m ? m[1] : raw.replace(/\r?\n/g, '; '));
}

if (jar.size === 0) {
  console.error('Could not find any cookies in the input.');
  process.exit(1);
}

const header = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
console.error(`Parsed ${jar.size} cookies: ${[...jar.keys()].join(', ')}`);
if (/^["'].*["']$/.test(header)) console.error('Warning: value looks quoted; check the input.');
if (jar.size < 3) console.error('Warning: very few cookies. Use "Copy as cURL" from a request to account.venmo.com so HttpOnly cookies are included.');
console.log(header);
