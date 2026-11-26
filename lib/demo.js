// Made-up data for trying the dashboard without real transcripts: open either page with ?demo=1.
// Nothing here is read from disk. The README screenshots are taken in this mode.
const { encodeCwd } = require('./scan');

// Small seeded generator so the demo looks the same on every load.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function demoOffice() {
  const now = Date.now();
  let pid = 4100;
  const make = (project, name, state, quiet, opened, extra = {}) => ({
    pid: pid++,
    sessionId: `demo-${pid}-${name.toLowerCase().replace(/\W+/g, '-')}`,
    name,
    formerNames: [],
    cwd: `~/code/${project}`,
    project,
    background: false,
    status: state === 'working' ? 'busy' : state === 'needs-you' ? 'waiting' : 'idle',
    waitingFor: null,
    state,
    startedAt: now - opened,
    stateSince: now - quiet,
    tty: `ttys0${String(pid % 100).padStart(2, '0')}`,
    terminal: { id: 'terminal', name: 'Terminal' },
    version: null,
    model: 'claude-opus-5-5',
    branch: 'main',
    permissionMode: null,
    lastPrompt: null,
    lastText: null,
    awaySummary: null,
    current: null,
    lastAction: null,
    recent: [],
    jobs: [],
    helpers: [],
    helpersDoneToday: 0,
    resumeCommand: `cd ~/code/${project} && claude --resume 00000000-0000-0000-0000-000000000000`,
    ...extra,
  });
  const did = (minutesAgo, label, kind = 'run') => ({ ts: new Date(now - minutesAgo * MIN).toISOString(), tool: 'Demo', kind, label });

  const sessions = [
    make('bakery-website', 'Opening Hours Banner', 'working', 4 * MIN, 50 * MIN, {
      current: { kind: 'edit', label: 'Editing HoursBanner.vue' },
      lastPrompt: 'Show today\'s opening hours at the top of the home page, and a "closed today" note on holidays.',
      recent: [did(0, 'Editing HoursBanner.vue', 'edit'), did(1, 'Reading holidays.json', 'read'), did(2, 'Searching for opening hours', 'search'), did(3, 'Run the component tests')],
      helpers: [
        { id: 'demo-a1', type: 'Explore', task: 'Find where hours are stored', doing: 'Searching for openingHours', kind: 'search', quietSec: 4 },
        { id: 'demo-a2', type: 'general-purpose', task: 'Write banner tests', doing: 'Editing HoursBanner.test.js', kind: 'edit', quietSec: 9 },
      ],
      helpersDoneToday: 3,
    }),
    make('bakery-website', 'Order Form Validation', 'done', 6 * MIN, 3 * HOUR, {
      lastPrompt: 'The phone field accepts letters. Fix it and add a test.',
      lastText: 'The phone field now accepts only digits, spaces and a leading plus. I added four tests and all 31 pass.',
      recent: [did(6, 'Run the form tests'), did(8, 'Editing OrderForm.vue', 'edit'), did(11, 'Reading OrderForm.vue', 'read')],
    }),
    make('invoice-api', 'PDF Export Timeouts', 'needs-you', 12 * MIN, 2 * HOUR, {
      waitingFor: 'permission to run the database migration',
      lastPrompt: 'Large invoices time out on export. Find out why and fix it.',
      lastText: 'The export loads every line item in one query. I moved it to a background job, which needs a new jobs table.',
      recent: [did(12, 'Create the export jobs table'), did(14, 'Editing ExportInvoice.php', 'edit'), did(20, 'Reading the slow query log', 'read')],
    }),
    make('invoice-api', 'Tax Rate Refactor', 'asleep', 6 * DAY, 7 * DAY, {
      lastPrompt: 'Move the tax rates out of the code and into a settings table.',
      awaySummary: 'Tax rates now come from a settings table and the old constants are gone. The local server is still running so you can check the invoice preview.',
      jobs: [{ pid: 4999, command: 'php artisan serve --port 8010', elapsedSec: 6 * 86400 }],
      recent: [did(6 * 1440, 'Start the local server'), did(6 * 1440 + 3, 'Editing TaxRate.php', 'edit')],
    }),
    make('mobile-app', 'Push Notification Settings', 'working', 11 * MIN, 5 * HOUR, {
      current: { kind: 'run', label: 'Run the iOS build' },
      lastPrompt: 'Add a settings screen where people can mute order updates.',
      recent: [did(0, 'Run the iOS build'), did(2, 'Editing NotificationSettings.tsx', 'edit'), did(5, 'Reading the push service docs', 'web')],
      helpersDoneToday: 1,
    }),
    make('data-pipeline', 'Nightly Import Retry', 'break', 5 * HOUR, 9 * HOUR, {
      lastPrompt: 'When the nightly import fails halfway, make it resume instead of starting over.',
      lastText: 'The import now records the last finished batch and resumes from there. A dry run against yesterday\'s file passed.',
      recent: [did(300, 'Dry-run the import with yesterday\'s file'), did(306, 'Editing import_runner.py', 'edit')],
    }),
    make('data-pipeline', 'Duplicate Rows Report', 'asleep', 2 * DAY, 2 * DAY + 3 * HOUR, {
      lastPrompt: 'How many duplicate customer rows do we have, and where do they come from?',
      awaySummary: 'Found 412 duplicate customer rows, almost all from the March re-import. A cleanup plan is written up and waiting for your go-ahead.',
      recent: [did(2 * 1440, 'Count duplicates per import batch'), did(2 * 1440 + 4, 'Reading the import history', 'read')],
    }),
    make('docs-site', 'Getting Started Rewrite', 'done', 21 * MIN, 26 * HOUR, {
      lastPrompt: 'Rewrite the getting started page so a new user can finish it in five minutes.',
      lastText: 'The page is down from eleven steps to five, with one copy-paste block per step.',
      recent: [did(21, 'Editing getting-started.md', 'edit'), did(30, 'Reading getting-started.md', 'read')],
    }),
  ];
  return { now, demo: true, sessions };
}

// Same shape as scan(): about five weeks of made-up turns across a handful of projects.
function demoScan() {
  const rand = rng(20261125);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (lo, hi) => Math.round(lo + rand() * (hi - lo));
  const projects = [
    { name: 'bakery-website', weight: 0.75, titles: ['Opening Hours Banner', 'Order Form Validation', 'Menu Page Redesign', 'Image Loading Speed'] },
    { name: 'invoice-api', weight: 0.6, titles: ['PDF Export Timeouts', 'Tax Rate Refactor', 'Webhook Signature Check'] },
    { name: 'mobile-app', weight: 0.5, titles: ['Push Notification Settings', 'Offline Cart', 'Login Screen Polish'] },
    { name: 'data-pipeline', weight: 0.35, titles: ['Nightly Import Retry', 'Duplicate Rows Report'] },
    { name: 'docs-site', weight: 0.2, titles: ['Getting Started Rewrite', 'API Reference Cleanup'] },
  ];
  const mainTools = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Glob', 'Agent', 'WebSearch'];
  const turns = [];
  const sessions = {};
  const today = new Date().setHours(0, 0, 0, 0);
  let n = 0;

  for (let day = 34; day >= 0; day--) {
    const weekday = new Date(today - day * DAY).getDay();
    const quietDay = weekday === 0 || weekday === 6;
    for (const p of projects) {
      if (rand() > p.weight * (quietDay ? 0.35 : 1)) continue;
      const cwd = `~/code/${p.name}`;
      for (let s = between(1, 2); s > 0; s--) {
        const sessionId = `demo-${p.name}-${day}-${s}`;
        sessions[sessionId] = { aiTitle: pick(p.titles) };
        const model = rand() < 0.6 ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
        let t = today - day * DAY + between(8, 16) * HOUR;
        let context = between(18000, 40000);
        for (let i = between(12, 70); i > 0; i--) {
          t += between(8, 240) * 1000;
          if (t > Date.now()) break;
          const sub = rand() < 0.18;
          const fresh = between(300, 6000);
          context = Math.min(context + fresh, 180000);
          const tool = rand() < 0.8 ? [pick(sub ? ['Read', 'Grep', 'Glob', 'Bash'] : mainTools)] : [];
          turns.push({
            key: `demo-${n++}`,
            ts: new Date(t).toISOString(),
            projectKey: encodeCwd(cwd),
            cwd,
            sessionId,
            subagent: sub,
            agentType: sub ? pick(['Explore', 'general-purpose']) : 'main',
            branch: 'main',
            model: sub ? 'claude-haiku-5-5' : model,
            speed: 'standard',
            input: between(4, 900),
            output: between(60, 2600),
            cacheWrite5m: fresh,
            cacheWrite1h: 0,
            cacheRead: sub ? between(4000, 30000) : context,
            webSearches: tool[0] === 'WebSearch' ? 1 : 0,
            tools: tool,
          });
        }
      }
    }
  }
  return { turns, sessions, scan: { files: 0, parsed: 0, cached: 0, ms: 0, demo: true } };
}

module.exports = { demoOffice, demoScan };
