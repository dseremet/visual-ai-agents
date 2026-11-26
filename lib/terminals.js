// Which app a session's terminal lives in, and how to bring its tab to the front.
// The app is found by walking up the process tree from the session, so every session is matched to its
// own terminal even when several terminal apps are in use at once.
// Terminal.app and iTerm2 are asked for the exact tab by tty. tmux is asked for the pane, and then the
// terminal showing the tmux client is focused the same way. Any other app is only brought to the front,
// because it offers no way to pick one tab from outside.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Terminals that can be asked for one tab, keyed by app bundle name.
const KNOWN = {
  'Terminal.app': { id: 'terminal', name: 'Terminal' },
  'iTerm.app': { id: 'iterm2', name: 'iTerm2' },
  'iTerm2.app': { id: 'iterm2', name: 'iTerm2' },
};
// Apps that host Claude sessions without a terminal window of their own.
const NOT_TERMINALS = new Set(['Claude.app', 'ClaudeCode.app']);
const TMUX_PATHS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/opt/local/bin/tmux', '/usr/bin/tmux'];

function exec(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({
      ok: !err,
      out: String(stdout || '').trim(),
      err: String(stderr || (err && err.message) || '').trim(),
      timedOut: !!(err && err.killed),
    }));
  });
}

const isTmux = (proc) => path.basename(proc.command.split(' ')[0]) === 'tmux';

// Walk up from a process to whatever draws its terminal: { id, name, ... } or null (a background
// session, ssh, a process started by launchd).
function hostOf(pid, procs) {
  const seen = new Set();
  for (let p = procs.get(pid); p && p.pid > 1 && !seen.has(p.pid); p = procs.get(p.ppid)) {
    seen.add(p.pid);
    if (isTmux(p)) return { id: 'tmux', name: 'tmux', server: p };
    // iTerm2 keeps its shells under a helper that can outlive the app itself.
    if (/^\/.*\/iTerm2\/iTermServer-[\w.]+(\s|$)/.test(p.command)) return { ...KNOWN['iTerm.app'] };
    // The outermost bundle of the executable. Spaces are allowed in the path ("Visual Studio Code.app"),
    // but not a space before "-" or "/", which would already be an argument.
    const bundle = p.command.match(/^(\/(?:[^ ]| (?![-/]))*?\.app)\/Contents\//);
    if (!bundle) continue;
    const app = path.basename(bundle[1]);
    if (NOT_TERMINALS.has(app)) return null;
    return KNOWN[app] ? { ...KNOWN[app] } : { id: 'app', name: app.replace(/\.app$/, ''), app: bundle[1] };
  }
  return null;
}

// tty is checked against /^ttys\d+$/ before it gets here, so it is safe inside the script.
const SCRIPTS = {
  terminal: (tty) => `
    tell application id "com.apple.Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if tty of t is "/dev/${tty}" then
            if miniaturized of w then set miniaturized of w to false
            set selected of t to true
            set index of w to 1
            activate
            return "ok"
          end if
        end repeat
      end repeat
      return "missing"
    end tell`,
  iterm2: (tty) => `
    tell application id "com.googlecode.iterm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is "/dev/${tty}" then
              if miniaturized of w then set miniaturized of w to false
              select t
              select s
              select w
              activate
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
      return "missing"
    end tell`,
};

async function byScript(host, tty) {
  const r = await exec('osascript', ['-e', SCRIPTS[host.id](tty)]);
  if (r.ok) return r.out === 'ok' ? { ok: true, level: 'tab', app: host.name } : { ok: false, reason: 'not-found', app: host.name };
  // While macOS shows its "allow control" prompt the script just waits, so a timeout usually means that.
  if (r.timedOut) return { ok: false, reason: 'timeout', app: host.name };
  if (/-1743|not authori[sz]ed/i.test(r.err)) return { ok: false, reason: 'permission', app: host.name };
  return { ok: false, reason: 'failed', app: host.name, detail: r.err };
}

async function bringAppForward(host) {
  const r = await exec('open', ['-a', host.app]);
  return r.ok ? { ok: true, level: 'app', app: host.name } : { ok: false, reason: 'failed', app: host.name, detail: r.err };
}

// The socket flags (-L name, -S path) the tmux server was started with, so we talk to the same server.
function tmuxSocketArgs(server) {
  const words = server.command.split(/\s+/).slice(1);
  const args = [];
  for (let i = 0; i < words.length && words[i].startsWith('-'); i++) {
    const m = words[i].match(/^-([LS])(.*)$/);
    if (m) args.push(`-${m[1]}`, m[2] || words[++i]);
    else if (/^-[cfT]$/.test(words[i])) i++; // flags that take a value we don't need
  }
  return args;
}

function tmuxBinary(server) {
  const first = server.command.split(' ')[0];
  if (first.startsWith('/')) return first;
  // An app opened from the Dock gets a short PATH without Homebrew, so look in the usual places.
  return TMUX_PATHS.find((p) => fs.existsSync(p)) || 'tmux';
}

const lines = (out) => out.split('\n').filter(Boolean).map((l) => l.split('\t'));

async function focusTmux(host, tty, procs, depth) {
  const bin = tmuxBinary(host.server);
  const socket = tmuxSocketArgs(host.server);
  const tmux = (...args) => exec(bin, [...socket, ...args], 5000);

  const panes = await tmux('list-panes', '-a', '-F', '#{pane_tty}\t#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}');
  if (!panes.ok) return { ok: false, reason: 'failed', app: 'tmux', detail: panes.err };
  const pane = lines(panes.out).find((f) => f[0] === `/dev/${tty}`);
  if (!pane) return { ok: false, reason: 'not-found', app: 'tmux' };
  const [, sessionId, sessionName, windowId, paneId] = pane;

  // Prefer a client already showing that session, otherwise the one used most recently.
  const clients = (await tmux('list-clients', '-F', '#{client_tty}\t#{session_id}\t#{client_activity}')).out;
  const list = lines(clients).map(([ctty, sid, act]) => ({ tty: ctty, sessionId: sid, activity: Number(act) || 0 }));
  if (!list.length) return { ok: false, reason: 'detached', app: 'tmux', session: sessionName };
  const client = list.find((c) => c.sessionId === sessionId) || list.sort((a, b) => b.activity - a.activity)[0];
  if (client.sessionId !== sessionId) await tmux('switch-client', '-c', client.tty, '-t', sessionId);
  await tmux('select-window', '-t', windowId);
  await tmux('select-pane', '-t', paneId);

  // Now raise the terminal that shows this client.
  const clientTty = client.tty.replace(/^\/dev\//, '');
  // Start above the tmux client itself, which would otherwise be mistaken for a tmux server.
  const onClient = [...procs.values()].filter((p) => p.tty === clientTty);
  const clientProc = onClient.find(isTmux);
  const start = clientProc ? clientProc.ppid : onClient[0] && onClient[0].pid;
  const outer = start && /^ttys\d+$/.test(clientTty) ? hostOf(start, procs) : null;
  if (!outer) return { ok: true, level: 'pane', app: 'tmux' };
  const r = await focus(outer, clientTty, procs, depth + 1);
  return { ...r, app: `tmux in ${r.app}` };
}

// Bring the tab on `tty` (e.g. "ttys004") inside `host` to the front.
// -> { ok: true, level: 'tab' | 'app' | 'pane', app } or { ok: false, reason, app, detail? }
async function focus(host, tty, procs, depth = 0) {
  if (host.id === 'terminal' || host.id === 'iterm2') return byScript(host, tty);
  if (host.id === 'tmux') return depth < 3 ? focusTmux(host, tty, procs, depth) : { ok: false, reason: 'failed', app: 'tmux' };
  return bringAppForward(host);
}

module.exports = { hostOf, focus, tmuxSocketArgs };
