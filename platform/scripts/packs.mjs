#!/usr/bin/env node
// Prepares today's and tomorrow's study packs from data/roadmap.json:
// for each study task, the claude CLI writes a reading + 15 MCQs (Fable), a second
// pass fact-checks it (Opus), then the reading is printed to a phone-sized PDF.
// Output: data/packs/<date>-<idx>.json + .pdf and data/packs/index.json; then publishes to Pages.
// Usage: node scripts/packs.mjs [--days 2] [--only 2026-10-10-0]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data'), PACKS = path.join(DATA, 'packs'), KB = path.join(ROOT, 'kb'), STATE = path.join(ROOT, 'state');
const CLAUDE = process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude';
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'].find(p => fs.existsSync(p));
const AI_UNITS = new Set(['policy', 'law', 'pedagogy', 'eval', 'office', 'service', 'mgmt', 'gk', 'reason', 'lang', 'digital', 'ca']);
const args = process.argv.slice(2);
const DAYS = Number(args[args.indexOf('--days') + 1]) || 2;
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const log = (...a) => console.log(new Date().toISOString(), ...a);

fs.mkdirSync(PACKS, { recursive: true }); fs.mkdirSync(STATE, { recursive: true });
const LOCK = path.join(STATE, 'packs.lock');
try { const st = fs.statSync(LOCK); if (Date.now() - st.mtimeMs < 3 * 3600e3) { log('another run is active; exiting'); process.exit(0); } } catch {}
fs.writeFileSync(LOCK, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch {} });

const istDay = (t = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(t);
const addDays = (d, n) => istDay(new Date(new Date(d + 'T12:00:00+05:30').getTime() + n * 86400e3));

const MCQ = { type: 'object', properties: { id: { type: 'string' }, topic: { type: 'string' }, difficulty: { type: 'string' }, type: { type: 'string' }, mono: { type: 'boolean' }, q_en: { type: 'string' }, q_hi: { type: 'string' }, options_en: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 }, options_hi: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 }, answer: { type: 'integer', minimum: 0, maximum: 3 }, explain_en: { type: 'string' }, explain_hi: { type: 'string' }, source: { type: 'string' } }, required: ['q_en', 'options_en', 'answer', 'explain_en', 'source'] };
const PACK = { type: 'object', properties: { title_en: { type: 'string' }, title_hi: { type: 'string' }, reading_md: { type: 'string' }, quick_facts: { type: 'array', items: { type: 'string' } }, mcqs: { type: 'array', items: MCQ, minItems: 12, maxItems: 15 }, changes: { type: 'array', items: { type: 'string' } } }, required: ['title_en', 'reading_md', 'quick_facts', 'mcqs'] };

function runClaude({ model, fallback, promptFile, input, schema = PACK }) {
  return new Promise((resolve, reject) => {
    const argv = ['-p', '--model', model, '--fallback-model', fallback, '--effort', 'high', '--output-format', 'json', '--no-session-persistence',
      '--restricted', '--safe-mode', '--tools', 'Read,Grep,Glob,WebSearch', '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,WebFetch',
      '--permission-mode', 'dontAsk', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
      '--append-system-prompt-file', path.join(ROOT, 'prompts', promptFile), '--json-schema', JSON.stringify(schema)];
    const env = { ...process.env }; delete env.STUDY_PASSCODE; delete env.CLAUDECODE;
    const child = spawn(CLAUDE, argv, { cwd: KB, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('timeout')); }, 20 * 60e3);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      clearTimeout(timer);
      try { const j = JSON.parse(out); if (j.structured_output) return resolve(j.structured_output); reject(new Error('no structured output: ' + String(j.result || '').slice(0, 200))); }
      catch { reject(new Error(`claude exited ${code}: ${err.slice(0, 300) || out.slice(0, 300)}`)); }
    });
    child.stdin.end(input);
  });
}

function validMcqs(list, key) {
  return (list || []).filter(q => q && q.q_en && Array.isArray(q.options_en) && q.options_en.length === 4 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3)
    .map((q, i) => ({ ...q, id: `pk-${key}-${String(i + 1).padStart(2, '0')}` }));
}

// --- tiny Markdown → HTML (headings, lists, tables, bold/italic/code, paragraphs) ---
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/`([^`]+)`/g, '<code>$1</code>');
const englishOnly = t => String(t || '').replace(/\s*[（(][^()（）]*[\u0900-\u097F][^()（）]*[)）]/g, '');
function md2html(md) {
  const lines = englishOnly(md).replace(/\r/g, '').split('\n'); const out = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { const n = Math.min(4, m[1].length + 1); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*\|/.test(l) && lines[i + 1] && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = row(l); i += 2; const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(row(lines[i++]));
      out.push('<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' + body.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>'); continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>` + items.map(x => `<li>${inline(x)}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (/^>\s?/.test(l)) { const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`); continue; }
    const p = []; while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*([-*]|\d+\.)\s|>)/.test(lines[i])) p.push(lines[i++]);
    out.push(`<p>${inline(p.join(' '))}</p>`);
  }
  return out.join('\n');
}

function renderPdf(pack, meta, file) {
  if (!CHROME) { log('no Chrome/Brave found; skipping PDF'); return false; }
  const dateTxt = new Date(meta.date + 'T12:00:00+05:30').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(pack.title_en)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Noto+Sans:wght@400;600&family=Noto+Sans+Devanagari:wght@400;600&display=swap" rel="stylesheet">
<style>
@page{size:120mm 213mm;margin:12mm 10mm 14mm}
body{font:10.5pt/1.6 "Noto Sans","Noto Sans Devanagari",sans-serif;color:#16181d}
.kicker{font:600 7.5pt "Inter Tight",sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#6b7280}
h1{font:700 19pt/1.2 "Inter Tight",sans-serif;margin:4pt 0 2pt;letter-spacing:-.01em}
.hi{color:#6b7280;margin:0 0 10pt}
h2{font:600 13pt/1.3 "Inter Tight",sans-serif;margin:16pt 0 5pt;padding-top:8pt;border-top:1px solid #e5e7eb;break-after:avoid}
h3,h4{font:600 11pt "Inter Tight",sans-serif;margin:11pt 0 3pt;break-after:avoid}
p{margin:0 0 6pt} ul,ol{margin:0 0 7pt;padding-left:14pt} li{margin:0 0 2pt}
strong{font-weight:600;color:#000}
table{border-collapse:collapse;width:100%;margin:5pt 0 9pt;font-size:9pt;break-inside:avoid}
th,td{border-bottom:1px solid #e5e7eb;padding:3pt 4pt;text-align:left;vertical-align:top} th{font-weight:600;background:#f4f5f7}
blockquote{margin:6pt 0;padding:5pt 8pt;background:#f4f5f7;border-radius:4pt}
.facts{margin-top:14pt;padding:8pt 10pt;background:#f4f5f7;border-radius:6pt} .facts h2{border:0;margin-top:0;padding-top:0}
code{font-size:9pt}
</style></head><body>
<div class="kicker">VP Prep · ${esc(dateTxt)} · ${esc(meta.label)}</div>
<h1>${esc(pack.title_en)}</h1>${pack.title_hi ? `<p class="hi">${esc(pack.title_hi)}</p>` : ''}
${md2html(pack.reading_md)}
${pack.quick_facts && pack.quick_facts.length ? `<div class="facts"><h2>Quick facts</h2><ul>${pack.quick_facts.map(f => `<li>${inline(f)}</li>`).join('')}</ul></div>` : ''}
</body></html>`;
  const tmp = path.join(STATE, 'pdf-tmp.html'); fs.writeFileSync(tmp, html);
  try { fs.unlinkSync(file); } catch {}
  try { execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', `--user-data-dir=${path.join(STATE, 'chrome-pdf')}`, '--no-pdf-header-footer', '--virtual-time-budget=8000', `--print-to-pdf=${file}`, 'file://' + tmp], { timeout: 45e3, stdio: 'ignore', killSignal: 'SIGKILL' }); }
  catch (e) { if (!(fs.existsSync(file) && fs.statSync(file).size > 1000)) throw e; } // Chrome sometimes lingers after writing the PDF
  return fs.existsSync(file);
}

function writeIndex() {
  const packs = {};
  for (const f of fs.readdirSync(PACKS).filter(f => /^\d{4}-\d\d-\d\d-\d+\.json$/.test(f))) {
    const p = JSON.parse(fs.readFileSync(path.join(PACKS, f), 'utf8')); const key = f.replace('.json', '');
    packs[key] = { date: p.date, idx: p.idx, unit: p.unit, label: p.label, title: p.title_en, pdf: fs.existsSync(path.join(PACKS, key + '.pdf')) ? `data/packs/${key}.pdf` : null, mcq_count: (p.mcqs || []).length, verified: !!p.verified };
  }
  fs.writeFileSync(path.join(PACKS, 'index.json'), JSON.stringify({ updated: new Date().toISOString(), packs }));
}
function publish() {
  try { execFileSync(path.join(ROOT, 'scripts', 'publish-pages.sh'), [], { stdio: 'inherit', timeout: 120e3 }); } catch (e) { log('publish failed:', e.message); }
}

async function makePack(day, item, idx) {
  const key = `${day.date}-${idx}`, jf = path.join(PACKS, key + '.json'), pf = path.join(PACKS, key + '.pdf');
  if (ONLY && ONLY !== key) return false;
  if (fs.existsSync(jf) && fs.existsSync(pf) && !ONLY) return false;
  const meta = { date: day.date, idx, unit: item.unit, label: item.label };
  let pack;
  if (item.unit === 'plan') {
    const plan = JSON.parse(fs.readFileSync(path.join(DATA, 'plan.json'), 'utf8'));
    pack = { title_en: plan.title_en, title_hi: plan.title_hi, reading_md: plan.notes_md, quick_facts: plan.quick_facts, mcqs: [], verified: true };
  } else if (AI_UNITS.has(item.unit)) {
    const brief = `Today's task (${day.date}): "${item.label}" — syllabus unit id "${item.unit}".\nWrite the study pack for exactly this task. Look at units/${item.unit}.md first if it exists.`;
    log('writing', key, item.label);
    const draft = await runClaude({ model: 'claude-fable-5-1', fallback: 'claude-opus-5-5', promptFile: 'pack.md', input: brief });
    log('checking', key);
    let checked = draft;
    try { checked = await runClaude({ model: 'claude-opus-5-5', fallback: 'claude-fable-5-1', promptFile: 'pack-verify.md', input: `Task: "${item.label}" (unit ${item.unit}).\n\nPACK JSON:\n` + JSON.stringify(draft) }); }
    catch (e) { log('verify failed, keeping draft unverified:', e.message); checked = { ...draft, unverified: true }; }
    pack = { ...checked, mcqs: validMcqs(checked.mcqs, key).map(q => ({ ...q, unit: item.unit })), verified: !checked.unverified };
  } else return false;
  pack = { ...meta, ...pack, created: new Date().toISOString() };
  fs.writeFileSync(jf, JSON.stringify(pack));
  try { renderPdf(pack, meta, pf); } catch (e) { log('pdf failed:', e.message); }
  log('done', key, `${pack.mcqs.length} MCQs`, pack.changes ? `${pack.changes.length} fixes` : '');
  return true;
}

// --figures: add diagrams to packs written before diagrams existed
if (args.includes('--figures')) {
  const FIG = { type: 'object', properties: { reading_md: { type: 'string' } }, required: ['reading_md'] };
  const files = fs.readdirSync(PACKS).filter(f => /^\d{4}-\d\d-\d\d-\d+\.json$/.test(f));
  const todo = files.map(f => [f, JSON.parse(fs.readFileSync(path.join(PACKS, f), 'utf8'))]).filter(([, p]) => p.mcqs?.length && !/```mermaid/.test(p.reading_md || ''));
  const q = [...todo];
  await Promise.all([0, 1, 2].map(async () => { while (q.length) { const [f, p] = q.shift();
    try { log('figures', f); const r = await runClaude({ model: 'claude-fable-5-1', fallback: 'claude-opus-5-5', promptFile: 'figures.md', input: p.reading_md, schema: FIG });
      if (r.reading_md && r.reading_md.length > p.reading_md.length * 0.9) { p.reading_md = r.reading_md; fs.writeFileSync(path.join(PACKS, f), JSON.stringify(p)); try { renderPdf(p, p, path.join(PACKS, f.replace('.json', '.pdf'))); } catch {} log('figures done', f); } }
    catch (e) { log('figures failed', f, e.message); } } }));
  writeIndex(); publish(); process.exit(0);
}
const roadmap = JSON.parse(fs.readFileSync(path.join(DATA, 'roadmap.json'), 'utf8'));
const today = istDay(), dates = Array.from({ length: DAYS }, (_, i) => addDays(today, i));
const jobs = roadmap.days.filter(d => dates.includes(d.date) || (ONLY && ONLY.startsWith(d.date))).flatMap(d => d.items.map((it, i) => () => makePack(d, it, i)));
let made = 0;
// three packs at a time
const queue = [...jobs];
await Promise.all([0, 1, 2].map(async () => { while (queue.length) { const job = queue.shift(); try { if (await job()) { made++; writeIndex(); publish(); } } catch (e) { log('pack failed:', e.message); } } }));
writeIndex();
log(`finished: ${made} new pack(s) for ${dates.join(', ')}`);
