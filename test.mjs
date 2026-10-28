// Local test: starts runner.mjs with a fake claude, sends webhooks, checks behaviour.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-'));
const fake = path.join(tmp, 'fake-claude.sh');
const argsLog = path.join(tmp, 'args.log');
fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${argsLog}\necho '{"is_error":false,"result":"did it","total_cost_usd":0.12}'\n`, { mode: 0o755 });
const SECRET = 'test-secret';
const PORT = 18790;

const child = spawn(process.execPath, [path.join(here, 'runner.mjs')], {
  env: { ...process.env, LISTEN_HOST: '127.0.0.1', LISTEN_PORT: String(PORT), WEBHOOK_SECRET: SECRET,
    TASKS_MCP_TOKEN: 't1', OUTLINE_MCP_TOKEN: 'o1', CLAUDE_BIN: fake, STATE_DIR: tmp, MAX_RUNS_PER_DAY: '2' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(500);

const body = (task, ev = 'task.updated') => JSON.stringify({ event_name: ev, time: new Date().toISOString(), data: { task, doer: { id: 2 } } });
const sign = b => crypto.createHmac('sha256', SECRET).update(b).digest('hex');
async function post(b, sig = sign(b)) {
  const r = await fetch(`http://127.0.0.1:${PORT}/vikunja`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Vikunja-Signature': sig } : {}) }, body: b });
  return r.status;
}
const desc = (s) => `<p><strong>Source:</strong> x</p><h2>On completion</h2><p>${s}</p>`;
const results = [];
const check = (name, cond) => { results.push([name, !!cond]); };

check('unsigned rejected', await post(body({ id: 1, done: true, description: desc('do x') }), null) === 401);
check('bad signature rejected', await post(body({ id: 1, done: true, description: desc('do x') }), 'ab'.repeat(32)) === 401);
check('signed accepted', await post(body({ id: 1, identifier: 'HA-9', title: 'T1', done: true, description: desc('Create a page') })) === 202);
await post(body({ id: 2, done: false, description: desc('do y') }));
await post(body({ id: 3, done: true, description: desc('none') }));
await post(body({ id: 4, done: true, description: '<p>no section</p>' }));
await post(body({ id: 5, done: true, description: desc('do z') }, 'task.created'));
await sleep(800);
await post(body({ id: 1, done: true, description: desc('Create a page') })); // duplicate
await post(body({ id: 6, done: true, description: desc('second') }));
await post(body({ id: 7, done: true, description: desc('third, over cap') }));
await sleep(1500);

const st = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
const args = fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8') : '';
const runs = (args.match(/^--no-session-persistence$/gm) || []).length;
check('ran exactly twice (task 1 and 6)', runs === 2);
check('task 1 handled once, status done', st.handled[1]?.status === 'done' && st.handled[1]?.cost === 0.12);
check('not-done / none / no-section / wrong event ignored', !st.handled[2] && !st.handled[3] && !st.handled[4] && !st.handled[5]);
check('over daily cap not run and not marked handled', !st.handled[7] && /daily cap reached/.test(logs));
check('locked-down flags passed', /^--tools\n\n/m.test(args) && /--permission-mode\ndontAsk/.test(args) && /--strict-mcp-config/.test(args) && /--restricted/.test(args) && /--max-budget-usd\n1.00/.test(args));
check('prompt contains follow-up text', /Create a page/.test(args) && /HA-9/.test(args));
const mcp = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
check('mcp.json has both servers, mode 600', mcp.mcpServers.tasks && mcp.mcpServers.outline && (fs.statSync(path.join(tmp, 'mcp.json')).mode & 0o777) === 0o600);
const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
check('health endpoint', h.ok === true && h.runsToday === 2);

child.kill();
for (const [n, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
if (results.some(r => !r[1])) { console.log('\n--- logs ---\n' + logs); process.exit(1); }
