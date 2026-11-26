// Agent Office: draws every open Claude Code session as a character at a desk. Data: GET /api/office.
const $ = (id) => document.getElementById(id);
const POLL_MS = 3000;
const DEMO = new URLSearchParams(location.search).has('demo') ? '?demo=1' : ''; // made-up sessions for trying it out
const ORDER = ['needs-you', 'working', 'done', 'break', 'asleep'];
const STATE_WORDS = {
  working: 'Working',
  'needs-you': 'Needs you',
  done: 'Finished, your turn',
  break: 'On a break',
  asleep: 'Asleep',
};

let sessions = [];
let now = Date.now();
let layoutKey = '';
let openPid = null;
let openSnapshot = null; // last data for the session in the card, kept after it quits
let confirming = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function span(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

function clock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
}

function hue(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

const jobLabel = (cmd) => cmd.replace(/^cd\s+\S+\s*(;|&&)\s*/, '').replace(/\s*>\s*\S+.*$/, '');
const quietMs = (s) => now - (s.stateSince || s.startedAt || now);

function bubbleText(s) {
  if (s.state === 'working') return s.current ? s.current.label : 'Thinking';
  if (s.state === 'needs-you') return s.waitingFor ? `I need you: ${s.waitingFor}` : 'I need your answer';
  if (s.state === 'done') return s.jobs.length ? 'Waiting on a job I left running' : 'Done. Your turn.';
  if (s.state === 'break') return `On a break for ${span(quietMs(s))}`;
  return `Asleep for ${span(quietMs(s))}`;
}

// The character, seen from above. 140x104 scene: desk along the top wall, robot in its chair below it.
function bot(s) {
  const st = s.state;
  const body = `hsl(${hue(s.sessionId)} 55% 58%)`;
  const asleep = st === 'asleep';
  const raised = st === 'needs-you' || st === 'done';
  const days = quietMs(s) / 86400000;

  const rightArm = raised
    ? '<rect class="bot-shape wave" x="92" y="60" width="30" height="10" rx="5"/>'
    : '<rect class="bot-shape arm-r" x="85" y="34" width="10" height="34" rx="5"/>';
  const laptopParts = asleep
    ? '<rect x="52" y="10" width="36" height="24" rx="3" fill="var(--laptop)" stroke="var(--bot-line)" stroke-width="2"/>'
    : `<rect x="52" y="13" width="36" height="22" rx="3" fill="var(--laptop)" stroke="var(--bot-line)" stroke-width="2"/>
       <rect x="52" y="8" width="36" height="7" rx="2" fill="var(--face)" stroke="var(--bot-line)" stroke-width="2"/>
       <circle class="screen-glow" cx="70" cy="11.500" r="2" fill="${st === 'working' ? 'var(--working)' : 'var(--muted)'}"/>
       <path d="M58 21h24M58 26h24M60 31h20" stroke="var(--bot-line)" stroke-width="1.500" stroke-linecap="round" opacity="0.45"/>`;
  // Clicking the computer jumps straight to the session's terminal (see the floor click handler).
  const laptop = `<g class="computer"><title>Open its terminal</title>${laptopParts}</g>`;
  const mug = st === 'break'
    ? `<path class="line steam" d="M113 12q-3-3 0-6"/><path class="line steam" style="animation-delay:1.1s" d="M118 13q-3-3 0-6"/>
       <path class="line" d="M122 24h5"/>
       <circle cx="114" cy="24" r="8" fill="var(--bubble)" stroke="var(--bot-line)" stroke-width="2"/>
       <circle cx="114" cy="24" r="4.500" fill="var(--coffee)"/>`
    : '';
  const zzz = asleep ? '<text class="zzz" x="104" y="60">Z</text><text class="zzz z2" x="116" y="50">z</text>' : '';
  const web = asleep && days >= 3
    ? '<path d="M10 42V74M10 42L32 66M10 42H42M10 58Q20 56 22 54M10 68Q24 64 27 60M22 54Q28 48 28 42M27 60Q38 52 38 42" fill="none" stroke="var(--web)" stroke-width="1.2"/>'
    : '';
  const server = s.jobs && s.jobs.length
    ? `<rect x="15" y="11" width="26" height="22" rx="3" fill="var(--chair)" stroke="var(--bot-line)" stroke-width="2"/>
       <circle class="blink" cx="22" cy="18" r="2.500" fill="var(--working)"/><path class="line" d="M21 26h14M28 18h7"/>`
    : '';
  const head = `
    <g ${asleep ? 'class="resting" transform="translate(3 -30) rotate(9 70 68)"' : ''}>
      <rect class="bot-shape" x="51" y="50" width="38" height="34" rx="12"/>
      <rect x="57" y="52.500" width="26" height="7" rx="3.500" fill="var(--face)"/>
      ${asleep ? '' : '<circle cx="65" cy="56" r="1.700" fill="var(--eye)"/><circle cx="75" cy="56" r="1.700" fill="var(--eye)"/>'}
      <circle class="led ${st}" cx="70" cy="70" r="5.500" stroke="var(--bot-line)" stroke-width="2"/>
    </g>`;

  return `<svg class="scene" viewBox="0 0 140 104" aria-hidden="true">
    <circle cx="70" cy="76" r="25" fill="var(--chair)" stroke="var(--bot-line)" stroke-width="2"/>
    ${web}
    <rect x="8" y="4" width="124" height="36" rx="4" fill="var(--desk)" stroke="var(--bot-line)" stroke-width="2"/>
    ${server}${laptop}${mug}
    <g class="${asleep ? 'sleeper' : ''}">
      <ellipse cx="70" cy="${asleep ? 60 : 68}" rx="27" ry="${asleep ? 20 : 15}" fill="${body}" stroke="var(--bot-line)" stroke-width="2"/>
      <rect class="bot-shape arm-l" x="45" y="34" width="10" height="34" rx="5"/>
      ${rightArm}
    </g>
    ${head}${zzz}
  </svg>`;
}

function helperBot(h) {
  const body = `hsl(${hue(h.id)} 45% 66%)`;
  return `<div class="helper working" title="${esc(h.task)}">
    <svg viewBox="40 44 60 46" aria-hidden="true">
      <ellipse cx="70" cy="68" rx="24" ry="13" fill="${body}" stroke="var(--bot-line)" stroke-width="2"/>
      <rect class="bot-shape" x="54" y="52" width="32" height="30" rx="10"/>
      <rect x="59" y="54.500" width="22" height="6" rx="3" fill="var(--face)"/>
      <circle class="led working" cx="70" cy="70" r="4.500" stroke="var(--bot-line)" stroke-width="2"/>
    </svg>
    <b>${esc(h.type)}</b><span>${esc(h.doing)}</span>
  </div>`;
}

function stationHtml(s) {
  const since = s.state === 'working' ? `working ${span(quietMs(s))}` : `open ${span(now - (s.startedAt || now))}`;
  const job = s.jobs.length
    ? `<div class="job" title="${esc(s.jobs.map((j) => j.command).join('\n'))}">Left running: ${esc(jobLabel(s.jobs[0].command))}${s.jobs.length > 1 ? ` +${s.jobs.length - 1}` : ''}</div>`
    : '';
  const label = `${s.name}. ${STATE_WORDS[s.state]}. ${bubbleText(s)}. Open details.`;
  return `<button type="button" class="desk ${s.state}" data-pid="${s.pid}" aria-label="${esc(label)}">
      <div class="bubble"><span>${esc(bubbleText(s))}</span></div>
      ${bot(s)}
      <div class="name">${esc(s.name)}</div>
      <div class="meta"><span>${esc(since)}</span>${s.background ? '<span class="tag">background</span>' : ''}</div>
      ${job}
    </button>
    ${s.helpers.length ? `<div class="helpers" aria-label="Helpers">${s.helpers.map(helperBot).join('')}</div>` : ''}`;
}

function groupRooms() {
  const rooms = new Map();
  for (const s of sessions) {
    if (!rooms.has(s.cwd)) rooms.set(s.cwd, { key: s.cwd, name: s.project, path: s.cwd, list: [] });
    rooms.get(s.cwd).list.push(s);
  }
  const rank = (s) => ORDER.indexOf(s.state);
  const list = [...rooms.values()];
  for (const r of list) r.list.sort((a, b) => rank(a) - rank(b) || (b.stateSince || 0) - (a.stateSince || 0));
  // Rooms keep a stable alphabetical order so nothing jumps around while you watch.
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

function renderHeadline() {
  if (!sessions.length) {
    $('headline').textContent = 'No Claude sessions are open on this Mac right now.';
    return;
  }
  const count = (st) => sessions.filter((s) => s.state === st).length;
  const parts = [];
  if (count('needs-you')) parts.push(`<b class="needs-you">${count('needs-you')} ${count('needs-you') === 1 ? 'needs' : 'need'} you</b>`);
  if (count('working')) parts.push(`<b>${count('working')}</b> working`);
  if (count('done')) parts.push(`<b>${count('done')}</b> just finished`);
  if (count('break')) parts.push(`<b>${count('break')}</b> on a break`);
  if (count('asleep')) {
    const oldest = Math.max(...sessions.filter((s) => s.state === 'asleep').map(quietMs));
    parts.push(`<b>${count('asleep')}</b> asleep (longest: ${span(oldest)})`);
  }
  const helpers = sessions.reduce((n, s) => n + s.helpers.length, 0);
  if (helpers) parts.push(`<b>${helpers}</b> ${helpers === 1 ? 'helper' : 'helpers'} running`);
  $('headline').innerHTML = `${DEMO ? 'Demo data. ' : ''}<b>${sessions.length}</b> ${sessions.length === 1 ? 'session' : 'sessions'} open: ${parts.join(', ')}.`;
  document.title = count('needs-you') ? `(${count('needs-you')}) Agent Office` : 'Agent Office';
}

function renderFloor() {
  const floor = $('floor');
  if (!sessions.length) {
    layoutKey = '';
    floor.innerHTML = '<div class="empty"><b>Nobody\'s in.</b>Start Claude in any terminal and it will take a desk here within a few seconds.</div>';
    fit();
    return;
  }
  const rooms = groupRooms();
  const key = rooms.map((r) => `${r.key}:${r.list.map((s) => s.pid).join(',')}`).join('|');
  if (key !== layoutKey) {
    layoutKey = key;
    floor.innerHTML = rooms.map((r) => `
      <section class="room" style="--h:${hue(r.name)}" aria-label="${esc(r.name)}">
        <div class="room-head"><span class="plate" title="${esc(r.path)}">${esc(r.name)}</span><span class="room-count"></span></div>
        <div class="desks">${r.list.map((s) => `<div class="station" data-station="${s.pid}"></div>`).join('')}</div>
      </section>`).join('');
  }
  const roomEls = floor.querySelectorAll('.room');
  let changed = false;
  rooms.forEach((r, i) => {
    roomEls[i].querySelector('.room-count').textContent = `${r.list.length} ${r.list.length === 1 ? 'desk' : 'desks'}`;
    for (const s of r.list) {
      const el = floor.querySelector(`[data-station="${s.pid}"]`);
      const html = stationHtml(s);
      if (el.dataset.html === html) continue; // untouched desks keep their animation and focus
      const hadFocus = el.contains(document.activeElement);
      el.dataset.html = html;
      el.innerHTML = html;
      changed = true;
      if (hadFocus) el.querySelector('.desk').focus();
    }
  });
  if (changed) fit();
}

// Scale the whole floor plan so every room is visible at once. Tries several plan widths (which changes how
// rooms wrap) and keeps the one that ends up largest on screen.
function fit() {
  const stage = $('stage');
  const floor = $('floor');
  const aw = stage.clientWidth;
  const ah = stage.clientHeight;
  if (!aw || !ah) return;
  let best = null;
  for (let w = 400; w <= 3000; w += 80) {
    floor.style.width = `${w}px`;
    const fw = Math.max(w, floor.scrollWidth);
    const fh = floor.offsetHeight;
    const scale = Math.min(aw / fw, ah / fh, 1.6);
    if (!best || scale > best.scale + 0.001) best = { w, fw, fh, scale };
  }
  floor.style.width = `${best.w}px`;
  // Below this the labels stop being readable, so let the page scroll instead of shrinking further.
  const scale = Math.max(best.scale, 0.5);
  stage.classList.toggle('scrolls', best.scale < 0.5);
  const x = Math.max(0, (aw - best.fw * scale) / 2);
  const y = Math.max(0, (ah - best.fh * scale) / 2);
  floor.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}


// ---- Detail card ----

function cardHtml(s, gone) {
  const facts = [
    ['Project', s.cwd],
    ['Opened', `${clock(s.startedAt)} (${span(now - (s.startedAt || now))} ago)`],
    [s.state === 'working' ? 'Working since' : 'Idle since', `${clock(s.stateSince)} (${span(quietMs(s))})`],
    ['Where', s.background ? 'Background session, no terminal tab' : s.terminal ? `${s.terminal.name} on ${s.tty}` : s.tty ? `Unknown terminal on ${s.tty}` : 'Unknown terminal'],
    ['Model', s.model],
    ['Branch', s.branch && s.branch !== 'HEAD' ? s.branch : null],
    ['Process', `pid ${s.pid}`],
  ].filter((f) => f[1]);
  const section = (title, body) => (body ? `<h3>${title}</h3>${body}` : '');
  return `
    <div class="card-top">
      <div>
        <h2 id="card-name">${esc(s.name)}</h2>
        <div class="state"><i class="dot ${gone ? 'asleep' : s.state}"></i>${gone ? 'Session ended' : esc(STATE_WORDS[s.state])}${!gone && s.state === 'working' && s.current ? `: ${esc(s.current.label)}` : ''}</div>
        ${s.formerNames.length ? `<div class="aka">Earlier called: ${esc(s.formerNames.join(', '))}</div>` : ''}
      </div>
      <button type="button" class="x" data-act="close" aria-label="Close">✕</button>
    </div>
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${section('Waiting for', s.waitingFor ? `<p class="quote">${esc(s.waitingFor)}</p>` : '')}
    ${section('Where it left off', s.awaySummary && s.state !== 'working' ? `<p>${esc(s.awaySummary)}</p>` : '')}
    ${section('Your last message', s.lastPrompt ? `<p class="quote">${esc(s.lastPrompt)}</p>` : '')}
    ${section('Its last reply', s.lastText ? `<p class="quote">${esc(s.lastText)}</p>` : '')}
    ${section('Still running in the background', s.jobs.length ? `<ul class="log">${s.jobs.map((j) => `<li><time>${span(j.elapsedSec * 1000)}</time><span class="cmd">${esc(j.command)}</span></li>`).join('')}</ul>` : '')}
    ${section('Helpers at work', s.helpers.length ? `<ul class="log">${s.helpers.map((h) => `<li><time>${esc(h.type)}</time><span>${esc(h.task)}. ${esc(h.doing)}</span></li>`).join('')}</ul>` : '')}
    ${section('Last things it did', s.recent.length ? `<ul class="log">${s.recent.map((a) => `<li><time>${clock(a.ts)}</time><span>${esc(a.label)}</span></li>`).join('')}</ul>` : '')}
    ${s.helpersDoneToday ? `<p class="aka">${s.helpersDoneToday} ${s.helpersDoneToday === 1 ? 'helper' : 'helpers'} finished and went home today.</p>` : ''}
    <h3>To reopen it after quitting</h3>
    <div class="cmd" id="resume-cmd">${esc(s.resumeCommand)}</div>`;
}

function renderActions(gone) {
  const s = openSnapshot;
  if (gone) {
    $('card-actions').innerHTML = '<button type="button" class="btn" data-act="copy">Copy resume command</button><span class="spacer"></span><button type="button" class="btn" data-act="close">Close</button>';
    return;
  }
  if (confirming) {
    const jobs = s.jobs.length ? ` This also stops what it left running (${esc(jobLabel(s.jobs[0].command))}${s.jobs.length > 1 ? ' and more' : ''}).` : '';
    const busy = s.state === 'working' ? ' It is in the middle of working, so the current step will be cut off.' : '';
    $('card-actions').innerHTML = `<div class="confirm">
        <p>Quit “${esc(s.name)}”? The conversation stays saved and you can reopen it with the command above.${busy}${jobs}</p>
        <div><button type="button" class="btn danger" data-act="quit-yes">Quit session</button><button type="button" class="btn" data-act="quit-no">Keep it open</button></div>
      </div>`;
    return;
  }
  const canFocus = s.terminal && !s.background;
  $('card-actions').innerHTML = `
    ${canFocus ? '<button type="button" class="btn primary" data-act="focus">Go to its terminal</button>' : ''}
    <button type="button" class="btn" data-act="copy">Copy resume command</button>
    <span class="spacer"></span>
    <button type="button" class="btn danger" data-act="quit">Quit session…</button>`;
}

function renderCard() {
  if (openPid === null) return;
  const live = sessions.find((s) => s.pid === openPid);
  if (live) openSnapshot = live;
  const gone = !live;
  const html = cardHtml(openSnapshot, gone);
  const body = $('card-body');
  if (body.dataset.html !== html) {
    body.dataset.html = html;
    body.innerHTML = html;
  }
  const mode = `${gone}:${confirming}:${openSnapshot.jobs.length}:${openSnapshot.state === 'working'}`;
  if ($('card-actions').dataset.mode !== mode) {
    $('card-actions').dataset.mode = mode;
    renderActions(gone);
  }
}

function openCard(pid) {
  openPid = pid;
  openSnapshot = sessions.find((s) => s.pid === pid) || null;
  if (!openSnapshot) return;
  confirming = false;
  $('card-note').textContent = '';
  $('card-body').dataset.html = '';
  $('card-actions').dataset.mode = '';
  renderCard();
  if (!$('card').open) $('card').showModal();
}

async function post(action, pid) {
  try {
    const res = await fetch(`/api/office/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Office': '1' },
      body: JSON.stringify({ pid }),
    });
    return await res.json();
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

async function onCardClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const note = $('card-note');
  if (act === 'close') return $('card').close();
  if (act === 'copy') {
    try {
      await navigator.clipboard.writeText(openSnapshot.resumeCommand);
      note.textContent = 'Copied. Run it in a terminal once this session is closed.';
    } catch {
      note.textContent = 'Couldn\'t copy. Select the command above and copy it by hand.';
    }
    return;
  }
  if (DEMO && act === 'quit-yes') {
    confirming = false;
    note.textContent = 'This is demo data, so there is no real session to act on.';
    return renderCard();
  }
  if (act === 'focus') {
    note.textContent = (await goToTerminal(openPid)) || 'Its terminal is now in front.';
    return;
  }
  if (act === 'quit' || act === 'quit-no') {
    confirming = act === 'quit';
    note.textContent = '';
    return renderCard();
  }
  if (act === 'quit-yes') {
    btn.disabled = true;
    const r = await post('quit', openPid);
    confirming = false;
    note.textContent = r.ok || r.reason === 'gone'
      ? 'Session closed. Its desk will clear in a moment; the resume command above brings it back.'
      : `Couldn't quit it (${r.reason}). Close it from its terminal instead.`;
    await refresh();
  }
}

// ---- Wiring ----

async function refresh() {
  try {
    const res = await fetch(`/api/office${DEMO}`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    sessions = data.sessions;
    now = data.now;
    $('live').classList.remove('off');
    $('live-text').textContent = 'Live';
  } catch {
    $('live').classList.add('off');
    $('live-text').textContent = 'Lost contact with the server';
    return;
  }
  renderHeadline();
  renderFloor();
  renderCard();
}

function applyTheme() {
  let theme = '';
  try { theme = localStorage.getItem('office-theme') || ''; } catch {}
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('theme').textContent = dark ? 'Light mode' : 'Dark mode';
}

$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  try { localStorage.setItem('office-theme', dark ? 'light' : 'dark'); } catch {}
  applyTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

let toastTimer = null;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}

// Bring a session's terminal tab to the front. Returns a sentence to show when that did not fully work.
async function goToTerminal(pid) {
  const s = sessions.find((x) => x.pid === pid);
  const name = s ? `“${s.name}”` : 'This session';
  if (DEMO) return 'This is demo data, so there is no real terminal to open.';
  if (s && s.background) return `${name} runs in the background and has no terminal tab. Open its desk for the resume command.`;
  if (s && !s.terminal) return `Couldn't tell which app ${name} runs in, so there is no tab to bring forward.`;
  const r = await post('focus', pid);
  if (r.ok && r.level === 'app') return `${r.app} is in front, but it can't be asked for one tab. Look for the one running ${name}.`;
  if (r.ok && r.level === 'pane') return 'Switched tmux to its pane, but couldn\'t tell which app is showing that tmux.';
  if (r.ok) return '';
  switch (r.reason) {
    case 'gone': return 'This session has already ended.';
    case 'no-terminal': return `${name} isn't running in a terminal window.`;
    case 'not-found': return `Couldn't find its tab in ${r.app}.`;
    case 'permission': return `macOS doesn't allow controlling ${r.app}. Turn it on in System Settings › Privacy & Security › Automation, then try again.`;
    case 'timeout': return `${r.app} didn't answer. If macOS is asking for permission to control it, allow it and try again.`;
    case 'detached': return `It runs in a tmux session no terminal is attached to. Attach with: tmux attach -t '${r.session.replace(/'/g, "'\\''")}'`;
    default: return `Couldn't bring ${r.app || 'its terminal'} to the front.`;
  }
}

$('floor').addEventListener('click', async (e) => {
  const desk = e.target.closest('.desk');
  if (!desk) return;
  const pid = Number(desk.dataset.pid);
  if (e.target.closest('.computer')) {
    const problem = await goToTerminal(pid);
    if (problem) toast(problem);
    return;
  }
  openCard(pid);
});
$('card').addEventListener('click', (e) => {
  if (e.target === $('card')) $('card').close(); // click on the backdrop
  else onCardClick(e);
});
$('card').addEventListener('close', () => { openPid = null; confirming = false; });

if (DEMO) document.querySelector('.top-actions a').href = '/?demo=1';
applyTheme();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
addEventListener('resize', fit);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
