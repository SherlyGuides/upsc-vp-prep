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
let BASE = '';
async function api(path, opts = {}) {
  const r = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (r.status === 401) { showLogin(); throw new Error('Please enter the passcode again.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || ('Server error ' + r.status));
  return j;
}
function showLogin() { $('#login').hidden = false; setTimeout(() => $('#pass').focus(), 50); }
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault(); const err = $('#login-err'); err.textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: $('#pass').value.trim() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = j.error === 'too_many_attempts' ? `Too many tries. Wait ${Math.ceil((j.retry_after_s || 900) / 60)} min.` : 'Wrong passcode.'; return; }
    $('#login').hidden = true; $('#pass').value = ''; boot();
  } catch { err.textContent = 'Cannot reach the laptop. Is the server running?'; }
});

/* ---------- data ---------- */
async function loadUnits() {
  let j = null;
  try { const r = await fetch('data/units.json', { cache: 'no-cache' }); if (r.ok) j = await r.json(); } catch {}
  if (!j) j = await api('/api/units');
  state.units = j.units.filter(u => u.available).sort((a, b) => (b.id === 'plan') - (a.id === 'plan'));
  await Promise.all(state.units.map(async u => { try { const r = await fetch('data/' + u.id + '.json', { cache: 'no-cache' }); state.data[u.id] = r.ok ? await r.json() : await api('/data/' + u.id + '.json'); } catch {} }));
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
  if (v !== 'mock') document.body.classList.remove('in-mock');
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
        try { navigator.vibrate && navigator.vibrate(8); } catch {}
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
function record(q, ok, unit) {
  const u = q.unit || unit || 'chat', d = istDay(), act = store.get('activity', {});
  const a = act[d] = act[d] || { n: 0, units: {} }; a.n++; a.units[u] = (a.units[u] || 0) + 1; store.set('activity', act);
  if (!q.id) return; state.history[q.id] = ok ? 1 : 0; store.set('qhist', state.history);
}
const istDay = (t = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(t);

/* ---------- Ask ---------- */
let chats = store.get('chats', null);
if (!Array.isArray(chats) || !chats.length) chats = [{ id: 'c' + Date.now().toString(36), title: '', msgs: store.get('chat', []), updated: Date.now() }];
let curChat = store.get('curChat', chats[0].id); if (!chats.find(c => c.id === curChat)) curChat = chats[0].id;
let chat = chats.find(c => c.id === curChat).msgs, ctl = null;
function saveChats() {
  const c = chats.find(x => x.id === curChat);
  if (c) { c.msgs = chat; c.updated = Date.now(); if (!c.title && chat[0]) c.title = chat[0].content.slice(0, 60); }
  chats = chats.filter(x => x.msgs.length || x.id === curChat).sort((a, b) => b.updated - a.updated).slice(0, 30);
  store.set('chats', chats); store.set('curChat', curChat);
}
function newChat() {
  if (ctl) return toast('Wait for the answer to finish, or tap Stop.');
  if (!chat.length) { $('#ask-input').focus(); return; }
  const c = { id: 'c' + Date.now().toString(36), title: '', msgs: [], updated: Date.now() };
  chats.unshift(c); curChat = c.id; chat = c.msgs; state.ctx = null; saveChats(); renderChat(); $('#ask-input').focus();
}
function openChats() {
  const body = $('#sheet-body'); body.replaceChildren(); $('#sheet-title').textContent = 'Your chats';
  body.append(el('button', { class: 'btn btn-primary btn-block', onclick: () => { closeSheet(); newChat(); } }, '+ New chat'));
  for (const c of chats.filter(x => x.msgs.length)) {
    const row = el('div', { class: 'row', style: 'margin-top:8px;flex-wrap:nowrap' },
      el('button', { class: 'chip', style: 'flex:1;min-width:0;' + (c.id === curChat ? 'border-color:var(--ink)' : ''), onclick: () => { if (ctl) return toast('Wait for the answer to finish.'); curChat = c.id; chat = c.msgs; state.ctx = null; store.set('curChat', curChat); closeSheet(); renderChat(); } },
        el('b', { text: c.title || 'Chat' }), el('br'), el('small', { class: 'muted', text: `${c.msgs.length} messages · ${new Date(c.updated).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` })),
      el('button', { class: 'icon-btn', 'aria-label': 'Delete chat', onclick: () => { chats = chats.filter(x => x.id !== c.id); if (c.id === curChat) { if (!chats.length) chats = [{ id: 'c' + Date.now().toString(36), title: '', msgs: [], updated: Date.now() }]; curChat = chats[0].id; chat = chats[0].msgs; } saveChats(); openChats(); renderChat(); } }, '✕'));
    body.append(row);
  }
  openSheet();
}
const SUGGEST = ['Make my study plan for today', 'Give me a 25-question mock', '10 MCQs on CCS Leave Rules', 'Explain RTE Section 12(1)(c)', 'NEP 2020 में 5+3+3+4 क्या है?', 'Difference between noting and drafting', 'Current affairs quiz: July 2026'];
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
    if (Array.isArray(p.mcq)) p.mcq.forEach((q, i) => { const qq = { ...q, answer: Number(q.answer) }; frag.append(qCard(qq, { num: 'Q' + (i + 1), onPick: k => record(qq, k === qq.answer, 'chat') })); });
    if (p.action && p.action.type === 'start_mock') frag.append(el('button', { class: 'btn btn-primary', onclick: () => { mockCfg = { ...mockCfg, count: [5, 10, 15, 25, 50, 100].includes(+p.action.count) ? +p.action.count : 25, source: ['bank', 'fresh', 'mix'].includes(p.action.source) ? p.action.source : 'bank', units: Array.isArray(p.action.units) && !p.action.units.includes('all') ? p.action.units : [] }; go('mock'); startMock(); } }, `Start mock (${p.action.count || 25} questions)`));
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
$('#btn-newchat').addEventListener('click', newChat);
$('#btn-newchat').before(el('button', { class: 'btn btn-quiet', type: 'button', onclick: openChats }, 'Chats'));
$('#newchat-no').addEventListener('click', () => { $('#newchat-confirm').hidden = true; });
/* mic: speech-to-text into the question box */
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return;
  const mic = el('button', { type: 'button', class: 'send-btn mic', 'aria-label': 'Speak your question' });
  mic.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  $('#btn-send').before(mic);
  let rec = null;
  mic.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = state.lang === 'hi' ? 'hi-IN' : 'en-IN'; rec.interimResults = true; rec.continuous = false;
    const box = $('#ask-input'), base = box.value ? box.value.trimEnd() + ' ' : '';
    rec.onresult = e => { let t = ''; for (const r of e.results) t += r[0].transcript; box.value = base + t; };
    rec.onerror = e => { if (e.error === 'not-allowed') toast('Allow microphone access for this site in your browser settings.'); else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Mic error: ' + e.error); };
    rec.onend = () => { rec = null; mic.classList.remove('listening'); mic.setAttribute('aria-label', 'Speak your question'); };
    try { rec.start(); mic.classList.add('listening'); mic.setAttribute('aria-label', 'Stop listening'); toast(state.lang === 'hi' ? 'बोलिए… (हिंदी)' : 'Listening… (switch to हिं for Hindi)'); } catch { rec = null; }
  });
})();

async function send(text) {
  if (ctl) return;
  $('#ask-input').value = '';
  chat.push({ role: 'user', content: text }); renderChat();
  const bubble = el('div', { class: 'msg bot' }, el('p', { class: 'status', text: 'Thinking…' }));
  $('#chat').append(bubble); bubble.scrollIntoView({ block: 'end' });
  ctl = new AbortController(); $('#btn-send').hidden = true; $('#btn-stop').hidden = false;
  let full = '', meta = '';
  try {
    if (BASE === null) throw new Error('The laptop is switched off right now, so Claude cannot answer. Practice, Mock (question bank) and Notes still work.');
    const r = await fetch(BASE + '/api/ask', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' },
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
    chat = chat.slice(-40); saveChats(); state.ctx = null; renderChat();
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
    for (const u of state.units.filter(x => x.mcq_count)) {
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
  v.append(qCard(q, { num: `${prac.i + 1} / ${qs.length} · ${q.difficulty || ''}`, onPick: i => record(q, i === q.answer, prac.unit) }));
  const nextP = () => { prac.i++; renderPractice(); window.scrollTo(0, 0); };
  v.append(el('div', { class: 'sticky-actions' },
    el('button', { class: 'btn', onclick: () => askAbout('Practice question', { mcq: q, unit: prac.unit }, 'Explain this question and the concept behind it.') }, 'Ask Claude'),
    el('button', { class: 'btn btn-primary', onclick: nextP }, 'Next →')));
  swipe(v.querySelector('.q'), nextP, () => { if (prac.i > 0) { prac.i--; renderPractice(); } });
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
  document.body.classList.toggle('in-mock', !!(mock && !mock.done) && state.view === 'mock');
  if (mock && !mock.done) return renderMockRun(v);
  if (mock && mock.done) return renderResult(v);
  const seg = (key, opts) => el('div', { class: 'seg' }, opts.map(([k, l]) => el('button', { 'aria-pressed': String(mockCfg[key] === k), onclick: () => { mockCfg[key] = k; store.set('mockCfg', mockCfg); renderMock(); } }, l)));
  const unitSeg = el('div', { class: 'seg' }, el('button', { 'aria-pressed': String(!mockCfg.units.length), onclick: () => { mockCfg.units = []; renderMock(); } }, 'All topics'),
    state.units.filter(x => x.mcq_count).map(u => el('button', { 'aria-pressed': String(mockCfg.units.includes(u.id)), onclick: () => { mockCfg.units = mockCfg.units.includes(u.id) ? mockCfg.units.filter(x => x !== u.id) : [...mockCfg.units, u.id]; renderMock(); } }, T(u))));
  const avail = allQs().length;
  v.append(el('h1', { class: 'h-title', text: 'Mock test' }),
    el('p', { class: 'muted', text: 'Marked like the CRT: 300 marks in total, each wrong answer loses one-third of that question\'s marks, blanks score zero.' }),
    el('div', { class: 'card list' },
      el('b', { text: 'Questions' }), seg('count', [[5, '5'], [10, '10'], [15, '15'], [25, '25'], [50, '50'], [100, '100']]),
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
  v.append(el('div', { class: 'view-head' }, el('button', { class: 'btn btn-quiet', 'aria-label': 'Leave the mock (it stays saved)', onclick: () => go('progress') }, '✕'), timer, el('span', { class: 'muted mono', text: `${answered}/${mock.qs.length}` }), el('button', { class: 'btn btn-primary', onclick: () => { confirmBox.hidden = false; } }, 'Submit')), confirmBox);
  v.append(qCard(q, { mode: 'exam', chosen: mock.ans[mock.cur], num: `Q${mock.cur + 1} of ${mock.qs.length}`, onPick: i => { mock.ans[mock.cur] = i; save(); renderMock(); } }));
  const isRev = mock.rev.includes(mock.cur);
  const goQ = i => { if (i < 0 || i >= mock.qs.length) return; mock.cur = i; save(); renderMock(); window.scrollTo(0, 0); };
  const last = mock.cur === mock.qs.length - 1;
  const openGrid = () => {
    const body = $('#sheet-body'); body.replaceChildren(); $('#sheet-title').textContent = `${answered} of ${mock.qs.length} answered`;
    body.append(el('div', { class: 'palette' }, mock.qs.map((_, i) => el('button', { class: [mock.ans[i] != null ? 'ans' : '', mock.rev.includes(i) ? 'rev' : '', i === mock.cur ? 'cur' : ''].join(' '), 'aria-label': 'Question ' + (i + 1), onclick: () => { closeSheet(); goQ(i); } }, String(i + 1)))),
      el('p', { class: 'muted', text: 'Filled = answered · pink ring = marked for review' }));
    openSheet();
  };
  v.append(el('div', { class: 'sticky-actions' },
    el('button', { class: 'btn', 'aria-label': 'Previous question', disabled: mock.cur === 0, onclick: () => goQ(mock.cur - 1) }, '←'),
    el('button', { class: 'btn', 'aria-label': 'All questions', onclick: openGrid }, `${mock.cur + 1}/${mock.qs.length} ▦`),
    el('button', { class: 'btn' + (isRev ? ' marked' : ''), onclick: () => { mock.rev = isRev ? mock.rev.filter(x => x !== mock.cur) : [...mock.rev, mock.cur]; save(); renderMock(); } }, isRev ? '★ Marked' : '☆ Review'),
    last ? el('button', { class: 'btn btn-primary', onclick: () => { confirmBox.hidden = false; window.scrollTo(0, 0); } }, 'Finish') : el('button', { class: 'btn btn-primary', onclick: () => goQ(mock.cur + 1) }, 'Next →')));
  swipe(v.querySelector('.q'), () => goQ(mock.cur + 1), () => goQ(mock.cur - 1));
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
  const v0 = $('#view-progress'); v0.replaceChildren(); renderRoadmap(v0);
  const v = el('details', { class: 'card rm-more' }, el('summary', {}, el('b', { text: 'Scores & weak topics' }))); v0.append(v);
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

/* ---------- Roadmap (date-driven, updates itself each day) ---------- */
const S = (unit, label) => ({ unit, label });
const ROADMAP = [
  ['2026-10-09', 'study', [S('plan', 'Read the Revision Plan (Notes tab, first item)'), S('mock15', 'Diagnostic: a 15-question mock across all topics')]],
  ['2026-10-10', 'study', [S('policy', 'Education policies: NEP 2020, NCF-SE, NIPUN, PM SHRI, Samagra'), S('reason', 'Reasoning: series, analogy, coding')]],
  ['2026-10-11', 'study', [S('law', 'RTE Act + child rights: POCSO, RPwD, JJ'), S('reason', 'Quant: percentage, ratio, average')]],
  ['2026-10-12', 'study', [S('pedagogy', 'Learning theories: Piaget, Vygotsky, Bruner, Skinner'), S('lang', 'English grammar')]],
  ['2026-10-13', 'study', [S('pedagogy', 'Intelligence, aptitude, individual differences, sociometry'), S('lang', 'Hindi व्याकरण: संधि, समास, मुहावरे')]],
  ['2026-10-14', 'study', [S('eval', 'Measurement & evaluation: Bloom, reliability, validity, statistics'), S('gk', 'Constitution + education articles')]],
  ['2026-10-15', 'study', [S('office', 'Office procedure: noting, drafting, dak, files, records'), S('digital', 'Digital literacy')]],
  ['2026-10-16', 'study', [S('office', 'RTI Act 2005'), S('ca', 'Current affairs Oct 2025 – Mar 2026')]],
  ['2026-10-17', 'study', [S('service', 'CCS Leave Rules, LTC, joining time'), S('reason', 'Quant: SI/CI, profit-loss, time-work')]],
  ['2026-10-18', 'study', [S('service', 'CCS Conduct + CCA Rules, FR, pay fixation'), S('ca', 'Current affairs Apr – Aug 2026'), S('mock50', 'First 50-question mock')]],
  ['2026-10-19', 'study', [S('mgmt', 'GFR 2017, GeM/procurement, school finance'), S('reason', 'Blood relations, direction, syllogism')]],
  ['2026-10-20', 'study', [S('mgmt', 'School management + Delhi School Education Act & Rules 1973'), S('gk', 'History, economy, culture')]],
  ['2026-10-21', 'mock', [S('mock100', 'Full 100-question mock at 9:30 am, timer on'), S('review', 'Review every explanation')]],
  ['2026-10-22', 'weak', [S('weak', 'Your 3 weakest topics + 25-question mock on them'), S('facts', 'Last-minute facts: 3 topics')]],
  ['2026-10-23', 'mock', [S('mock100', 'Full 100-question mock at 9:30 am'), S('review', 'Review + add numbers to your one-page sheet')]],
  ['2026-10-24', 'weak', [S('weak', 'Your 3 weakest topics + 25-question mock'), S('facts', 'Last-minute facts: 3 topics')]],
  ['2026-10-25', 'mock', [S('mock100', 'Full 100-question mock at 9:30 am'), S('review', 'Review every explanation')]],
  ['2026-10-26', 'weak', [S('weak', 'Your 3 weakest topics + 25-question mock'), S('facts', 'Last-minute facts: 3 topics')]],
  ['2026-10-27', 'mock', [S('mock100', 'Full 100-question mock at 9:30 am'), S('review', 'Review every explanation')]],
  ['2026-10-28', 'mock', [S('mock100', 'Last full mock'), S('review', 'Final one-page sheet')]],
  ['2026-10-29', 'facts', [S('facts', 'Last-minute facts: all topics'), S('mock15', '15-question mocks on weak topics')]],
  ['2026-10-30', 'facts', [S('facts', 'One-page sheet + last-minute facts'), S('mock15', '15-question mock')]],
  ['2026-10-31', 'rest', [S('rest', 'Light revision only. Admit card, photo ID, black pens ready. Sleep by 10 pm')]],
  ['2026-11-01', 'exam', [S('exam', 'CRT day. Fill the OMR as you go. Guess only when you can rule out 2 options')]],
];
const GOALS = { study: { q: 40, mock: 1, h: '3 h on a school day, 6 h on a weekend' }, mock: { q: 100, mock: 1, h: '2 h mock + 1.5 h review' }, weak: { q: 50, mock: 1, h: '3 h' }, facts: { q: 30, mock: 1, h: '2–3 h' }, rest: { q: 0, mock: 0, h: '1 h light revision' }, exam: { q: 0, mock: 0, h: 'Exam' } };
const PHASES = { study: 'Cover every topic once', mock: 'Full mock day', weak: 'Weak-area day', facts: 'Sharpen, nothing new', rest: 'Rest + get ready', exam: 'Exam day' };
function dayActivity(d) { return store.get('activity', {})[d] || { n: 0, units: {} }; }
function mocksOn(d) { return store.get('attempts', []).filter(a => istDay(new Date(a.at)) === d); }
function itemDone(d, it, idx) {
  const ticks = store.get('ticks', {}); if (ticks[d + ':' + idx] != null) return ticks[d + ':' + idx];
  const a = dayActivity(d), ms = mocksOn(d);
  if (it.unit === 'mock100') return ms.some(m => m.total >= 50);
  if (it.unit === 'mock50') return ms.some(m => m.total >= 50);
  if (it.unit === 'mock15' || it.unit === 'weak') return ms.length > 0;
  if (state.data[it.unit]) return (a.units[it.unit] || 0) >= 10;
  return false;
}
function taskButtons(it) {
  const row = el('div', { class: 'row' });
  const has = state.data[it.unit]?.mcqs?.length;
  if (state.data[it.unit]?.notes_md) row.append(el('button', { class: 'btn', onclick: () => { noteUnit = it.unit; go('notes'); } }, 'Notes'));
  if (has) row.append(el('button', { class: 'btn', onclick: () => { prac = { unit: it.unit, filter: 'all', i: 0 }; go('practice'); } }, 'Practice'));
  if (/^mock/.test(it.unit)) row.append(el('button', { class: 'btn btn-primary', onclick: () => { mockCfg = { ...mockCfg, count: +it.unit.slice(4) || 25, units: [], timer: true }; go('mock'); } }, 'Start mock'));
  if (it.unit === 'weak') row.append(el('button', { class: 'btn btn-primary', onclick: () => go('progress') || window.scrollTo(0, document.body.scrollHeight) }, 'See weakest'));
  if (!has && !/^(mock|weak|facts|rest|exam|review)/.test(it.unit)) row.append(el('button', { class: 'btn btn-primary', onclick: () => { go('ask'); send(`Teach me "${it.label}" for the UPSC Vice Principal CRT: the key points I must memorise, then 10 MCQs.`); } }, 'Learn with Claude'));
  if (it.unit === 'facts') row.append(el('button', { class: 'btn', onclick: () => go('notes') }, 'Open notes'));
  return row;
}
function taskRow(d, it, idx, today) {
  const done = itemDone(d, it, idx);
  const box = el('div', { class: 'card', style: 'display:grid;gap:8px' + (done ? ';opacity:.7' : '') });
  const tick = el('button', { class: 'opt' + (done ? ' right' : ''), 'aria-pressed': String(done), onclick: () => { const t = store.get('ticks', {}); t[d + ':' + idx] = !done; store.set('ticks', t); render(); } },
    el('span', { class: 'bub', text: done ? '✓' : '' }), el('span', { class: 'opt-txt' }, el('b', { text: it.label }), today ? null : el('small', { class: 'muted', text: ' · from ' + new Date(d + 'T12:00:00+05:30').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) })));
  box.append(tick); if (!done) box.append(taskButtons(it));
  return box;
}
const SHORT = { policy: 'Policy', law: 'RTE & child rights', pedagogy: 'Pedagogy', eval: 'Evaluation', office: 'Office procedure', service: 'Service rules', mgmt: 'Mgmt & finance', gk: 'GK', reason: 'Reasoning', lang: 'Language', digital: 'Digital', ca: 'Current affairs', mock100: '100-Q mock', mock50: '50-Q mock', mock15: '15-Q mock', weak: 'Weak topics', facts: 'Quick facts', review: 'Review mistakes', rest: 'Rest + get ready', exam: 'CRT', plan: 'Read plan' };
const fmtDay = (d, o = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(d + 'T12:00:00+05:30').toLocaleDateString('en-IN', o);
function rmRow(d, it, idx, extra) {
  const done = itemDone(d, it, idx);
  const tick = el('span', { class: 'bub rm-tick' + (done ? ' on' : ''), role: 'checkbox', 'aria-checked': String(done), tabindex: '0', text: done ? '✓' : '' });
  const toggle = e => { e.preventDefault(); e.stopPropagation(); const t = store.get('ticks', {}); t[d + ':' + idx] = !done; store.set('ticks', t); render(); };
  tick.addEventListener('click', toggle); tick.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') toggle(e); });
  return el('details', { class: 'rm-row' + (done ? ' done' : '') }, el('summary', {}, tick, el('span', { class: 'rm-label', text: SHORT[it.unit] || it.label }), extra ? el('span', { class: 'rm-extra mono', text: extra }) : null),
    el('div', { class: 'rm-body' }, el('small', { class: 'muted', text: it.label }), taskButtons(it)));
}
function renderRoadmap(v) {
  const today = istDay(), cur = ROADMAP.find(r => r[0] === today);
  const left = Math.max(0, Math.round((new Date('2026-11-01T00:00:00+05:30') - new Date(today + 'T00:00:00+05:30')) / 86400000));
  const past = ROADMAP.filter(r => r[0] < today);
  v.append(el('div', { class: 'rm-head' }, el('b', { class: 'mono', text: left + ' days left' }), el('span', { class: 'muted', text: cur ? PHASES[cur[1]] : '' })),
    el('div', { class: 'bar' }, el('i', { style: `width:${Math.round(100 * past.length / (ROADMAP.length - 1))}%` })));
  if (cur) {
    const g = GOALS[cur[1]], a = dayActivity(today), m = mocksOn(today).length;
    const box = el('div', { class: 'card rm-today' }, el('div', { class: 'rm-title', text: 'Today' }));
    cur[2].forEach((it, i) => box.append(rmRow(today, it, i)));
    if (g.q) box.append(el('div', { class: 'rm-row static' + (a.n >= g.q ? ' done' : '') }, el('span', { class: 'bub rm-tick' + (a.n >= g.q ? ' on' : ''), text: a.n >= g.q ? '✓' : '' }), el('span', { class: 'rm-label', text: 'Questions' }), el('span', { class: 'rm-extra mono', text: `${a.n}/${g.q}` })));
    if (g.mock && !cur[2].some(it => /^mock/.test(it.unit))) box.append(el('div', { class: 'rm-row static' + (m >= g.mock ? ' done' : '') }, el('span', { class: 'bub rm-tick' + (m >= g.mock ? ' on' : ''), text: m >= g.mock ? '✓' : '' }), el('span', { class: 'rm-label', text: 'Mock' }), el('span', { class: 'rm-extra mono', text: `${m}/${g.mock}` })));
    if (cur[1] === 'study') ['20 min current affairs', '20 min English / Hindi'].forEach(t => box.append(el('div', { class: 'rm-row static' }, el('span', { class: 'bub rm-tick' }), el('span', { class: 'rm-label', text: t }))));
    box.append(el('small', { class: 'muted', text: g.h }));
    v.append(box);
  }
  const missed = past.filter(r => r[1] === 'study').flatMap(r => r[2].map((it, i) => ({ d: r[0], it, i }))).filter(x => !/^mock/.test(x.it.unit) && !itemDone(x.d, x.it, x.i));
  if (missed.length && today <= '2026-10-28') v.append(el('details', { class: 'card rm-more' }, el('summary', {}, el('b', { text: `Catch up · ${missed.length}` })), missed.slice(0, 6).map(x => rmRow(x.d, x.it, x.i, fmtDay(x.d, { day: 'numeric', month: 'short' })))));
  renderRoad(v, today);
}


/* the road: a winding path from today to the exam, one stop per day */
const KIND_MARK = { study: '', mock: 'M', weak: 'W', facts: 'F', rest: 'R', exam: '🏁' };
function openDay(r) {
  const today = istDay(), body = $('#sheet-body'); body.replaceChildren();
  $('#sheet-title').textContent = fmtDay(r[0], { weekday: 'long', day: 'numeric', month: 'long' });
  const g = GOALS[r[1]];
  body.append(el('p', { class: 'muted', text: PHASES[r[1]] + (g.q ? ` · goal ${g.q} questions, ${g.mock} mock · ${g.h}` : ` · ${g.h}`) }));
  r[2].forEach((it, i) => body.append(rmRow(r[0], it, i)));
  if (r[0] > today) body.append(el('small', { class: 'muted', text: 'You can tick this early if you finish it ahead of time.' }));
  openSheet();
}
function renderRoad(v, today) {
  const days = ROADMAP.filter(r => r[0] >= today), past = ROADMAP.filter(r => r[0] < today);
  if (!days.length) return;
  const STEP = 84, TOP = 46, H = TOP * 2 + STEP * (days.length - 1);
  const pts = days.map((r, i) => ({ r, x: i === 0 || i === days.length - 1 ? 50 : 50 + 30 * Math.sin(i * Math.PI / 2.6), y: TOP + i * STEP }));
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) { const p0 = pts[i - 1], p1 = pts[i], m = (p1.y - p0.y) / 2; d += ` C ${p0.x} ${p0.y + m} ${p1.x} ${p1.y - m} ${p1.x} ${p1.y}`; }
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 100 ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'road-svg'); svg.setAttribute('aria-hidden', 'true');
  for (const cls of ['road-bed', 'road-line']) { const pa = document.createElementNS(NS, 'path'); pa.setAttribute('d', d); pa.setAttribute('class', cls); pa.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(pa); }
  const wrap = el('div', { class: 'road', style: `height:${H}px` }); wrap.append(svg);
  const doneN = past.filter(r => r[2].every((it, i) => itemDone(r[0], it, i))).length;
  pts.forEach((p, i) => {
    const r = p.r, isToday = r[0] === today, isExam = r[1] === 'exam';
    const all = r[2].every((it, k) => itemDone(r[0], it, k));
    const node = el('button', { class: 'stop k-' + r[1] + (isToday ? ' today' : '') + (all && !isExam ? ' done' : '') + (isExam ? ' exam' : ''), style: `left:${p.x}%;top:${p.y}px`, 'aria-label': fmtDay(r[0]) + ': ' + r[2].map(it => SHORT[it.unit] || it.label).join(', '), onclick: () => openDay(r) },
      el('span', { text: isExam ? '🏁' : all ? '✓' : (KIND_MARK[r[1]] || fmtDay(r[0], { day: 'numeric' })) }));
    const left = p.x >= 50;
    const lab = el('button', { class: 'stop-label' + (left ? ' l' : ' r') + (isToday ? ' today' : ''), style: (left ? `right:calc(${100 - p.x}% + ${isExam ? 40 : isToday ? 34 : 30}px)` : `left:calc(${p.x}% + ${isExam ? 40 : isToday ? 34 : 30}px)`) + `;top:${p.y - 22}px;max-width:calc(${left ? p.x : 100 - p.x}% - 36px)`, onclick: () => openDay(r) },
      el('b', { class: 'mono', text: isToday ? 'TODAY · ' + fmtDay(r[0], { day: 'numeric', month: 'short' }) : isExam ? 'CRT · 1 Nov' : fmtDay(r[0]) }),
      el('span', { text: isExam ? 'Exam day' : r[2].map(it => SHORT[it.unit] || it.label).join(' + ') }));
    wrap.append(node, lab);
  });
  v.append(el('div', { class: 'card road-card' },
    el('div', { class: 'rm-title', text: 'Your road to the CRT' }),
    past.length ? el('small', { class: 'muted', text: `${doneN} of ${past.length} earlier days fully done` }) : el('small', { class: 'muted', text: 'Tap any stop to see that day.' }),
    wrap,
    el('div', { class: 'road-key muted' }, el('span', { text: 'M full mock' }), el('span', { text: 'W weak topics' }), el('span', { text: 'F facts' }), el('span', { text: 'R rest' }))));
}

/* ---------- phone helpers ---------- */
function swipe(node, onLeft, onRight) {
  if (!node) return; let x0 = null, y0 = null;
  node.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  node.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy)) (dx < 0 ? onLeft : onRight)(); }, { passive: true });
}
(() => {
  const box = $('#ask-input');
  const grow = () => { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 140) + 'px'; };
  box.addEventListener('input', grow);
  box.addEventListener('focus', () => document.body.classList.add('typing'));
  box.addEventListener('blur', () => setTimeout(() => document.body.classList.remove('typing'), 150));
  new MutationObserver(grow).observe(box, { attributes: false, childList: true });
})();

/* ---------- boot ---------- */
async function boot() {
  countdown(); setInterval(countdown, 3600000);
  document.querySelectorAll('.lang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
  try { await loadUnits(); } catch (e) { if (!$('#login').hidden) return; toast(e.message); }
  go(mock && !mock.done ? 'mock' : state.view);
}
(async () => {
  if (/github\.io$/.test(location.hostname)) {
    try { const r = await fetch('backend.json?t=' + Date.now(), { cache: 'no-store' }); const j = await r.json(); BASE = j.api || null;
      if (BASE) { const h = await fetch(BASE + '/api/health').catch(() => null); if (!h || !h.ok) BASE = null; } } catch { BASE = null; }
  }
  boot();
})();
})();
