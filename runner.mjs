#!/usr/bin/env node
// Vikunja follow-up runner
// Receives Vikunja `task.updated` webhooks, and when a task is marked done and has an
// "On completion" section, runs a locked-down headless Claude Code session to carry it out.
// No dependencies beyond Node 22.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ---------- config ----------
const env = (k, d) => (process.env[k] ?? d);
const CFG = {
  host: env('LISTEN_HOST', '0.0.0.0'),
  port: Number(env('LISTEN_PORT', '8790')),
  webhookPath: env('WEBHOOK_PATH', '/vikunja'),
  secret: env('WEBHOOK_SECRET', ''),
  allowedSources: env('ALLOWED_SOURCES', '').split(',').map(s => s.trim()).filter(Boolean),
  stateDir: env('STATE_DIR', '/var/lib/followup-runner'),
  claudeBin: env('CLAUDE_BIN', 'claude'),
  model: env('CLAUDE_MODEL', ''),
  maxBudgetUsd: env('MAX_BUDGET_USD', '1.00'),
  maxRunsPerDay: Number(env('MAX_RUNS_PER_DAY', '10')),
  runTimeoutMin: Number(env('RUN_TIMEOUT_MIN', '15')),
  tasksMcpUrl: env('TASKS_MCP_URL', 'https://tasks.local.kf11-home.uk/api/v2/mcp'),
  tasksMcpToken: env('TASKS_MCP_TOKEN', ''),
  outlineMcpUrl: env('OUTLINE_MCP_URL', 'https://outline.local.kf11-home.uk/mcp'),
  outlineMcpToken: env('OUTLINE_MCP_TOKEN', ''),
  notifyUrl: env('NOTIFY_URL', ''),
  dryRun: env('DRY_RUN', '') === '1',
};
const MAX_BODY = 1024 * 1024; // 1 MB

function log(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg, ...(extra || {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

// ---------- state ----------
fs.mkdirSync(CFG.stateDir, { recursive: true, mode: 0o700 });
const STATE_FILE = path.join(CFG.stateDir, 'state.json');
const WORK_DIR = path.join(CFG.stateDir, 'work');
fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { handled: {}, runsByDay: {} }; }
}
function saveState(s) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}
let state = loadState();
const today = () => new Date().toISOString().slice(0, 10);

// ---------- helpers ----------
function verifySignature(raw, header) {
  if (!CFG.secret) return false;               // refuse to run unsigned
  if (!header || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const expected = crypto.createHmac('sha256', CFG.secret).update(raw).digest();
  const given = Buffer.from(header, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Returns the text after the "On completion" heading, or null if absent/"none".
export function extractOnCompletion(description) {
  const text = htmlToText(description);
  const m = text.match(/(?:^|\n)\s*#*\s*on completion\s*:?\s*\n?([\s\S]*)$/i);
  if (!m) return null;
  const body = m[1].trim();
  if (!body || /^none\.?$/i.test(body)) return null;
  return body;
}

async function notify(title, message) {
  if (!CFG.notifyUrl) return;
  try {
    await fetch(CFG.notifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { log('error', 'notify failed', { err: String(e) }); }
}

// ---------- the Claude run ----------
function buildPrompt(task, followUp) {
  const tpl = fs.readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');
  return tpl
    .replaceAll('{{TASK_ID}}', String(task.id))
    .replaceAll('{{TASK_IDENTIFIER}}', task.identifier || `#${task.id}`)
    .replaceAll('{{TASK_TITLE}}', task.title || '')
    .replaceAll('{{FOLLOW_UP}}', followUp);
}

function writeMcpConfig() {
  const cfg = {
    mcpServers: {
      tasks: { type: 'http', url: CFG.tasksMcpUrl, headers: { Authorization: `Bearer ${CFG.tasksMcpToken}` } },
      outline: { type: 'http', url: CFG.outlineMcpUrl, headers: { Authorization: `Bearer ${CFG.outlineMcpToken}` } },
    },
  };
  const file = path.join(CFG.stateDir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
  return file;
}

function runClaude(prompt) {
  const args = [
    '-p', prompt,
    '--mcp-config', writeMcpConfig(),
    '--strict-mcp-config',            // ignore any other MCP config on the box
    '--restricted',                   // ignore user/project settings files (no stray hooks)
    '--tools', '',                    // no built-in tools: no shell, files or web
    '--allowedTools', 'mcp__tasks', 'mcp__outline',
    '--permission-mode', 'dontAsk',   // anything not allowed above is refused
    '--permission-prompts', 'none',
    '--max-budget-usd', String(CFG.maxBudgetUsd),
    '--no-session-persistence',
    '--output-format', 'json',
  ];
  if (CFG.model) args.push('--model', CFG.model);

  return new Promise((resolve) => {
    const child = spawn(CFG.claudeBin, args, { cwd: WORK_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGINT'); setTimeout(() => child.kill('SIGTERM'), 15_000); },
      CFG.runTimeoutMin * 60_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let result = null;
      try { result = JSON.parse(out); } catch { /* not json */ }
      resolve({ code, signal, result, stdout: out.slice(-4000), stderr: err.slice(-4000) });
    });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, error: String(e), stdout: '', stderr: '' }); });
  });
}

// ---------- queue (one job at a time) ----------
const queue = [];
let busy = false;

function enqueue(job) {
  if (queue.some(j => j.task.id === job.task.id)) return;
  queue.push(job);
  pump();
}

async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  const { task, followUp } = job;
  const label = task.identifier || `#${task.id}`;
  try {
    if (CFG.dryRun) {
      // Leave the cap and handled state alone so the task still runs once DRY_RUN is off
      log('info', 'dry run: would call claude', { task: label, followUp });
      return;
    }
    const day = today();
    const used = state.runsByDay[day] || 0;
    if (used >= CFG.maxRunsPerDay) {
      log('warn', 'daily cap reached, skipping', { task: label, used });
      await notify('Follow-up runner: daily cap reached',
        `${label} "${task.title}" was not followed up (${used}/${CFG.maxRunsPerDay} runs today). Run it by hand or raise MAX_RUNS_PER_DAY.`);
      return; // not marked handled, so a later re-trigger can still run it
    }
    state.runsByDay = { [day]: used + 1 }; // keep only today
    state.handled[task.id] = { at: new Date().toISOString(), status: 'running', identifier: label };
    saveState(state);

    log('info', 'running follow-up', { task: label });
    const r = await runClaude(buildPrompt(task, followUp));
    const ok = r.code === 0 && r.result && !r.result.is_error;
    const cost = r.result?.total_cost_usd;
    const summary = (r.result?.result || r.error || r.stderr || 'no output').toString().slice(0, 600);
    state.handled[task.id] = { ...state.handled[task.id], status: ok ? 'done' : 'failed', exit: r.code, cost };
    saveState(state);
    log(ok ? 'info' : 'error', 'follow-up finished', { task: label, exit: r.code, signal: r.signal, cost, summary });
    await notify(ok ? `Follow-up done: ${label}` : `Follow-up FAILED: ${label}`,
      `${task.title}\n${ok ? '' : `exit ${r.code}${r.signal ? ' ' + r.signal : ''}\n`}${summary}`);
  } catch (e) {
    log('error', 'job crashed', { task: label, err: String(e) });
  } finally {
    busy = false;
    setImmediate(pump);
  }
}

// ---------- webhook handling ----------
export function decide(payload, handled) {
  if (payload?.event_name !== 'task.updated') return { act: false, why: 'not task.updated' };
  const task = payload?.data?.task;
  if (!task?.id) return { act: false, why: 'no task' };
  if (!task.done) return { act: false, why: 'not done' };
  if (handled[task.id]) return { act: false, why: 'already handled' };
  const followUp = extractOnCompletion(task.description);
  if (!followUp) return { act: false, why: 'no On completion section' };
  return { act: true, task, followUp };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, busy, queued: queue.length, runsToday: state.runsByDay[today()] || 0 }));
  }
  if (req.method !== 'POST' || req.url !== CFG.webhookPath) { res.writeHead(404); return res.end(); }

  const src = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  if (CFG.allowedSources.length && !CFG.allowedSources.includes(src)) {
    log('warn', 'rejected source', { src }); res.writeHead(403); return res.end();
  }

  const chunks = []; let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { res.writeHead(413); res.end(); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    const raw = Buffer.concat(chunks);
    if (!verifySignature(raw, req.headers['x-vikunja-signature'])) {
      log('warn', 'bad signature', { src }); res.writeHead(401); return res.end();
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { res.writeHead(400); return res.end(); }

    res.writeHead(202); res.end(); // answer fast; Vikunja has a short timeout

    const d = decide(payload, state.handled);
    if (!d.act) { log('debug', 'ignored', { task: payload?.data?.task?.id, why: d.why }); return; }
    enqueue({ task: d.task, followUp: d.followUp });
  });
});

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  for (const k of ['WEBHOOK_SECRET', 'TASKS_MCP_TOKEN', 'OUTLINE_MCP_TOKEN']) {
    if (!process.env[k] && !CFG.dryRun) { log('error', `missing ${k}`); process.exit(1); }
  }
  if (!CFG.secret) { log('error', 'WEBHOOK_SECRET is required'); process.exit(1); }
  server.listen(CFG.port, CFG.host, () => log('info', 'listening', { host: CFG.host, port: CFG.port, path: CFG.webhookPath, dryRun: CFG.dryRun }));
}
