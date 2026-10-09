'use strict';
(() => {
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k === 'style') n.style.cssText = v; else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : String(c));
  return n;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('vp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('vp.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('vp.' + k); } catch {} },
};
const LETTERS = ['A', 'B', 'C', 'D'];
const EXAM = new Date('2026-11-01T09:30:00+05:30');
const state = { lang: store.get('lang', 'en'), model: store.get('model', 'fable'), units: [], data: {}, view: 'ask', ctx: null, history: store.get('qhist', {}) };

function md(s) {
  const raw = window.marked ? window.marked.parse(String(s || ''), { breaks: true }) : String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return window.DOMPurify ? window.DOMPurify.sanitize(raw) : raw.replace(/<[^>]*>/g, '');
}
function toast(t) { const n = $('#toast'); n.textContent = t; n.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { n.hidden = true; }, 3500); }

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  if (r.status === 401) { showLogin(); throw new Error('Please enter the passcode again.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || ('Server error ' + r.status));
  return j;
}
function showLogin() { $('#login').hidden = false; setTimeout(() => $('#pass').focus(), 50); }
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault(); const err = $('#login-err'); err.textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: $('#pass').value.trim() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = j.error === 'too_many_attempts' ? `Too many tries. Wait ${Math.ceil((j.retry_after_s || 900) / 60)} min.` : 'Wrong passcode.'; return; }
    $('#login').hidden = true; $('#pass').value = ''; boot();
  } catch { err.textContent = 'Cannot reach the laptop. Is the server running?'; }
});

/* ---------- data ---------- */
async function loadUnits() {
  const j = await api('/api/units');
  state.units = j.units.filter(u => u.available);
  await Promise.all(state.units.map(async u => { try { state.data[u.id] = await api('/data/' + u.id + '.json'); } catch {} }));
}
const T = (u) => state.lang === 'hi' ? (u.title_hi || u.title_en) : u.title_en;
const allQs = () => state.units.flatMap(u => (state.data[u.id]?.mcqs || []).map(q => ({ ...q, unit: u.id })));

/* ---------- header ---------- */
function countdown() { const d = Math.max(0, Math.ceil((EXAM - new Date()) / 86400000)); $('#cd-num').textContent = d; }
function setLang(l) {
  state.lang = l; store.set('lang', l);
  document.querySelectorAll('.lang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === l)));
  render();
}
document.querySelectorAll('.lang button').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));
$('#btn-settings').addEventListener('click', () => {
  const body = $('#sheet-body'); body.replaceChildren();
  $('#sheet-title').textContent = 'Settings';
  const seg = el('div', { class: 'seg' });
  for (const [k, label] of [['fable', 'Fable 5.1 (best)'], ['opus', 'Opus 5.5']]) seg.append(el('button', { 'aria-pressed': String(state.model === k), onclick: () => { state.model = k; store.set('model', k); $('#btn-settings').click(); } }, label));
  body.append(el('p', { class: 'muted', text: 'Model used for answers and fresh questions:' }), seg,
    el('p', { class: 'muted', text: 'Answers come from Claude on the laptop. It searches the study notes before answering.' }),
    el('button', { class: 'btn', onclick: async () => { await fetch('/api/logout', { method: 'POST' }).catch(() => {}); closeSheet(); showLogin(); } }, 'Log out'));
  openSheet();
});
function openSheet() { $('#sheet').hidden = false; $('#sheet-backdrop').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; }
$('#sheet-close').addEventListener('click', closeSheet); $('#sheet-backdrop').addEventListener('click', closeSheet);

/* ---------- tabs ---------- */
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
function go(v) {
  state.view = v;
  document.querySelectorAll('.tabbar button').forEach(b => { if (b.dataset.tab === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  document.querySelectorAll('.view').forEach(s => { s.hidden = s.dataset.view !== v; });
  $('#composer').hidden = v !== 'ask';
  render(); window.scrollTo(0, 0);
}
function render() {
  if (state.view === 'ask') renderChat();
  if (state.view === 'practice') renderPractice();
  if (state.view === 'mock') renderMock();
  if (state.view === 'notes') renderNotes();
  if (state.view === 'progress') renderProgress();
}

/* ---------- question card ---------- */
function qText(q) {
  const en = q.q_en ?? q.q, hi = q.q_hi;
  if (q.mono || !hi || state.lang === 'en') return [el('div', { class: 'q-stem', text: en })];
  if (state.lang === 'hi') return [el('div', { class: 'q-stem', lang: 'hi', text: hi })];
  return [el('div', { class: 'q-stem', text: en }), el('div', { class: 'q-hi', lang: 'hi', text: hi })];
}
function optText(q, i) {
  const en = (q.options_en || q.options || [])[i], hi = (q.options_hi || [])[i];
  if (q.mono || !hi || state.lang === 'en') return en; if (state.lang === 'hi') return hi; return en + ' / ' + hi;
}
function explainText(q) {
  const en = q.explain_en ?? q.explain ?? '', hi = q.explain_hi;
  const t = (q.mono || !hi || state.lang === 'en') ? en : state.lang === 'hi' ? hi : en + '\n\n' + hi;
  return t + (q.source ? '\n\nSource: ' + q.source : '');
}
/* mode: 'instant' (reveal on tap) or 'exam' (just select). onPick(i) */
function qCard(q, { mode = 'instant', chosen = null, reveal = false, onPick, num } = {}) {
  const box = el('div', { class: 'q card' });
  if (num) box.append(el('div', { class: 'muted mono', text: num }));
  box.append(...qText(q));
  const opts = el('div', { class: 'opts' });
  const draw = (pick, show) => {
    opts.replaceChildren();
    (q.options_en || q.options || []).forEach((_, i) => {
      let cls = 'opt';
      if (show) { if (i === q.answer) cls += ' right'; else if (i === pick) cls += ' wrong'; }
      else if (i === pick) cls += ' sel';
      opts.append(el('button', { class: cls, type: 'button', 'aria-pressed': String(i === pick), onclick: () => {
        if (mode === 'instant' && show) return;
        if (mode === 'instant') { draw(i, true); exp.hidden = false; } else draw(i === pick ? null : i, false);
        onPick && onPick(mode === 'exam' && i === pick ? null : i);
      } }, el('span', { class: 'bub', text: LETTERS[i] }), el('span', { class: 'opt-txt', text: optText(q, i) })));
    });
  };
  const exp = el('div', { class: 'explain', hidden: !reveal });
  exp.innerHTML = md(explainText(q));
  draw(chosen, reveal);
  box.append(opts, exp);
  return box;
}
function record(q, ok) { if (!q.id) return; state.history[q.id] = ok ? 1 : 0; store.set('qhist', state.history); }

/* ---------- Ask ---------- */
let chat = store.get('chat', []), ctl = null;
const SUGGEST = ['Give me a 25-question mock', '10 MCQs on CCS Leave Rules', 'Explain RTE Section 12(1)(c)', 'NEP 2020 में 5+3+3+4 क्या है?', 'Difference between noting and drafting', 'Current affairs quiz: July 2026'];
function parseBlocks(text) {
  const parts = []; const re = /```(mcq|action)\s*\n([\s\S]*?)```/g; let last = 0, m;
  while ((m = re.exec(text))) {
    parts.push({ md: text.slice(last, m.index) });
    try { parts.push({ [m[1]]: JSON.parse(m[2]) }); } catch { parts.push({ md: m[0] }); }
    last = re.lastIndex;
  }
  let rest = text.slice(last); const open = rest.search(/```(mcq|action)/);
  if (open >= 0) { parts.push({ md: rest.slice(0, open) }, { pending: true }); } else parts.push({ md: rest });
  return parts;
}
function botBody(text) {
  const frag = el('div');
  for (const p of parseBlocks(text)) {
    if (p.md && p.md.trim()) { const d = el('div'); d.innerHTML = md(p.md); frag.append(d); }
    if (p.pending) frag.append(el('p', { class: 'status', text: 'Preparing questions…' }));
    if (Array.isArray(p.mcq)) p.mcq.forEach((q, i) => frag.append(qCard({ ...q, answer: Number(q.answer) }, { num: 'Q' + (i + 1) })));
    if (p.action && p.action.type === 'start_mock') frag.append(el('button', { class: 'btn btn-primary', onclick: () => { mockCfg = { ...mockCfg, count: [25, 50, 100].includes(+p.action.count) ? +p.action.count : 25, source: ['bank', 'fresh', 'mix'].includes(p.action.source) ? p.action.source : 'bank', units: Array.isArray(p.action.units) && !p.action.units.includes('all') ? p.action.units : [] }; go('mock'); startMock(); } }, `Start mock (${p.action.count || 25} questions)`));
  }
  return frag;
}
function renderChat() {
  const box = $('#chat'); box.replaceChildren();
  if (!chat.length) {
    box.append(el('div', { class: 'card' }, el('p', { text: 'Ask anything from the syllabus. Ask for MCQs, a mock test, an explanation or a revision table.' }),
      el('div', { class: 'chips' }, SUGGEST.map(s => el('button', { class: 'chip', onclick: () => send(s) }, s)))));
  }
  for (const m of chat) {
    if (m.role === 'user') box.append(el('div', { class: 'msg user', text: m.content }));
    else { const b = el('div', { class: 'msg bot' }, botBody(m.content)); if (m.meta) b.append(el('div', { class: 'meta', text: m.meta })); box.append(b); }
  }
  $('#ctx-chip').hidden = !state.ctx; if (state.ctx) $('#ctx-label').textContent = 'About: ' + state.ctx.label;
}
$('#ctx-x').addEventListener('click', () => { state.ctx = null; renderChat(); });
$('#ask-form').addEventListener('submit', e => { e.preventDefault(); const v = $('#ask-input').value.trim(); if (v) send(v); });
$('#ask-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#ask-form').requestSubmit(); } });
$('#btn-stop').addEventListener('click', () => ctl && ctl.abort());
$('#btn-newchat').addEventListener('click', () => { $('#newchat-confirm').hidden = false; });
$('#newchat-no').addEventListener('click', () => { $('#newchat-confirm').hidden = true; });
$('#newchat-yes').addEventListener('click', () => { chat = []; store.set('chat', chat); state.ctx = null; $('#newchat-confirm').hidden = true; renderChat(); });

async function send(text) {
  if (ctl) return;
  $('#ask-input').value = '';
  chat.push({ role: 'user', content: text }); renderChat();
  const bubble = el('div', { class: 'msg bot' }, el('p', { class: 'status', text: 'Thinking…' }));
  $('#chat').append(bubble); bubble.scrollIntoView({ block: 'end' });
  ctl = new AbortController(); $('#btn-send').hidden = true; $('#btn-stop').hidden = false;
  let full = '', meta = '';
  try {
    const r = await fetch('/api/ask', { method: 'POST', credentials: 'same-origin', signal: ctl.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chat.slice(-12).map(({ role, content }) => ({ role, content })), lang: state.lang, model: state.model, context: state.ctx ? state.ctx.data : undefined }) });
    if (r.status === 401) { showLogin(); throw new Error('Session expired, enter the passcode again.'); }
    if (!r.ok || !r.body) throw new Error('The laptop server answered ' + r.status + '.');
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '', status = 'Thinking…';
    const paint = () => { bubble.replaceChildren(full ? botBody(full) : el('p', { class: 'status', text: status })); if (full && status) bubble.append(el('p', { class: 'status', text: status })); };
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = 'message', data = ''; for (const line of raw.split('\n')) { if (line.startsWith('event:')) ev = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); }
        let d = {}; try { d = JSON.parse(data || '{}'); } catch {}
        if (ev === 'delta') { full += d.t || ''; status = ''; }
        else if (ev === 'status') status = d.text || '';
        else if (ev === 'reset') full = '';
        else if (ev === 'done') { full = d.text || full; status = ''; meta = (d.model_label || d.model || '') + (d.ms ? ' · ' + Math.round(d.ms / 1000) + 's' : '') + (d.note ? ' · ' + d.note : ''); }
        else if (ev === 'error') throw new Error(d.message || d.error || 'Claude could not answer. Try again.');
        paint();
      }
    }
    if (!full) throw new Error('No answer came back. Try again.');
    chat.push({ role: 'assistant', content: full, meta });
  } catch (e) {
    if (e.name === 'AbortError') { if (full) chat.push({ role: 'assistant', content: full + '\n\n_(stopped)_' }); }
    else chat.push({ role: 'assistant', content: (full ? full + '\n\n' : '') + '⚠️ ' + e.message });
  } finally {
    ctl = null; $('#btn-send').hidden = false; $('#btn-stop').hidden = true;
    chat = chat.slice(-40); store.set('chat', chat); state.ctx = null; renderChat();
    const last = $('#chat').lastElementChild; last && last.scrollIntoView({ block: 'start' });
  }
}
function askAbout(label, data, prompt) { state.ctx = { label, data }; go('ask'); $('#ask-input').value = prompt || ''; $('#ask-input').focus(); }

/* ---------- Practice ---------- */
let prac = null;
function unitAcc(id) {
  const qs = state.data[id]?.mcqs || []; let d = 0, c = 0;
  for (const q of qs) if (q.id in state.history) { d++; c += state.history[q.id]; }
  return { done: d, acc: d ? Math.round(100 * c / d) : null, total: qs.length };
}
function renderPractice() {
  const v = $('#view-practice'); v.replaceChildren();
  if (!prac) {
    v.append(el('h1', { class: 'h-title', text: 'Practice by topic' }));
    if (!state.units.length) v.append(el('p', { class: 'muted', text: 'Question bank is still being written. Ask the tutor for questions meanwhile.' }));
    const list = el('div', { class: 'list' });
    for (const u of state.units) {
      const a = unitAcc(u.id);
      list.append(el('button', { class: 'card unit-card', onclick: () => { prac = { unit: u.id, filter: 'all', i: 0 }; renderPractice(); } },
        el('span', {}, el('b', { text: T(u) }), el('br'), el('small', { text: `${a.total} questions · ${a.done} done` + (a.acc != null ? ` · ${a.acc}% right` : '') })), el('span', { class: 'pill', text: 'Start' })));
    }
    v.append(list); return;
  }
  const u = state.units.find(x => x.id === prac.unit);
  let qs = (state.data[prac.unit]?.mcqs || []);
  if (prac.filter === 'unseen') qs = qs.filter(q => !(q.id in state.history));
  if (prac.filter === 'wrong') qs = qs.filter(q => state.history[q.id] === 0);
  const seg = el('div', { class: 'seg' }, [['all', 'All'], ['unseen', 'Unseen'], ['wrong', 'Got wrong']].map(([k, l]) => el('button', { 'aria-pressed': String(prac.filter === k), onclick: () => { prac.filter = k; prac.i = 0; renderPractice(); } }, l)));
  v.append(el('div', { class: 'view-head' }, el('button', { class: 'btn btn-quiet', onclick: () => { prac = null; renderPractice(); } }, '← Topics'), el('span', { class: 'muted', text: u ? T(u) : '' })), seg, el('div', { style: 'height:10px' }));
  if (!qs.length) { v.append(el('p', { class: 'muted', text: 'Nothing here. Try another filter.' })); return; }
  if (prac.i >= qs.length) prac.i = 0;
  const q = qs[prac.i];
  v.append(qCard(q, { num: `${prac.i + 1} / ${qs.length} · ${q.difficulty || ''}`, onPick: i => record(q, i === q.answer) }));
  v.append(el('div', { class: 'row', style: 'margin-top:10px' },
    el('button', { class: 'btn', onclick: () => askAbout('Practice question', { mcq: q, unit: prac.unit }, 'Explain this question and the concept behind it.') }, 'Ask Claude about this'),
    el('button', { class: 'btn btn-primary', onclick: () => { prac.i++; renderPractice(); window.scrollTo(0, 0); } }, 'Next →')));
}

/* ---------- Mock ---------- */
let mockCfg = store.get('mockCfg', { count: 25, source: 'bank', units: [], timer: true });
let mock = store.get('mockRun', null), tick = null;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function bankPick(n, units) {
  const ids = units.length ? units : state.units.map(u => u.id);
  const pools = ids.map(id => shuffle([...(state.data[id]?.mcqs || [])].map(q => ({ ...q, unit: id })))).filter(p => p.length);
  const out = []; let k = 0;
  while (out.length < n && pools.some(p => p.length)) { const p = pools[k++ % pools.length]; if (p.length) out.push(p.pop()); }
  return out;
}
function renderMock() {
  const v = $('#view-mock'); v.replaceChildren();
  if (mock && !mock.done) return renderMockRun(v);
  if (mock && mock.done) return renderResult(v);
  const seg = (key, opts) => el('div', { class: 'seg' }, opts.map(([k, l]) => el('button', { 'aria-pressed': String(mockCfg[key] === k), onclick: () => { mockCfg[key] = k; store.set('mockCfg', mockCfg); renderMock(); } }, l)));
  const unitSeg = el('div', { class: 'seg' }, el('button', { 'aria-pressed': String(!mockCfg.units.length), onclick: () => { mockCfg.units = []; renderMock(); } }, 'All topics'),
    state.units.map(u => el('button', { 'aria-pressed': String(mockCfg.units.includes(u.id)), onclick: () => { mockCfg.units = mockCfg.units.includes(u.id) ? mockCfg.units.filter(x => x !== u.id) : [...mockCfg.units, u.id]; renderMock(); } }, T(u))));
  const avail = allQs().length;
  v.append(el('h1', { class: 'h-title', text: 'Mock test' }),
    el('p', { class: 'muted', text: 'Marked like the CRT: 300 marks in total, each wrong answer loses one-third of that question\'s marks, blanks score zero.' }),
    el('div', { class: 'card list' },
      el('b', { text: 'Questions' }), seg('count', [[25, '25'], [50, '50'], [100, '100']]),
      el('b', { text: 'Source' }), seg('source', [['bank', 'Question bank (instant)'], ['fresh', 'Fresh from Claude'], ['mix', 'Mix']]),
      el('small', { class: 'muted', text: `Bank has ${avail} questions now. Fresh questions take about a minute per 10.` }),
      el('b', { text: 'Topics' }), unitSeg,
      el('b', { text: 'Timer' }), seg('timer', [[true, 'On'], [false, 'Off']]),
      el('button', { class: 'btn btn-primary btn-block', onclick: startMock }, 'Start')));
}
async function startMock() {
  const n = mockCfg.count, v = $('#view-mock');
  let qs = [];
  const freshN = mockCfg.source === 'fresh' ? n : mockCfg.source === 'mix' ? Math.round(n / 2) : 0;
  qs = bankPick(n - freshN, mockCfg.units);
  if (freshN) {
    v.replaceChildren(el('h1', { class: 'h-title', text: 'Writing fresh questions…' }));
    const bar = el('div', { class: 'bar' }, el('i', { style: 'width:0%' })), lab = el('p', { class: 'muted', text: '0 / ' + freshN }); v.append(bar, lab);
    const batches = []; for (let k = 0; k < freshN; k += 10) batches.push(Math.min(10, freshN - k));
    const units = mockCfg.units.length ? mockCfg.units : ['all']; let got = [], failed = 0, bi = 0;
    const worker = async () => { while (bi < batches.length) { const c = batches[bi++];
      try { const j = await api('/api/generate', { method: 'POST', body: JSON.stringify({ count: c, units, lang: state.lang, difficulty: 'mixed', avoid: qs.concat(got).slice(-40).map(q => (q.q_en || '').slice(0, 120)) }) }); got = got.concat((j.mcqs || []).map(q => ({ ...q, unit: q.unit || 'fresh' }))); }
      catch { failed += c; }
      bar.firstChild.style.width = Math.round(100 * (got.length + failed) / freshN) + '%'; lab.textContent = got.length + ' / ' + freshN; } };
    await Promise.all([worker(), worker()]);
    if (got.length < freshN) { const fill = bankPick(freshN - got.length + qs.length, mockCfg.units).filter(q => !qs.some(x => x.id === q.id)).slice(0, freshN - got.length); qs = qs.concat(fill); toast(`${freshN - got.length} fresh questions failed; used bank questions instead.`); }
    qs = qs.concat(got);
  }
  if (!qs.length) { toast('No questions available yet.'); renderMock(); return; }
  qs = shuffle(qs);
  mock = { qs, ans: Array(qs.length).fill(null), rev: [], cur: 0, start: Date.now(), limit: mockCfg.timer ? Math.round(qs.length * 72) : 0, done: false, id: 'm' + Date.now().toString(36) };
  store.set('mockRun', mock); renderMock();
}
function left() { return mock.limit ? Math.max(0, mock.limit - Math.floor((Date.now() - mock.start) / 1000)) : null; }
const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function renderMockRun(v) {
  const q = mock.qs[mock.cur], answered = mock.ans.filter(a => a != null).length;
  const timer = el('span', { class: 'timer', text: mock.limit ? fmt(left()) : fmt(Math.floor((Date.now() - mock.start) / 1000)) });
  clearInterval(tick); tick = setInterval(() => { if (!mock || mock.done) return clearInterval(tick); if (mock.limit && left() === 0) { finishMock(); return; } timer.textContent = mock.limit ? fmt(left()) : fmt(Math.floor((Date.now() - mock.start) / 1000)); }, 1000);
  const confirmBox = el('div', { class: 'confirm-inline', hidden: true }, el('span', { text: `Submit now? ${mock.qs.length - answered} unanswered.` }),
    el('button', { class: 'btn btn-quiet', onclick: () => { confirmBox.hidden = true; } }, 'Keep going'), el('button', { class: 'btn btn-danger', onclick: finishMock }, 'Submit'));
  const save = () => store.set('mockRun', mock);
  v.append(el('div', { class: 'view-head' }, timer, el('span', { class: 'muted mono', text: `${answered}/${mock.qs.length} answered` }), el('button', { class: 'btn btn-primary', onclick: () => { confirmBox.hidden = false; } }, 'Submit')), confirmBox);
  v.append(qCard(q, { mode: 'exam', chosen: mock.ans[mock.cur], num: `Q${mock.cur + 1} of ${mock.qs.length}`, onPick: i => { mock.ans[mock.cur] = i; save(); renderMock(); } }));
  const isRev = mock.rev.includes(mock.cur);
  v.append(el('div', { class: 'row', style: 'margin:10px 0' },
    el('button', { class: 'btn', disabled: mock.cur === 0, onclick: () => { mock.cur--; save(); renderMock(); } }, '← Prev'),
    el('button', { class: 'btn', onclick: () => { mock.rev = isRev ? mock.rev.filter(x => x !== mock.cur) : [...mock.rev, mock.cur]; save(); renderMock(); } }, isRev ? 'Unmark review' : 'Mark for review'),
    el('button', { class: 'btn btn-primary', disabled: mock.cur === mock.qs.length - 1, onclick: () => { mock.cur++; save(); renderMock(); } }, 'Next →')));
  v.append(el('div', { class: 'palette' }, mock.qs.map((_, i) => el('button', { class: [mock.ans[i] != null ? 'ans' : '', mock.rev.includes(i) ? 'rev' : '', i === mock.cur ? 'cur' : ''].join(' '), 'aria-label': 'Question ' + (i + 1), onclick: () => { mock.cur = i; save(); renderMock(); } }, String(i + 1)))));
  v.append(el('p', { class: 'muted', text: 'Filled = answered · pink ring = marked for review' }));
}
function scoreOf(m) {
  const n = m.qs.length, per = 300 / n; let c = 0, w = 0; const by = {};
  m.qs.forEach((q, i) => { const b = by[q.unit] = by[q.unit] || { c: 0, w: 0, s: 0 }; const a = m.ans[i];
    if (a == null) b.s++; else if (a === q.answer) { c++; b.c++; } else { w++; b.w++; } });
  return { n, c, w, s: n - c - w, score: Math.round((c * per - w * per / 3) * 100) / 100, by };
}
async function finishMock() {
  clearInterval(tick); mock.done = true; mock.used = Math.floor((Date.now() - mock.start) / 1000);
  mock.qs.forEach((q, i) => { if (mock.ans[i] != null) record(q, mock.ans[i] === q.answer); });
  const s = scoreOf(mock); store.set('mockRun', mock);
  const attempt = { id: mock.id, at: new Date().toISOString(), mode: 'mock', source: mockCfg.source, total: s.n, correct: s.c, wrong: s.w, skipped: s.s, score: s.score, max: 300, seconds: mock.used, by_unit: s.by, wrong_ids: mock.qs.filter((q, i) => mock.ans[i] != null && mock.ans[i] !== q.answer).map(q => q.id) };
  const local = store.get('attempts', []); local.push(attempt); store.set('attempts', local.slice(-100));
  api('/api/attempt', { method: 'POST', body: JSON.stringify({ attempt }) }).catch(() => toast('Saved on this phone; the laptop did not get the result.'));
  renderMock();
}
function renderResult(v) {
  const s = scoreOf(mock);
  v.append(el('h1', { class: 'h-title', text: 'Result' }),
    el('div', { class: 'card' }, el('div', { class: 'score mono', text: s.score + ' / 300' }),
      el('p', { text: `Correct ${s.c} · Wrong ${s.w} · Skipped ${s.s} · Accuracy ${s.c + s.w ? Math.round(100 * s.c / (s.c + s.w)) : 0}% · Time ${fmt(mock.used || 0)}` }),
      el('div', { class: 'list' }, Object.entries(s.by).map(([id, b]) => { const u = state.units.find(x => x.id === id); return el('div', {}, el('small', { text: `${u ? T(u) : id}: ${b.c} right, ${b.w} wrong, ${b.s} blank` }), el('div', { class: 'bar' }, el('i', { style: `width:${Math.round(100 * b.c / (b.c + b.w + b.s || 1))}%` }))); }))),
    el('div', { class: 'row', style: 'margin:12px 0' }, el('button', { class: 'btn btn-primary', onclick: () => { mock = null; store.del('mockRun'); renderMock(); } }, 'New mock'),
      el('button', { class: 'btn', onclick: () => askAbout('Mock result', { mock: { score: s.score, by_unit: s.by } }, 'Analyse my mock result and tell me what to revise first.') }, 'Ask Claude what to revise')),
    el('h2', { text: 'Review' }));
  mock.qs.forEach((q, i) => v.append(qCard(q, { chosen: mock.ans[i], reveal: true, num: `Q${i + 1} · ${mock.ans[i] == null ? 'skipped' : mock.ans[i] === q.answer ? 'correct' : 'wrong'}` }), el('div', { style: 'height:10px' })));
}

/* ---------- Notes ---------- */
let noteUnit = null, noteQ = '';
function renderNotes() {
  const v = $('#view-notes'); v.replaceChildren();
  if (noteUnit) {
    const d = state.data[noteUnit] || {}, u = state.units.find(x => x.id === noteUnit);
    const body = el('div', { class: 'notes card' }); body.innerHTML = md(d.notes_md || '');
    v.append(el('div', { class: 'view-head' }, el('button', { class: 'btn btn-quiet', onclick: () => { noteUnit = null; renderNotes(); } }, '← Topics'),
      el('button', { class: 'btn', onclick: () => askAbout(u ? u.title_en : noteUnit, { unit: noteUnit }, '') }, 'Ask about this')),
      el('h1', { class: 'h-title', text: u ? T(u) : '' }), body);
    if (d.quick_facts?.length) v.append(el('h2', { text: 'Last-minute facts' }), el('ul', { class: 'card' }, d.quick_facts.map(f => el('li', { text: f }))));
    return;
  }
  const search = el('input', { type: 'search', placeholder: 'Search all notes…', value: noteQ, oninput: e => { noteQ = e.target.value; const pos = e.target.selectionStart; renderNotes(); const s = $('#view-notes input'); s.focus(); s.setSelectionRange(pos, pos); } });
  v.append(el('h1', { class: 'h-title', text: 'Notes' }), search, el('div', { style: 'height:10px' }));
  const ql = noteQ.trim().toLowerCase();
  if (ql.length > 1) {
    const hits = [];
    for (const u of state.units) for (const para of String(state.data[u.id]?.notes_md || '').split(/\n\s*\n/)) if (para.toLowerCase().includes(ql)) hits.push([u, para]);
    v.append(el('p', { class: 'muted', text: hits.length + ' matches' }));
    hits.slice(0, 40).forEach(([u, p]) => { const c = el('div', { class: 'card notes', style: 'margin-bottom:8px' }); c.innerHTML = md(p); c.prepend(el('div', { class: 'pill', text: T(u) })); v.append(c); });
    return;
  }
  v.append(el('div', { class: 'list' }, state.units.map(u => el('button', { class: 'card unit-card', onclick: () => { noteUnit = u.id; renderNotes(); window.scrollTo(0, 0); } }, el('span', {}, el('b', { text: T(u) }), el('br'), el('small', { text: (u.words || 0) + ' words' })), el('span', { class: 'pill', text: 'Read' })))));
}

/* ---------- Progress ---------- */
async function renderProgress() {
  const v = $('#view-progress'); v.replaceChildren(el('h1', { class: 'h-title', text: 'Progress' }));
  let atts = store.get('attempts', []);
  try { const j = await api('/api/progress'); if (Array.isArray(j.attempts)) atts = j.attempts; } catch {}
  if (state.view !== 'progress') return;
  const done = Object.keys(state.history).length, right = Object.values(state.history).filter(Boolean).length;
  v.append(el('div', { class: 'card' }, el('p', { text: `${$('#cd-num').textContent} days to the CRT.` }), el('p', { text: `${done} different questions attempted, ${done ? Math.round(100 * right / done) : 0}% right.` })));
  const rows = state.units.map(u => ({ u, ...unitAcc(u.id) })).filter(r => r.done);
  if (rows.length) {
    v.append(el('h2', { text: 'By topic' }), el('div', { class: 'card list' }, rows.map(r => el('div', {}, el('small', { text: `${T(r.u)}: ${r.acc}% of ${r.done}` }), el('div', { class: 'bar' }, el('i', { style: `width:${r.acc}%` }))))));
    const weak = [...rows].sort((a, b) => a.acc - b.acc).slice(0, 3);
    v.append(el('button', { class: 'btn btn-primary', style: 'margin-top:10px', onclick: () => { mockCfg = { ...mockCfg, units: weak.map(w => w.u.id), source: 'mix', count: 25 }; go('mock'); } }, 'Practise weakest: ' + weak.map(w => T(w.u)).join(', ')));
  }
  v.append(el('h2', { text: 'Mock attempts' }));
  if (!atts.length) v.append(el('p', { class: 'muted', text: 'No mocks yet.' }));
  [...atts].reverse().slice(0, 30).forEach(a => v.append(el('div', { class: 'card', style: 'margin-bottom:8px' }, el('b', { class: 'mono', text: `${a.score} / ${a.max || 300}` }), el('span', { class: 'muted', text: ` · ${a.total} Qs · ${new Date(a.at).toLocaleString()}` }))));
}

/* ---------- boot ---------- */
async function boot() {
  countdown(); setInterval(countdown, 3600000);
  document.querySelectorAll('.lang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
  try { await loadUnits(); } catch (e) { if (!$('#login').hidden) return; toast(e.message); }
  go(mock && !mock.done ? 'mock' : state.view);
}
fetch('/api/session', { credentials: 'same-origin' }).then(r => { if (r.ok) boot(); else showLogin(); }).catch(() => { showLogin(); $('#login-err').textContent = 'Cannot reach the laptop server.'; });
})();
