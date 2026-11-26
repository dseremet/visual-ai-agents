// Live picture of the Claude Code sessions open on this machine, for the office page.
// Sources: ~/.claude/sessions/<pid>.json (what each running process says about itself), `ps` (is it really
// alive, which terminal, what it left running) and the tail of each transcript (what it is doing).
// Reads only, except focus() which raises the session's terminal tab and quit() which sends SIGTERM to one session.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { encodeCwd, ROOT } = require('./scan');
const terminals = require('./terminals');

const HOME = os.homedir();
const SESSIONS_DIR = process.env.CLAUDE_SESSIONS_DIR || path.join(HOME, '.claude', 'sessions');
const TAIL_BYTES = 400 * 1024;
const HELPER_TAIL_BYTES = 64 * 1024;
const HELPER_ACTIVE_MS = 10 * 60 * 1000; // a helper that wrote nothing for this long is treated as gone

const tailCache = new Map(); // file -> { stamp, data }
const transcriptPaths = new Map(); // sessionId -> file

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// "08-03:54:59" | "22:39:31" | "02:44" -> seconds
function etimeSeconds(s) {
  const [rest, days] = s.includes('-') ? s.split('-').reverse() : [s, '0'];
  const p = rest.split(':').map(Number);
  while (p.length < 3) p.unshift(0);
  return Number(days) * 86400 + p[0] * 3600 + p[1] * 60 + p[2];
}

async function processTable() {
  const out = await run('ps', ['-axwwo', 'pid=,ppid=,tty=,etime=,command=']);
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], elapsed: etimeSeconds(m[4]), command: m[5] });
  }
  return procs;
}

function isClaude(proc) {
  return !!proc && path.basename(proc.command.split(' ')[0]) === 'claude';
}

// Shell commands a session started and that are still alive (a dev server, a long import).
function jobsOf(pid, procs) {
  const jobs = [];
  for (const p of procs.values()) {
    if (p.ppid !== pid) continue;
    const m = p.command.match(/ eval '(.*)' < \/dev\/null/s);
    if (!m) continue;
    jobs.push({ pid: p.pid, command: m[1].replace(/'\\''/g, "'").replace(/\s+/g, ' ').trim().slice(0, 300), elapsedSec: p.elapsed });
  }
  return jobs.sort((a, b) => b.elapsedSec - a.elapsedSec);
}

function short(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const base = (p) => (p ? path.basename(String(p)) : 'a file');

// One tool call -> a pose for the character and a plain sentence for its speech bubble.
function describeTool(name, input = {}) {
  switch (name) {
    case 'Edit': case 'Write': case 'NotebookEdit':
      return { kind: 'edit', label: `Editing ${base(input.file_path || input.notebook_path)}` };
    case 'Read':
      return { kind: 'read', label: `Reading ${base(input.file_path)}` };
    case 'Grep': case 'Glob':
      return { kind: 'search', label: `Searching for ${short(input.pattern, 40)}` };
    case 'Bash':
      return { kind: 'run', label: short(input.description || input.command, 80) || 'Running a command' };
    case 'Agent': case 'Task':
      return { kind: 'delegate', label: `Briefing a helper: ${short(input.description, 60)}` };
    case 'Workflow':
      return { kind: 'delegate', label: 'Running a team of helpers' };
    case 'WebSearch':
      return { kind: 'web', label: `Searching the web: ${short(input.query, 50)}` };
    case 'WebFetch':
      return { kind: 'web', label: 'Reading a web page' };
    case 'AskUserQuestion':
      return { kind: 'ask', label: 'Asking you a question' };
    case 'ExitPlanMode':
      return { kind: 'ask', label: 'Showing you its plan' };
    case 'Skill':
      return { kind: 'read', label: `Following the ${short(input.skill, 40)} playbook` };
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate':
      return { kind: 'edit', label: 'Updating its to-do list' };
    case 'Artifact':
      return { kind: 'edit', label: 'Publishing a page' };
    case 'ToolSearch':
      return { kind: 'search', label: 'Looking for the right tool' };
    default: {
      const mcp = name.match(/^mcp__(.+?)__(.+)$/);
      if (mcp) {
        // "plugin_playwright_playwright" -> "playwright"
        const server = [...new Set(mcp[1].replace(/^(claude_ai_|plugin_)/, '').split('_'))].join(' ');
        const kind = /chrome|playwright|browser/i.test(server) ? 'web' : 'run';
        return { kind, label: `Using ${short(server, 30)}: ${mcp[2].replace(/_/g, ' ')}` };
      }
      return { kind: 'run', label: `Using ${name}` };
    }
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
  return '';
}

function isRealPrompt(text) {
  const t = text.trim();
  return t && !t.startsWith('<') && !t.startsWith('[Request interrupted');
}

// Parse the last `bytes` of a transcript. Cached until the file changes.
async function readTail(file, bytes) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return null;
  }
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = tailCache.get(file);
  if (hit && hit.stamp === stamp) return hit.data;

  const start = Math.max(0, st.size - bytes);
  const fh = await fsp.open(file, 'r');
  let text;
  try {
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } finally {
    await fh.close();
  }
  const lines = text.split('\n');
  if (start > 0) lines.shift(); // first line is cut off mid-record

  const data = { mtimeMs: st.mtimeMs, actions: [], pending: null, lastText: null, lastPrompt: null, awaySummary: null, model: null, branch: null, permissionMode: null };
  const open = new Map(); // tool_use id -> action, until its result arrives
  let storedPrompt = null;
  for (const line of lines) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.gitBranch) data.branch = d.gitBranch;
    if (d.type === 'last-prompt' && d.lastPrompt) storedPrompt = d.lastPrompt;
    else if (d.type === 'permission-mode') data.permissionMode = d.permissionMode || null;
    else if (d.type === 'system' && d.subtype === 'away_summary' && typeof d.content === 'string') data.awaySummary = short(d.content, 600);
    else if (d.type === 'assistant' && d.message) {
      if (d.message.model && d.message.model !== '<synthetic>') data.model = d.message.model;
      for (const b of Array.isArray(d.message.content) ? d.message.content : []) {
        if (b.type === 'text' && b.text && b.text.trim()) data.lastText = short(b.text, 500);
        else if (b.type === 'tool_use') {
          const a = { ts: d.timestamp || null, tool: b.name, ...describeTool(b.name, b.input) };
          data.actions.push(a);
          open.set(b.id, a);
        }
      }
    } else if (d.type === 'user' && d.message) {
      const c = d.message.content;
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result') open.delete(b.tool_use_id);
      const t = textOf(c);
      if (!d.isMeta && !d.isSidechain && isRealPrompt(t)) {
        data.lastPrompt = short(t, 400);
        storedPrompt = null; // a prompt seen in the tail is newer than an earlier stored one
      }
    }
  }
  if (storedPrompt) data.lastPrompt = short(storedPrompt, 400);
  data.pending = [...open.values()].pop() || null;
  data.actions = data.actions.slice(-10);
  tailCache.set(file, { stamp, data });
  return data;
}

async function findTranscript(sessionId, cwd) {
  const known = transcriptPaths.get(sessionId);
  if (known) return known;
  const guess = path.join(ROOT, encodeCwd(cwd), `${sessionId}.jsonl`);
  let found = fs.existsSync(guess) ? guess : null;
  if (!found) {
    for (const dir of await fsp.readdir(ROOT).catch(() => [])) {
      const f = path.join(ROOT, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) { found = f; break; }
    }
  }
  if (found) transcriptPaths.set(sessionId, found);
  return found;
}

// Subagents of a session: the ones still working, and how many finished today.
async function helpersOf(transcript, now) {
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  const active = [];
  let doneToday = 0;
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (!name.endsWith('.meta.json')) continue;
    const log = path.join(dir, name.replace(/\.meta\.json$/, '.jsonl'));
    let st, meta;
    try {
      st = await fsp.stat(log);
      meta = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const quiet = now - st.mtimeMs;
    if (meta.finished || quiet > HELPER_ACTIVE_MS) {
      if (st.mtimeMs >= midnight) doneToday++;
      continue;
    }
    const tail = await readTail(log, HELPER_TAIL_BYTES);
    const last = tail && (tail.pending || tail.actions[tail.actions.length - 1]);
    active.push({
      id: name.replace(/^agent-|\.meta\.json$/g, ''),
      type: meta.agentType || 'helper',
      task: short(meta.description, 80),
      doing: last ? last.label : 'Thinking',
      kind: last ? last.kind : 'think',
      quietSec: Math.round(quiet / 1000),
    });
  }
  return { active, doneToday };
}

async function readRegistry() {
  const out = [];
  for (const name of await fsp.readdir(SESSIONS_DIR).catch(() => [])) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const d = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, name), 'utf8'));
      if (Number.isInteger(d.pid) && d.sessionId) out.push(d);
    } catch {}
  }
  return out;
}

const displayPath = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// working: mid-turn. needs-you: blocked on an answer or a permission. Otherwise it finished its turn and is
// waiting for the next prompt, and how long ago decides whether it is fresh, on a break or asleep.
function stateOf(reg, now) {
  if (reg.status === 'busy') return 'working';
  if (reg.status === 'waiting' || reg.waitingFor) return 'needs-you';
  const quiet = now - (reg.statusUpdatedAt || reg.updatedAt || reg.startedAt || now);
  if (quiet < 30 * 60 * 1000) return 'done';
  if (quiet < 24 * 3600 * 1000) return 'break';
  return 'asleep';
}

async function snapshot() {
  const now = Date.now();
  const [procs, registry] = await Promise.all([processTable(), readRegistry()]);
  const sessions = [];
  for (const reg of registry) {
    const proc = procs.get(reg.pid);
    if (!isClaude(proc)) continue; // stale file from a process that is gone
    const transcript = await findTranscript(reg.sessionId, reg.cwd);
    const tail = transcript ? await readTail(transcript, TAIL_BYTES) : null;
    const helpers = transcript ? await helpersOf(transcript, now) : { active: [], doneToday: 0 };
    const state = stateOf(reg, now);
    const lastAction = tail && tail.actions[tail.actions.length - 1];
    let current = null;
    if (state === 'working') current = (tail && tail.pending) || { kind: 'think', label: 'Thinking' };
    sessions.push({
      pid: reg.pid,
      sessionId: reg.sessionId,
      name: reg.name || path.basename(reg.cwd || '') || 'Unnamed session',
      formerNames: (reg.formerNames || []).map((f) => f.name).filter(Boolean).slice(-5),
      cwd: displayPath(reg.cwd),
      project: path.basename(reg.cwd || '') || 'somewhere',
      background: reg.kind && reg.kind !== 'interactive',
      status: reg.status || 'unknown',
      waitingFor: reg.waitingFor ? short(reg.waitingFor, 200) : null,
      state,
      startedAt: reg.startedAt || null,
      stateSince: reg.statusUpdatedAt || reg.updatedAt || null,
      tty: /^ttys\d+$/.test(proc.tty) ? proc.tty : null,
      terminal: terminalOf(reg.pid, proc, procs),
      version: reg.version || null,
      model: tail ? tail.model : null,
      branch: tail ? tail.branch : null,
      permissionMode: tail ? tail.permissionMode : null,
      lastPrompt: tail ? tail.lastPrompt : null,
      lastText: tail ? tail.lastText : null,
      awaySummary: tail ? tail.awaySummary : null,
      current,
      lastAction: lastAction || null,
      recent: tail ? tail.actions.slice().reverse() : [],
      jobs: jobsOf(reg.pid, procs).filter((j) => state !== 'working' || j.elapsedSec > 60),
      helpers: helpers.active,
      helpersDoneToday: helpers.doneToday,
      resumeCommand: `cd ${shellQuote(reg.cwd)} && claude --resume ${reg.sessionId}`,
    });
  }
  return { now, sessions };
}

// A pid is only acted on if it is a registered session and the process is still a claude process.
async function liveSession(pid) {
  if (!Number.isInteger(pid)) return null;
  const [procs, registry] = await Promise.all([processTable(), readRegistry()]);
  const reg = registry.find((r) => r.pid === pid);
  const proc = procs.get(pid);
  return reg && isClaude(proc) ? { reg, proc, procs } : null;
}

// The app that shows this session's terminal, for the page: { id, name } or null.
function terminalOf(pid, proc, procs) {
  if (!/^ttys\d+$/.test(proc.tty)) return null;
  const host = terminals.hostOf(pid, procs);
  return host && { id: host.id, name: host.name };
}

// Bring the terminal tab that hosts this session to the front.
async function focus(pid) {
  const s = await liveSession(pid);
  if (!s) return { ok: false, reason: 'gone' };
  const host = /^ttys\d+$/.test(s.proc.tty) && terminals.hostOf(pid, s.procs);
  if (!host) return { ok: false, reason: 'no-terminal' };
  const { detail, ...result } = await terminals.focus(host, s.proc.tty, s.procs);
  if (detail) console.error(`office: focus pid ${pid} in ${result.app} failed: ${detail}`);
  return result;
}

async function quit(pid) {
  const s = await liveSession(pid);
  if (!s) return { ok: false, reason: 'gone' };
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, reason: String(err.code || err.message) };
  }
  return { ok: true };
}

module.exports = { snapshot, focus, quit };
