#!/usr/bin/env node
// Builds platform/kb/, the only folder the Claude CLI may read.
//   kb/units/<id>.md     one file per unit JSON in data/ (plus UNIT_FIXTURE files when set)
//   kb/research/*.md     copies of ../research/*.md
//   kb/library/          left alone (owner fills it); a README is created if missing
//   kb/INDEX.md          what is where
// Re-runnable: kb/units and kb/research are rewritten each run. Files are copied, never
// symlinked (the CLI sandbox refuses to follow symlinks out of kb/).
// Usage: node scripts/build-kb.mjs        (env: DATA_DIR, UNIT_FIXTURE, RESEARCH_DIR, KB_DIR)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const UNIT_IDS = ['ca', 'gk', 'lang', 'reason', 'policy', 'law', 'eval', 'pedagogy', 'mgmt', 'office', 'service', 'digital'];
export const UNIT_TITLES = {
  ca: 'Current Affairs (Oct 2025 - Oct 2026)',
  gk: 'Static GK & Social/Economic/Cultural Issues',
  lang: 'Hindi & English Language Skills',
  reason: 'Reasoning & Quantitative Aptitude',
  policy: 'Education Policies & Schemes',
  law: 'RTE, Child Rights & Child Protection',
  eval: 'Educational Measurement & Evaluation',
  pedagogy: 'Pedagogy & Educational Psychology',
  mgmt: 'School Management & Financial Administration',
  office: 'Office Procedure & RTI',
  service: 'CCS Service Rules (Leave, LTC, Conduct, CCA)',
  digital: 'Digital Literacy',
};

export function paths(env = process.env) {
  return {
    dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
    fixtures: (env.UNIT_FIXTURE || '').split(',').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(ROOT, p)),
    researchDir: path.resolve(env.RESEARCH_DIR || path.join(ROOT, '..', 'research')),
    kbDir: path.resolve(env.KB_DIR || path.join(ROOT, 'kb')),
  };
}

const ID_RE = /^[a-z0-9_-]{1,40}$/;

// Returns { units: Map(id -> {unit, file, mtimeMs, size}), errors: [msg] }.
// Unit files in data/ are written by other agents while we run, so a file that does not
// parse (yet) is skipped with a note instead of failing the whole build.
export function loadUnitFiles(env = process.env) {
  const { dataDir, fixtures } = paths(env);
  const units = new Map();
  const errors = [];
  const files = [];
  try {
    for (const name of fs.readdirSync(dataDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      files.push({ id, file: path.join(dataDir, name) });
    }
  } catch (e) {
    if (e.code !== 'ENOENT') errors.push(`data dir: ${e.message}`);
  }
  for (const f of fixtures) files.push({ id: null, file: f });
  for (const { id, file } of files) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      const unit = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!unit || typeof unit !== 'object' || Array.isArray(unit)) throw new Error('not an object');
      const uid = id || unit.id;
      if (!ID_RE.test(String(uid || ''))) throw new Error('missing/invalid id');
      if (id && unit.id && unit.id !== id) errors.push(`${path.basename(file)}: id field "${unit.id}" differs from file name; using "${id}"`);
      unit.id = uid;
      if (!Array.isArray(unit.mcqs)) unit.mcqs = [];
      if (!Array.isArray(unit.quick_facts)) unit.quick_facts = [];
      if (!Array.isArray(unit.keywords)) unit.keywords = [];
      if (typeof unit.notes_md !== 'string') unit.notes_md = '';
      units.set(uid, { unit, file, mtimeMs: st.mtimeMs, size: st.size }); // fixtures (loaded last) win
    } catch (e) {
      errors.push(`${path.basename(file)}: skipped (${e.message})`);
    }
  }
  return { units, errors };
}

const LETTERS = ['A', 'B', 'C', 'D'];
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const oneLine = (s) => str(s).replace(/\s*\n\s*/g, ' / ').trim();

export function unitToMarkdown(unit) {
  const out = [];
  const title = str(unit.title_en) || UNIT_TITLES[unit.id] || unit.id;
  out.push(`# ${title}${unit.title_hi ? ` (${str(unit.title_hi)})` : ''}`);
  out.push('');
  out.push(`- Unit id: \`${unit.id}\``);
  if (unit.official_topic) out.push(`- Official syllabus topic: ${str(unit.official_topic)}`);
  if (unit.keywords.length) out.push(`- Keywords: ${unit.keywords.map(str).join(', ')}`);
  out.push(`- Question bank: ${unit.mcqs.length} MCQs (at the end of this file)`);
  out.push('');
  if (unit.quick_facts.length) {
    out.push('## Quick facts (last-minute revision)');
    out.push('');
    for (const f of unit.quick_facts) out.push(`- ${oneLine(f)}`);
    out.push('');
  }
  out.push('## Notes');
  out.push('');
  // Demote the notes' own headings one level so this file keeps a single structure.
  out.push(str(unit.notes_md).replace(/^(#{1,5}) /gm, '#$1 ').trim());
  out.push('');
  out.push(`## Question bank (${unit.mcqs.length} MCQs, with keys)`);
  out.push('');
  unit.mcqs.forEach((q, i) => {
    if (!q || typeof q !== 'object') return;
    const id = str(q.id) || `${unit.id}-${String(i + 1).padStart(3, '0')}`;
    const meta = [q.topic, q.difficulty, q.type].map(str).filter(Boolean).join(' · ');
    out.push(`### ${id}${meta ? ` · ${meta}` : ''}`);
    out.push('');
    out.push(`**Q:** ${str(q.q_en).trim().replace(/\n/g, '  \n')}`);
    out.push('');
    const opts = Array.isArray(q.options_en) ? q.options_en : [];
    opts.forEach((o, j) => out.push(`- (${LETTERS[j] || j + 1}) ${oneLine(o)}`));
    const ans = Number.isInteger(q.answer) ? q.answer : -1;
    out.push('');
    out.push(`**Answer:** (${LETTERS[ans] || '?'}) ${oneLine(opts[ans])}`);
    if (q.explain_en) out.push(`**Why:** ${oneLine(q.explain_en)}`);
    if (q.source) out.push(`**Source:** ${oneLine(q.source)}`);
    if (q.q_hi) {
      const ohi = Array.isArray(q.options_hi) ? q.options_hi : [];
      out.push(`**हिंदी:** ${oneLine(q.q_hi)} — उत्तर: (${LETTERS[ans] || '?'}) ${oneLine(ohi[ans])}`);
      if (q.explain_hi) out.push(`**व्याख्या:** ${oneLine(q.explain_hi)}`);
    }
    out.push('');
  });
  return out.join('\n') + '\n';
}

function firstHeading(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8').slice(0, 4000);
    const m = txt.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function listFilesRecursive(dir, base = dir, acc = [], limit = 400) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= limit) break;
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFilesRecursive(p, base, acc, limit);
    else if (e.isFile()) acc.push(path.relative(base, p));
  }
  return acc;
}

// Write via a temp file + rename so a CLI reading kb/ mid-build never sees a half-written file.
function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Remove .md files we did not (re)write in this run.
function pruneMarkdown(dir, keep) {
  for (const name of fs.readdirSync(dir)) {
    if ((name.endsWith('.md') && !keep.has(name)) || name.includes('.tmp-')) fs.rmSync(path.join(dir, name), { force: true });
  }
}

const LIBRARY_README = `# Library (owner-filled)

Put plain-text (.txt) or Markdown (.md) files here, extracted from:

- official documents (UPSC advertisement, DoPT OMs, CCS rules, NEP 2020, NCF-SE 2023, RTE Act, DoE Delhi circulars),
- previous-year papers (UPSC Principal / Vice Principal tests, EPFO, other UPSC recruitment tests),
- newspapers and monthly current-affairs compilations (Oct 2025 - Aug 2026).

Suggested sub-folders: \`official/\`, \`pyq/\`, \`newspapers/\`. One topic or document per file, with the
document title and date on the first line, makes searching easier.

Copy the files in. Do not use symlinks: the tutor's sandbox refuses to follow links that point outside kb/.
Run \`node scripts/build-kb.mjs\` (or restart the server) afterwards so INDEX.md lists them.
`;

export function buildKb(env = process.env, log = console.log) {
  const t0 = Date.now();
  const { researchDir, kbDir, dataDir, fixtures } = paths(env);
  const unitsDir = path.join(kbDir, 'units');
  const resDir = path.join(kbDir, 'research');
  const libDir = path.join(kbDir, 'library');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.mkdirSync(unitsDir, { recursive: true });
  fs.mkdirSync(resDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  const libReadme = path.join(libDir, 'README.md');
  if (!fs.existsSync(libReadme)) fs.writeFileSync(libReadme, LIBRARY_README);

  const { units, errors } = loadUnitFiles(env);
  const unitRows = [];
  const ordered = [...units.keys()].sort((a, b) => {
    const ia = UNIT_IDS.indexOf(a), ib = UNIT_IDS.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  for (const id of ordered) {
    const { unit } = units.get(id);
    writeAtomic(path.join(unitsDir, `${id}.md`), unitToMarkdown(unit));
    const words = str(unit.notes_md).split(/\s+/).filter(Boolean).length;
    unitRows.push(`| \`${id}\` | ${str(unit.title_en) || UNIT_TITLES[id] || id} | \`units/${id}.md\` | ${unit.mcqs.length} | ${words} |`);
  }
  const missing = UNIT_IDS.filter((id) => !units.has(id));
  pruneMarkdown(unitsDir, new Set(ordered.map((id) => `${id}.md`)));

  const research = [];
  const keepRes = new Set();
  try {
    for (const name of fs.readdirSync(researchDir).sort()) {
      if (!name.endsWith('.md')) continue;
      const src = path.join(researchDir, name);
      if (!fs.statSync(src).isFile()) continue;
      writeAtomic(path.join(resDir, name), fs.readFileSync(src));
      keepRes.add(name);
      research.push(`| \`research/${name}\` | ${firstHeading(src).replace(/\|/g, '/') || '-'} |`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') errors.push(`research: ${e.message}`);
  }
  pruneMarkdown(resDir, keepRes);

  const lib = listFilesRecursive(libDir).filter((f) => f !== 'README.md');
  const idx = [
    '# Knowledge base index',
    '',
    `Built ${new Date().toISOString()} by scripts/build-kb.mjs. Exam: UPSC CRT for Vice Principal (GNCTD), 01 Nov 2026.`,
    '',
    '## Units (`units/`)',
    '',
    'Each unit file has: quick facts, high-yield notes (with "Common traps" and "Last-minute 15"), and the question bank with answer keys, explanations and sources.',
    '',
    '| id | Title | File | MCQs | Note words |',
    '|---|---|---|---|---|',
    ...(unitRows.length ? unitRows : ['| - | (no unit files yet) | - | - | - |']),
    '',
    missing.length ? `Not available yet: ${missing.map((id) => `\`${id}\` (${UNIT_TITLES[id]})`).join(', ')}.` : 'All 12 units are available.',
    '',
    '## Research files (`research/`)',
    '',
    'Background research with official source lists. Most useful: `00-exam-intel.md` (exam facts), `01-education-policy.md`, `03-service-rules-office.md`, `04-pedagogy-psychology.md`, `05-current-affairs.md` (Oct 2025 - Oct 2026), `06-syllabus-gaps.md`.',
    '',
    '| File | Title |',
    '|---|---|',
    ...(research.length ? research : ['| - | (none) |']),
    '',
    '## Library (`library/`)',
    '',
    'Text the owner extracted from official PDFs, previous-year papers and newspapers. Search it with Grep.',
    '',
    lib.length ? `${lib.length} file(s):` : 'Empty for now (see library/README.md).',
    ...lib.slice(0, 200).map((f) => `- \`library/${f}\``),
    lib.length > 200 ? `- ... and ${lib.length - 200} more` : '',
    '',
    '## Search tips',
    '',
    '- Grep both English and Hindi terms (e.g. "Earned Leave" and "अर्जित अवकाश").',
    '- Grep rule/section numbers in several forms ("Rule 43-C", "43C", "Section 12(1)(c)").',
    '- Current affairs: `research/05-current-affairs.md` and `units/ca.md`.',
    '',
  ].join('\n');
  writeAtomic(path.join(kbDir, 'INDEX.md'), idx);

  const ms = Date.now() - t0;
  log(`[build-kb] ${units.size} unit(s) [${ordered.join(', ') || 'none'}] from ${dataDir}${fixtures.length ? ` + fixture(s)` : ''}; ${research.length} research file(s); ${lib.length} library file(s); ${ms} ms`);
  for (const e of errors) log(`[build-kb] note: ${e}`);
  return { units: ordered, missing, research: research.length, library: lib.length, errors, ms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    buildKb();
  } catch (e) {
    console.error(`[build-kb] failed: ${e.stack || e.message}`);
    process.exit(1);
  }
}
