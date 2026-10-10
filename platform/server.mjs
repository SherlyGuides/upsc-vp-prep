#!/usr/bin/env node
// VP Prep server: a private exam-prep app for the UPSC CRT (Vice Principal, GNCTD).
// Zero npm dependencies. Binds 127.0.0.1 only; a Cloudflare quick tunnel connects to it locally.
//
//   node server.mjs                  (reads .env for STUDY_PASSCODE)
//   env: PORT, STUDY_PASSCODE, DATA_DIR, UNIT_FIXTURE, STATE_DIR, KB_DIR, CLAUDE_BIN,
//        VP_EFFORT (default high), VP_MAX_CLI (default 3), VP_CLI_TIMEOUT_MS (default 360000)

import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildKb, loadUnitFiles, UNIT_IDS, UNIT_TITLES, paths as kbPaths } from './scripts/build-kb.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(ROOT, '.env'));

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8787;
const PASSCODE = String(process.env.STUDY_PASSCODE || '').trim();
const PUBLIC_DIR = path.join(ROOT, 'public');
const PROMPTS_DIR = path.join(ROOT, 'prompts');
const STATE_DIR = path.resolve(process.env.STATE_DIR || path.join(ROOT, 'state'));
const { kbDir: KB_DIR, dataDir: DATA_DIR } = kbPaths();
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const ATTEMPTS_FILE = path.join(STATE_DIR, 'attempts.jsonl');
const REQUEST_LOG = path.join(STATE_DIR, 'requests.log');
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude';
const EFFORT = /^(low|medium|high|xhigh|max)$/.test(process.env.VP_EFFORT || '') ? process.env.VP_EFFORT : 'high';
const MAX_CLI = Math.max(1, Number(process.env.VP_MAX_CLI) || 3);
const CLI_TIMEOUT_MS = Number(process.env.VP_CLI_TIMEOUT_MS) || 6 * 60 * 1000;
const BODY_LIMIT = 256 * 1024;
const ATTEMPT_LIMIT = 200 * 1024;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const COOKIE = 'vpprep_session';
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_PER_IP = 5;
const FAIL_GLOBAL = 40;
const EXAM_DATE = '2026-11-01';

const MODELS = {
  fable: { id: 'claude-fable-5-1', fallback: 'claude-opus-5-5' },
  opus: { id: 'claude-opus-5-5', fallback: 'claude-fable-5-1' },
};
const MODEL_LABELS = {
  'claude-fable-5-1': 'Fable 5.1',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-4-8': 'Opus 4.8',
};

// ---------------------------------------------------------------- utilities

function loadDotEnv(file) {
  let txt = '';
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();
const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const clip = (s, n) => {
  s = typeof s === 'string' ? s : s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const str = (v, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function daysToExam() {
  const a = Date.parse(istToday() + 'T00:00:00Z');
  const b = Date.parse(EXAM_DATE + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

function writeFileAtomic(file, content, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64);
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  const p = req.headers['x-forwarded-proto'];
  return typeof p === 'string' && p.split(',')[0].trim().toLowerCase() === 'https';
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------- security headers

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()');
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
}

function sendBody(req, res, status, type, body, extraHeaders = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const headers = { 'Content-Type': type, ...extraHeaders };
  if (buf.length > 1400 && acceptsGzip(req) && /json|text|javascript|svg|css|html/.test(type)) {
    buf = zlib.gzipSync(buf, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function sendJson(req, res, status, obj, extraHeaders = {}) {
  if (status >= 400) res._vpOk = false;
  sendBody(req, res, status, 'application/json; charset=utf-8', JSON.stringify(obj), { 'Cache-Control': 'no-store', ...extraHeaders });
}

function notFound(req, res) {
  res._vpOk = false;
  sendBody(req, res, 404, 'text/plain; charset=utf-8', 'Not found', { 'Cache-Control': 'no-store' });
}

// ---------------------------------------------------------------- request log

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const logStream = fs.createWriteStream(REQUEST_LOG, { flags: 'a', mode: 0o600 });
function logRequest(method, pathname, status, ms, ok, note = '') {
  // Never log bodies, cookies, query strings or the passcode.
  const p = pathname.length > 120 ? pathname.slice(0, 120) + '…' : pathname;
  logStream.write(`${new Date().toISOString()}\t${method} ${p.replace(/[\s\t\r\n]/g, '_')}\t${status}\t${ms}ms\t${ok ? 'ok' : 'fail'}${note ? '\t' + note : ''}\n`);
}

// ---------------------------------------------------------------- sessions & login throttle

const sessions = new Map(); // sha256hex(token) -> { created, expires }
function loadSessions() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(j.sessions || {})) {
      if (/^[a-f0-9]{64}$/.test(k) && v && v.expires > now) sessions.set(k, { created: v.created, expires: v.expires });
    }
  } catch {
    /* no sessions yet */
  }
}
let saveTimer = null;
function saveSessionsSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSessionsNow();
  }, 300);
}
function saveSessionsNow() {
  const now = Date.now();
  const out = {};
  for (const [k, v] of sessions) if (v.expires > now) out[k] = v;
  try {
    writeFileAtomic(SESSIONS_FILE, JSON.stringify({ version: 1, sessions: out }, null, 1));
  } catch (e) {
    console.error('[sessions] save failed:', e.message);
  }
}

const OPEN_ACCESS = process.env.OPEN_ACCESS === '1';
const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://sherlyguides.github.io';
function getSession(req) {
  if (OPEN_ACCESS) return { key: 'open', tok: '', s: { expires: Infinity } };
  const tok = parseCookies(req.headers.cookie)[COOKIE];
  if (!tok || !/^[A-Za-z0-9_-]{43}$/.test(tok)) return null;
  const key = sha256hex(tok);
  const s = sessions.get(key);
  if (!s) return null;
  if (s.expires <= Date.now()) {
    sessions.delete(key);
    saveSessionsSoon();
    return null;
  }
  return { key, tok, s };
}

function sessionCookie(req, token, maxAgeS) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${isHttps(req) ? '; Secure' : ''}`;
}

// Sliding renewal: once a session is past its first 10 days, extend it to a fresh 30 days.
function maybeRenew(req, res, sess) {
  if (sess.s.expires - Date.now() < SESSION_MS - 10 * 24 * 3600 * 1000) {
    sess.s.expires = Date.now() + SESSION_MS;
    saveSessionsSoon();
    res.setHeader('Set-Cookie', sessionCookie(req, sess.tok, SESSION_MS / 1000));
  }
}

const failures = new Map(); // ip -> [timestamps]
let globalFailures = [];
function pruneFails(arr, now) {
  return arr.filter((t) => now - t < FAIL_WINDOW_MS);
}
function throttleState(ip) {
  const now = Date.now();
  globalFailures = pruneFails(globalFailures, now);
  const mine = pruneFails(failures.get(ip) || [], now);
  if (mine.length) failures.set(ip, mine);
  else failures.delete(ip);
  if (mine.length >= FAIL_PER_IP) return { blocked: true, retry: Math.ceil((mine[0] + FAIL_WINDOW_MS - now) / 1000) };
  if (globalFailures.length >= FAIL_GLOBAL) return { blocked: true, retry: Math.ceil((globalFailures[0] + FAIL_WINDOW_MS - now) / 1000) };
  return { blocked: false, remaining: FAIL_PER_IP - mine.length };
}
function recordFailure(ip) {
  const now = Date.now();
  const mine = failures.get(ip) || [];
  mine.push(now);
  failures.set(ip, mine);
  globalFailures.push(now);
  if (failures.size > 5000) failures.clear(); // memory guard
}

// ---------------------------------------------------------------- units & knowledge base

let unitCache = { at: 0, units: new Map() };
function getUnits() {
  if (Date.now() - unitCache.at > 3000) {
    const { units } = loadUnitFiles();
    unitCache = { at: Date.now(), units };
  }
  return unitCache.units;
}

let kbSignature = '';
let kbCheckedAt = 0;
function unitsSignature(units) {
  return [...units.entries()].map(([id, u]) => `${id}:${u.mtimeMs}:${u.size}`).sort().join('|');
}
function runBuildKb(reason) {
  try {
    const r = buildKb(process.env, (m) => console.log(m));
    kbSignature = unitsSignature(getUnits());
    return r;
  } catch (e) {
    console.error(`[build-kb] failed (${reason}):`, e.message);
    return null;
  }
}
// Unit files are added by other agents while the server runs, so rebuild kb/ when they change.
function ensureKbFresh() {
  if (Date.now() - kbCheckedAt < 15000) return;
  kbCheckedAt = Date.now();
  unitCache.at = 0;
  const sig = unitsSignature(getUnits());
  if (sig !== kbSignature) runBuildKb('data changed');
}

function availableUnitIds() {
  const units = getUnits();
  const ids = [...units.keys()];
  return ids.sort((a, b) => {
    const ia = UNIT_IDS.indexOf(a), ib = UNIT_IDS.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

// ---------------------------------------------------------------- Claude CLI

let claudeOk = false;
let claudeCheckedAt = 0;
function checkClaude() {
  claudeCheckedAt = Date.now();
  execFile(CLAUDE_BIN, ['--version'], { timeout: 20000, env: childEnv() }, (err, stdout) => {
    claudeOk = !err && /\d+\.\d+/.test(String(stdout));
    if (!claudeOk) console.error(`[claude] not available at ${CLAUDE_BIN}: ${err ? err.message : 'unexpected output'}`);
  });
}

function childEnv() {
  const env = { ...process.env };
  delete env.STUDY_PASSCODE; // the tutor never needs the passcode
  delete env.CLAUDECODE; // marks a nested Claude Code session when started from inside one
  return env;
}

// Common flags. Every one of these was checked against claude 2.1.285 (see README):
//  --restricted        removes Bash/code tools and WebFetch, ignores user/project settings,
//                      confines Read/Grep/Glob to the cwd (kb/), refuses symlinks out of it
//  --safe-mode         no CLAUDE.md, skills, plugins, hooks, MCP servers or output styles
//  --tools             only these tools exist; --disallowedTools is a second lock
function cliArgs({ model, fallback, format, tools, promptFile, extra = [] }) {
  return [
    '-p',
    '--model', model,
    '--fallback-model', fallback,
    '--effort', EFFORT,
    '--output-format', format,
    ...(format === 'stream-json' ? ['--verbose', '--include-partial-messages'] : []),
    '--no-session-persistence',
    '--restricted',
    '--safe-mode',
    '--tools', tools,
    '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,WebFetch',
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--append-system-prompt-file', promptFile,
    ...extra,
  ];
}

// At most MAX_CLI CLI processes at once; the rest wait in a FIFO queue.
let running = 0;
const waiters = [];
function acquireSlot(signal, onQueued) {
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      running--;
      const next = waiters.shift();
      if (next) next.start();
      waiters.forEach((w, i) => w.onPos && w.onPos(i + 1));
    };
    if (running < MAX_CLI) {
      running++;
      return resolve(release);
    }
    const w = {
      start: () => {
        running++;
        signal?.removeEventListener('abort', onAbort);
        resolve(release);
      },
      onPos: onQueued,
    };
    const onAbort = () => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(w);
    onQueued && onQueued(waiters.length);
  });
}

const activeChildren = new Set();
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }
  }, 3000).unref();
}

function runCli({ args, input, onLine, signal, timeoutMs = CLI_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      // argv array, no shell. detached => own process group, so a kill also stops its helpers.
      child = spawn(CLAUDE_BIN, args, { cwd: KB_DIR, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      return resolve({ code: -1, error: e, stderr: '', timedOut: false });
    }
    activeChildren.add(child);
    let stderr = '';
    let buf = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => killTree(child);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      activeChildren.delete(child);
      resolve({ ...r, stderr, timedOut });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) {
          try { onLine(line); } catch (e) { console.error('[cli] line handler:', e.message); }
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on('error', (e) => finish({ code: -1, error: e }));
    child.on('close', (code, sig) => {
      if (buf.trim()) {
        try { onLine(buf); } catch { /* ignore */ }
      }
      finish({ code, signal: sig });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  });
}

function friendlyCliError(r, resultLine) {
  if (r.timedOut) return { code: 'timeout', message: 'Claude took longer than 6 minutes and was stopped. Try a shorter or more specific question.' };
  if (r.error && r.error.code === 'ENOENT') return { code: 'claude_missing', message: 'The Claude CLI was not found on the Mac. Ask your brother to check the server.' };
  const txt = `${resultLine?.result || ''} ${r.stderr || ''}`.toLowerCase();
  if (/rate.?limit|usage limit|429|quota/.test(txt)) return { code: 'rate_limited', message: 'Claude usage limit reached for now. Try again later.' };
  if (/log ?in|authenticat|401|oauth|credential/.test(txt)) return { code: 'auth', message: 'Claude is not logged in on the Mac. Ask your brother to run "claude" and log in.' };
  if (/overloaded|529|503/.test(txt)) return { code: 'overloaded', message: 'Claude is overloaded right now. Try again in a minute.' };
  return { code: 'cli_failed', message: 'Claude could not answer this time. Please try again.' };
}

function modelLabel(id) {
  return MODEL_LABELS[id] || id || 'Claude';
}

function toolStatus(name, input) {
  const n = String(name || '');
  if (/web_?search/i.test(n)) return input && input.query ? `Searching the web: ${clip(input.query, 70)}` : 'Searching the web…';
  if (n === 'Grep') return input && input.pattern ? `Searching notes for “${clip(input.pattern, 40)}”…` : 'Searching notes…';
  if (n === 'Glob') return 'Looking through the notes…';
  if (n === 'Read') {
    const f = input && typeof input.file_path === 'string' ? input.file_path : '';
    if (f) {
      const rel = path.relative(KB_DIR, path.resolve(KB_DIR, f));
      const m = rel.match(/^units\/([a-z0-9_-]+)\.md$/);
      if (m) return `Reading notes: ${UNIT_TITLES[m[1]] || m[1]}…`;
      if (!rel.startsWith('..')) return `Reading ${clip(rel, 50)}…`;
    }
    return 'Reading notes…';
  }
  return 'Working…';
}

// ---------------------------------------------------------------- prompts

const LANG_LINE = {
  en: 'en: reply in English (official Hindi terms in brackets for key terms are fine).',
  hi: 'hi: reply in Hindi (Devanagari), with English technical terms in brackets.',
  both: 'both: reply in English first, then a line ---, then the same answer in Hindi (Devanagari).',
};

function cleanMcqContext(m) {
  if (!m || typeof m !== 'object') return null;
  const opts = (a) => (Array.isArray(a) ? a.slice(0, 4).map((x) => str(x, 600)) : []);
  const c = {
    id: str(m.id, 60),
    unit: str(m.unit, 40),
    q: str(m.q || m.q_en, 3000),
    q_hi: str(m.q_hi, 3000),
    options: opts(m.options || m.options_en),
    options_hi: opts(m.options_hi),
    answer: Number.isInteger(m.answer) && m.answer >= 0 && m.answer < 4 ? m.answer : null,
    chosen: Number.isInteger(m.chosen) && m.chosen >= 0 && m.chosen < 4 ? m.chosen : null,
    explain: str(m.explain || m.explain_en, 2000),
    source: str(m.source, 300),
  };
  return c.q ? c : null;
}

function buildAskPrompt({ messages, lang, context }) {
  const L = ['A', 'B', 'C', 'D'];
  const avail = availableUnitIds();
  const out = [];
  out.push('Request from the VP Prep study app.');
  out.push(`Today: ${istToday()} (IST). Days left to the CRT (01 Nov 2026): ${daysToExam()}.`);
  out.push(`Reply language: ${LANG_LINE[lang]}`);
  out.push(`Units available in units/: ${avail.length ? avail.join(', ') : 'none yet'}.`);
  if (context && context.unit && /^[a-z0-9_-]{1,40}$/.test(context.unit)) {
    out.push(`Context: she is studying unit "${context.unit}" (${UNIT_TITLES[context.unit] || context.unit}); its notes are in units/${context.unit}.md.`);
  }
  const mcq = context ? cleanMcqContext(context.mcq) : null;
  if (mcq) {
    out.push('');
    out.push(`Context: she is asking about this MCQ${mcq.id ? ` (${mcq.id}` + (mcq.unit ? `, unit ${mcq.unit})` : ')') : ''}:`);
    out.push(`Q: ${mcq.q}`);
    mcq.options.forEach((o, i) => out.push(`(${L[i]}) ${o}`));
    if (mcq.q_hi) {
      out.push(`Hindi: ${mcq.q_hi}`);
      mcq.options_hi.forEach((o, i) => out.push(`(${L[i]}) ${o}`));
    }
    if (mcq.answer !== null) out.push(`Key given by the question bank: (${L[mcq.answer]})`);
    if (mcq.chosen !== null) out.push(`She chose: (${L[mcq.chosen]})${mcq.answer !== null ? (mcq.chosen === mcq.answer ? ' (correct)' : ' (wrong)') : ''}`);
    if (mcq.explain) out.push(`Explanation given: ${mcq.explain}`);
    if (mcq.source) out.push(`Source given: ${mcq.source}`);
    out.push('If you find that the key or explanation is wrong, say so clearly and explain why.');
  }
  out.push('');
  out.push('Conversation so far (oldest first):');
  for (const m of messages) {
    const tag = m.role === 'user' ? 'student' : 'tutor';
    const content = m.role === 'assistant' ? clip(m.content, 5000) : clip(m.content, 8000);
    out.push(`<${tag}>\n${content}\n</${tag}>`);
  }
  out.push('');
  out.push("Answer the student's latest message, following your standing instructions.");
  return out.join('\n');
}

const MCQ_TYPES = ['direct', 'statements', 'match', 'assertion', 'sequence', 'numeric', 'fill'];
const DIFFS = ['easy', 'medium', 'hard'];
const MCQ_SCHEMA = {
  type: 'object',
  properties: {
    mcqs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          unit: { type: 'string' },
          topic: { type: 'string' },
          difficulty: { type: 'string', enum: DIFFS },
          type: { type: 'string', enum: MCQ_TYPES },
          mono: { type: 'boolean' },
          q_en: { type: 'string' },
          q_hi: { type: 'string' },
          options_en: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 },
          options_hi: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 },
          answer: { type: 'integer', minimum: 0, maximum: 3 },
          explain_en: { type: 'string' },
          explain_hi: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['unit', 'topic', 'difficulty', 'type', 'mono', 'q_en', 'q_hi', 'options_en', 'options_hi', 'answer', 'explain_en', 'explain_hi', 'source'],
        additionalProperties: false,
      },
    },
  },
  required: ['mcqs'],
  additionalProperties: false,
};

const normStem = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 160);

function cleanGeneratedMcq(m, allowed) {
  if (!m || typeof m !== 'object') return null;
  const q_en = str(m.q_en, 4000);
  const q_hi = str(m.q_hi, 4000);
  const four = (a) => (Array.isArray(a) && a.length === 4 && a.every((x) => typeof x === 'string' && x.trim()) ? a.map((x) => x.trim().slice(0, 600)) : null);
  const options_en = four(m.options_en);
  const options_hi = four(m.options_hi);
  const answer = m.answer;
  const explain_en = str(m.explain_en, 2000);
  const explain_hi = str(m.explain_hi, 2000);
  const source = str(m.source, 300);
  if (!q_en || !q_hi || !options_en || !options_hi || !explain_en || !explain_hi || !source) return null;
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) return null;
  if (new Set(options_en.map(normStem)).size < 4) return null; // duplicate options => ambiguous
  const unit = allowed.includes(m.unit) ? m.unit : allowed[0];
  return {
    id: `gen-${unit}-${crypto.randomBytes(4).toString('hex')}`,
    unit,
    topic: str(m.topic, 120) || 'General',
    difficulty: DIFFS.includes(m.difficulty) ? m.difficulty : 'medium',
    type: MCQ_TYPES.includes(m.type) ? m.type : 'direct',
    mono: m.mono === true,
    q_en,
    q_hi,
    options_en,
    options_hi,
    answer,
    explain_en,
    explain_hi,
    source,
  };
}

function buildGeneratePrompt({ count, units, lang, difficulty, avoid }) {
  // Spread the count across the requested units in order.
  const per = {};
  units.forEach((u) => (per[u] = 0));
  for (let i = 0; i < count; i++) per[units[i % units.length]]++;
  const plan = units.filter((u) => per[u] > 0).map((u) => `- ${per[u]} from unit "${u}" (${UNIT_TITLES[u] || u}): read units/${u}.md first`);
  const out = [
    `Write exactly ${count} new MCQ${count > 1 ? 's' : ''} for the UPSC CRT (Vice Principal, GNCTD), 01 Nov 2026.`,
    `Today: ${istToday()} (IST).`,
    '',
    'Plan:',
    ...plan,
    '',
    `Difficulty: ${difficulty === 'mixed' ? 'mixed (about 30% easy, 50% medium, 20% hard)' : `all ${difficulty}`}.`,
    `The student reads mostly in: ${lang === 'hi' ? 'Hindi' : lang === 'both' ? 'English and Hindi' : 'English'} (still fill every English and Hindi field).`,
    'Set each question\'s "unit" field to its unit id.',
  ];
  if (avoid.length) {
    out.push('', 'Do NOT repeat or lightly reword any of these existing question stems:');
    for (const a of avoid) out.push(`- ${a}`);
  }
  out.push('', 'Return the questions as structured output: {"mcqs": [...]}.');
  return out.join('\n');
}

function extractMcqArray(resultLine) {
  if (resultLine && resultLine.structured_output && Array.isArray(resultLine.structured_output.mcqs)) return resultLine.structured_output.mcqs;
  const txt = resultLine && typeof resultLine.result === 'string' ? resultLine.result : '';
  const tryParse = (s) => {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j;
      if (j && Array.isArray(j.mcqs)) return j.mcqs;
    } catch { /* not JSON */ }
    return null;
  };
  let a = tryParse(txt.trim());
  if (a) return a;
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && (a = tryParse(fence[1].trim()))) return a;
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s >= 0 && e > s && (a = tryParse(txt.slice(s, e + 1)))) return a;
  return [];
}

// ---------------------------------------------------------------- body parsing

function readJson(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(ct)) return reject(new HttpError(415, 'content_type_must_be_json'));
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) return reject(new HttpError(413, 'body_too_large'));
    let size = 0;
    const chunks = [];
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'body_too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      const txt = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(txt ? JSON.parse(txt) : {});
      } catch {
        reject(new HttpError(400, 'invalid_json'));
      }
    });
    req.on('error', (e) => {
      if (!failed) reject(new HttpError(400, 'bad_request'));
      failed = true;
    });
  });
}

function rejectCrossSite(req) {
  // SameSite=Lax already keeps the cookie off cross-site POSTs; this is a second check.
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site' && req.headers.origin !== PAGES_ORIGIN) throw new HttpError(403, 'cross_site_request');
}

// ---------------------------------------------------------------- handlers

async function handleLogin(req, res) {
  rejectCrossSite(req);
  const ip = clientIp(req);
  const t = throttleState(ip);
  if (t.blocked) return sendJson(req, res, 429, { error: 'too_many_attempts', retry_after_s: t.retry }, { 'Retry-After': String(t.retry) });
  const body = await readJson(req, 4096);
  const given = String((body && body.passcode) ?? '').trim().slice(0, 64);
  const ok = crypto.timingSafeEqual(sha256(given), sha256(PASSCODE));
  if (!ok) {
    recordFailure(ip);
    const after = throttleState(ip);
    return sendJson(req, res, 401, { error: 'wrong_passcode', remaining: after.blocked ? 0 : after.remaining });
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(sha256hex(token), { created: Date.now(), expires: Date.now() + SESSION_MS });
  saveSessionsSoon();
  return sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
}

async function handleLogout(req, res, sess) {
  rejectCrossSite(req);
  if (sess) {
    sessions.delete(sess.key);
    saveSessionsSoon();
  }
  return sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
}

function handleHealth(req, res) {
  if (Date.now() - claudeCheckedAt > 5 * 60 * 1000) checkClaude();
  return sendJson(req, res, 200, { ok: true, units: availableUnitIds(), claude: claudeOk });
}

function handleUnits(req, res) {
  const units = getUnits();
  const ids = [...new Set([...UNIT_IDS, ...units.keys()])];
  const list = ids.map((id) => {
    const u = units.get(id);
    if (!u) return { id, available: false, title_en: UNIT_TITLES[id] || id, title_hi: '', mcq_count: 0 };
    const unit = u.unit;
    return {
      id,
      available: true,
      title_en: str(unit.title_en, 200) || UNIT_TITLES[id] || id,
      title_hi: str(unit.title_hi, 200),
      official_topic: str(unit.official_topic, 300),
      mcq_count: unit.mcqs.length,
      facts_count: unit.quick_facts.length,
      words: String(unit.notes_md || '').split(/\s+/).filter(Boolean).length,
      updated: Math.round(u.mtimeMs),
    };
  });
  return sendJson(req, res, 200, { units: list, exam_date: EXAM_DATE, today: istToday(), days_to_exam: daysToExam() });
}

function handleData(req, res, pathname) {
  const m = pathname.match(/^\/data\/([a-z0-9_-]{1,40})\.json$/);
  if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) return notFound(req, res);
  const u = getUnits().get(m[1]);
  if (!u) return notFound(req, res);
  const etag = `"u-${Math.round(u.mtimeMs)}-${u.size}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' });
    return res.end();
  }
  // Serve the parsed copy (a file that is mid-write by another agent is never served half-done).
  return sendBody(req, res, 200, 'application/json; charset=utf-8', JSON.stringify(u.unit), { ETag: etag, 'Cache-Control': 'private, no-cache' });
}

// Answers keep being written when a phone drops the connection (app switched, screen locked);
// the app fetches the finished answer by its request id. Kept in memory for 30 minutes.
const ASK_RESULTS = new Map();
const askAborts = new Map();
function putResult(id, v) {
  if (!id) return;
  ASK_RESULTS.set(id, { ...v, at: Date.now() });
  for (const [k, r] of ASK_RESULTS) if (Date.now() - r.at > 30 * 60e3) ASK_RESULTS.delete(k);
}
function handleAskResult(req, res, url) {
  const id = String(url.searchParams.get('id') || '');
  const r = /^[A-Za-z0-9_-]{8,64}$/.test(id) ? ASK_RESULTS.get(id) : null;
  return sendJson(req, res, 200, r ? r : { status: 'unknown' });
}
async function handleAskCancel(req, res) {
  const body = await readJson(req);
  const ac = askAborts.get(String(body && body.req_id || ''));
  if (ac) ac.abort();
  return sendJson(req, res, 200, { ok: true });
}
async function handleAsk(req, res) {
  rejectCrossSite(req);
  const body = await readJson(req);
  const raw = Array.isArray(body && body.messages) ? body.messages : null;
  if (!raw || !raw.length) throw new HttpError(400, 'messages_required');
  const msgs = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 12000) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new HttpError(400, 'last_message_must_be_user');
  const lang = ['en', 'hi', 'both'].includes(body.lang) ? body.lang : 'en';
  const mk = body.model === 'opus' ? 'opus' : 'fable';
  const context = body.context && typeof body.context === 'object' ? body.context : null;
  const reqId = typeof body.req_id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.req_id) ? body.req_id : null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  let finished = false;
  const send = (event, data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ac = new AbortController();
  if (reqId) { askAborts.set(reqId, ac); putResult(reqId, { status: 'running' }); }
  res.on('close', () => {
    if (!finished) {
      res._vpNote = 'client_closed';
      if (!reqId) ac.abort(); // with a request id the answer is finished and kept for the app to collect
    }
  });
  // Heartbeat keeps Cloudflare (100 s idle limit) and phones from dropping the stream.
  const hb = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  const end = (ok) => {
    finished = true;
    clearInterval(hb);
    if (!ok) res._vpOk = false;
    if (!res.writableEnded) res.end();
  };

  send('status', { text: 'Thinking…', phase: 'start' });
  let release;
  try {
    release = await acquireSlot(ac.signal, (pos) => send('status', { text: pos > 1 ? `Queued (${pos} ahead)…` : 'Queued (next)…', phase: 'queued', position: pos }));
  } catch {
    putResult(reqId, { status: 'error', message: 'Stopped.' });
    return end(false);
  }
  try {
    ensureKbFresh();
    send('status', { text: 'Thinking…', phase: 'running' });
    const t0 = Date.now();
    const m = MODELS[mk];
    let modelUsed = m.id;
    let refusalNote = '';
    let streamed = '';
    let resultLine = null;
    const args = cliArgs({ model: m.id, fallback: m.fallback, format: 'stream-json', tools: 'Read,Grep,Glob,WebSearch', promptFile: path.join(PROMPTS_DIR, 'tutor.md') });
    const r = await runCli({
      args,
      input: buildAskPrompt({ messages: msgs.slice(-12), lang, context }),
      signal: ac.signal,
      onLine: (line) => {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.parent_tool_use_id) return; // ignore sub-agent chatter
        if (ev.type === 'stream_event' && ev.event) {
          const e = ev.event;
          if (e.type === 'message_start' && e.message && e.message.model) modelUsed = e.message.model;
          else if (e.type === 'content_block_start' && e.content_block) {
            const cb = e.content_block;
            if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
              send('status', { text: toolStatus(cb.name, null), tool: cb.name });
              if (streamed) {
                // Text written before a tool call is a preamble; the final answer follows.
                streamed = '';
                send('reset', {});
              }
            }
          } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) {
            streamed += e.delta.text;
            send('delta', { t: e.delta.text });
          }
        } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          for (const c of ev.message.content) {
            if (c.type === 'tool_use' || c.type === 'server_tool_use') send('status', { text: toolStatus(c.name, c.input), tool: c.name });
          }
        } else if (ev.type === 'system' && ev.subtype === 'model_refusal_fallback') {
          refusalNote = `${modelLabel(ev.original_model)} safeguard; answered by ${modelLabel(ev.fallback_model)}`;
          if (streamed) {
            streamed = '';
            send('reset', {});
          }
          send('status', { text: 'Retrying with another model…' });
        } else if (ev.type === 'result') {
          resultLine = ev;
        }
      },
    });
    if (ac.signal.aborted && !r.timedOut) { putResult(reqId, { status: 'error', message: 'Stopped.' }); return end(false); }
    const ms = Date.now() - t0;
    if (resultLine && !resultLine.is_error && resultLine.subtype === 'success') {
      const text = typeof resultLine.result === 'string' && resultLine.result.trim() ? resultLine.result : streamed;
      send('done', { text, model: modelUsed, model_label: modelLabel(modelUsed), note: refusalNote || undefined, ms });
      putResult(reqId, { status: 'done', text, model_label: modelLabel(modelUsed), note: refusalNote || undefined, ms });
      res._vpNote = `model=${modelUsed} ${ms}ms`;
      return end(true);
    }
    const err = friendlyCliError(r, resultLine);
    console.error(`[ask] failed: code=${r.code} timedOut=${r.timedOut} subtype=${resultLine && resultLine.subtype} stderr=${clip(r.stderr, 300)}`);
    send('error', err);
    putResult(reqId, { status: 'error', message: err.message || 'Claude could not answer.' });
    res._vpNote = err.code;
    return end(false);
  } finally {
    release();
    if (reqId) askAborts.delete(reqId);
  }
}

async function handleGenerate(req, res) {
  rejectCrossSite(req);
  const body = await readJson(req);
  const count = Number(body && body.count);
  if (!Number.isInteger(count) || count < 1 || count > 15) throw new HttpError(400, 'count_must_be_1_to_15');
  const avail = availableUnitIds();
  let units = Array.isArray(body.units) ? body.units.filter((u) => typeof u === 'string') : ['all'];
  if (!units.length || units.includes('all')) units = avail;
  units = [...new Set(units)].filter((u) => avail.includes(u));
  if (!units.length) throw new HttpError(400, 'no_known_units');
  const lang = ['en', 'hi', 'both'].includes(body.lang) ? body.lang : 'en';
  const difficulty = ['mixed', 'easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : 'mixed';
  const avoid = (Array.isArray(body.avoid) ? body.avoid : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, 300)
    .map((s) => clip(s.replace(/\s+/g, ' ').trim(), 200));

  // A batch can take minutes, longer than Cloudflare's 100 s wait for the first byte, so after
  // 10 s we send headers and then a space every 15 s (JSON.parse ignores leading whitespace).
  const ac = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished) {
      res._vpNote = 'client_closed';
      ac.abort();
    }
  });
  const startStream = () => {
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
    }
  };
  const early = setTimeout(() => {
    startStream();
    res.write(' ');
  }, 10000);
  const hb = setInterval(() => {
    startStream();
    if (!res.writableEnded) res.write(' ');
  }, 15000);
  const finish = (status, obj) => {
    finished = true;
    clearTimeout(early);
    clearInterval(hb);
    if (status >= 400 || obj.error) res._vpOk = false;
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) return sendJson(req, res, status, obj);
    res.end(JSON.stringify(obj));
  };

  let release;
  try {
    release = await acquireSlot(ac.signal);
  } catch {
    return finish(499, { error: 'aborted', mcqs: [] });
  }
  try {
    ensureKbFresh();
    const t0 = Date.now();
    let resultLine = null;
    const lines = [];
    const args = cliArgs({
      model: 'claude-fable-5-1',
      fallback: 'claude-opus-5-5',
      format: 'json',
      tools: 'Read,Grep,Glob',
      promptFile: path.join(PROMPTS_DIR, 'generate.md'),
      extra: ['--json-schema', JSON.stringify(MCQ_SCHEMA)],
    });
    const r = await runCli({
      args,
      input: buildGeneratePrompt({ count, units, lang, difficulty, avoid }),
      signal: ac.signal,
      onLine: (line) => {
        if (lines.length < 5000) lines.push(line);
        try {
          const j = JSON.parse(line);
          if (j && j.type === 'result') resultLine = j;
        } catch { /* may be pretty-printed; parsed as a whole below */ }
      },
    });
    if (ac.signal.aborted && !r.timedOut) return finish(499, { error: 'aborted', mcqs: [] });
    if (!resultLine) {
      try {
        const j = JSON.parse(lines.join('\n'));
        if (j && j.type === 'result') resultLine = j;
      } catch { /* no result */ }
    }
    if (!resultLine || resultLine.is_error || resultLine.subtype !== 'success') {
      const err = friendlyCliError(r, resultLine);
      console.error(`[generate] failed: code=${r.code} timedOut=${r.timedOut} subtype=${resultLine && resultLine.subtype} stderr=${clip(r.stderr, 300)}`);
      res._vpNote = err.code;
      return finish(r.timedOut ? 504 : 502, { error: err.code, message: err.message, mcqs: [] });
    }
    const rawList = extractMcqArray(resultLine);
    const seen = new Set(avoid.map(normStem));
    const mcqs = [];
    let dropped = 0;
    for (const raw of rawList) {
      const c = cleanGeneratedMcq(raw, units);
      const k = c ? normStem(c.q_en) : '';
      if (!c || seen.has(k)) {
        dropped++;
        continue;
      }
      seen.add(k);
      mcqs.push(c);
      if (mcqs.length >= count) break;
    }
    const model = (resultLine.modelUsage && Object.keys(resultLine.modelUsage).find((k) => /fable|opus-5/.test(k))) || 'claude-fable-5-1';
    res._vpNote = `n=${mcqs.length}/${count} dropped=${dropped} ${Date.now() - t0}ms`;
    return finish(200, { mcqs, requested: count, dropped, model, ms: Date.now() - t0 });
  } finally {
    release();
  }
}

function readAttempts() {
  let txt = '';
  try {
    txt = fs.readFileSync(ATTEMPTS_FILE, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch { /* skip a damaged line */ }
  }
  return out;
}
const attemptIds = new Set();

async function handleAttempt(req, res) {
  rejectCrossSite(req);
  const body = await readJson(req);
  const a = body && body.attempt;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new HttpError(400, 'attempt_object_required');
  const kind = ['mock', 'practice', 'chat_mcq', 'study'].includes(a.kind) ? a.kind : null;
  if (!kind) throw new HttpError(400, 'attempt_kind_invalid');
  const json = JSON.stringify(a);
  if (json.length > ATTEMPT_LIMIT) throw new HttpError(413, 'attempt_too_large');
  const id = typeof a.id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(a.id) ? a.id : crypto.randomUUID();
  if (attemptIds.has(id)) return sendJson(req, res, 200, { ok: true, id, duplicate: true });
  const rec = { ...a, id, kind, saved_at: new Date().toISOString() };
  fs.appendFileSync(ATTEMPTS_FILE, JSON.stringify(rec) + '\n', { mode: 0o600 });
  attemptIds.add(id);
  return sendJson(req, res, 200, { ok: true, id });
}

function handleProgress(req, res) {
  return sendJson(req, res, 200, { attempts: readAttempts(), today: istToday(), days_to_exam: daysToExam() });
}

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
const PUBLIC_REAL = (() => {
  try {
    return fs.realpathSync(PUBLIC_DIR);
  } catch {
    return PUBLIC_DIR;
  }
})();

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res._vpOk = false;
    return sendBody(req, res, 405, 'text/plain; charset=utf-8', 'Method not allowed', { Allow: 'GET, HEAD' });
  }
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return notFound(req, res);
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0') || rel.includes('\\')) return notFound(req, res);
  const segs = rel.split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return notFound(req, res);
  const file = path.resolve(PUBLIC_DIR, ...segs);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(req, res);
  let real, st;
  try {
    real = fs.realpathSync(file);
    st = fs.statSync(real);
  } catch {
    return notFound(req, res);
  }
  if (!real.startsWith(PUBLIC_REAL + path.sep) || !st.isFile()) return notFound(req, res); // no listings, no symlink escapes
  const type = MIME[path.extname(real).toLowerCase()] || 'application/octet-stream';
  const etag = `"s-${Math.round(st.mtimeMs)}-${st.size}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  return sendBody(req, res, 200, type, fs.readFileSync(real), { ETag: etag, 'Cache-Control': 'no-cache' });
}

// ---------------------------------------------------------------- router

async function route(req, res, pathname) {
  if (req.headers.origin === PAGES_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', PAGES_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  if (pathname.startsWith('/api/')) {
    const method = req.method;
    if (pathname === '/api/health') return method === 'GET' ? handleHealth(req, res) : methodNotAllowed(req, res, 'GET');
    if (pathname === '/api/login') return method === 'POST' ? handleLogin(req, res) : methodNotAllowed(req, res, 'POST');
    const sess = getSession(req);
    if (pathname === '/api/logout') return method === 'POST' ? handleLogout(req, res, sess) : methodNotAllowed(req, res, 'POST');
    if (!sess) return sendJson(req, res, 401, { error: 'unauthorized' });
    maybeRenew(req, res, sess);
    switch (pathname) {
      case '/api/session':
        return method === 'GET' ? sendJson(req, res, 200, { ok: true, expires: sess.s.expires }) : methodNotAllowed(req, res, 'GET');
      case '/api/units':
        return method === 'GET' ? handleUnits(req, res) : methodNotAllowed(req, res, 'GET');
      case '/api/ask-result':
        return method === 'GET' ? handleAskResult(req, res, new URL(req.url, 'http://x')) : methodNotAllowed(req, res, 'GET');
      case '/api/ask-cancel':
        return method === 'POST' ? handleAskCancel(req, res) : methodNotAllowed(req, res, 'POST');
      case '/api/ask':
        return method === 'POST' ? handleAsk(req, res) : methodNotAllowed(req, res, 'POST');
      case '/api/generate':
        return method === 'POST' ? handleGenerate(req, res) : methodNotAllowed(req, res, 'POST');
      case '/api/attempt':
        return method === 'POST' ? handleAttempt(req, res) : methodNotAllowed(req, res, 'POST');
      case '/api/progress':
        return method === 'GET' ? handleProgress(req, res) : methodNotAllowed(req, res, 'GET');
      default:
        return sendJson(req, res, 404, { error: 'not_found' });
    }
  }
  if (pathname === '/data' || pathname.startsWith('/data/')) {
    if (!getSession(req)) return sendJson(req, res, 401, { error: 'unauthorized' });
    return handleData(req, res, pathname);
  }
  return serveStatic(req, res, pathname);
}

function methodNotAllowed(req, res, allow) {
  return sendJson(req, res, 405, { error: 'method_not_allowed' }, { Allow: allow });
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    pathname = '/';
  }
  res._vpOk = true;
  let logged = false;
  const done = () => {
    if (logged) return;
    logged = true;
    logRequest(req.method, pathname, res.statusCode, Date.now() - t0, res._vpOk && res.statusCode < 400, res._vpNote || '');
  };
  res.on('finish', done);
  res.on('close', done);
  setSecurityHeaders(res);
  Promise.resolve()
    .then(() => route(req, res, pathname))
    .catch((e) => {
      res._vpOk = false;
      if (e instanceof HttpError) {
        if (!res.headersSent) {
          const extra = e.status === 413 ? { Connection: 'close' } : {};
          sendJson(req, res, e.status, { error: e.code, ...e.extra }, extra);
          if (e.status === 413) res.on('finish', () => req.destroy());
        } else res.end();
        return;
      }
      console.error('[server] error:', e && e.stack ? e.stack : e);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'server_error' });
      else res.end();
    });
});
server.headersTimeout = 30000;
server.requestTimeout = 120000; // time to receive a request; responses (SSE) may run longer
server.keepAliveTimeout = 65000;

// ---------------------------------------------------------------- start / stop

function start() {
  if (!PASSCODE || PASSCODE.length < 4) {
    console.error('STUDY_PASSCODE is missing or too short. Put it in platform/.env (see .env.example).');
    process.exit(1);
  }
  for (const f of ['tutor.md', 'generate.md']) {
    if (!fs.existsSync(path.join(PROMPTS_DIR, f))) {
      console.error(`Missing prompts/${f}`);
      process.exit(1);
    }
  }
  loadSessions();
  for (const a of readAttempts()) if (a && typeof a.id === 'string') attemptIds.add(a.id);
  runBuildKb('startup');
  kbCheckedAt = Date.now();
  checkClaude();
  server.listen(PORT, HOST, () => {
    console.log(`VP Prep server on http://${HOST}:${PORT}  (data: ${DATA_DIR}, kb: ${KB_DIR}, units: ${availableUnitIds().join(', ') || 'none yet'})`);
  });
}

function shutdown(sig) {
  console.log(`\n[server] ${sig}: stopping`);
  for (const c of activeChildren) killTree(c);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveSessionsNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
server.on('error', (e) => {
  console.error(`[server] ${e.code === 'EADDRINUSE' ? `port ${PORT} is already in use (is the server already running?)` : e.message}`);
  process.exit(1);
});

start();
