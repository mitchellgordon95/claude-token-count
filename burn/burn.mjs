#!/usr/bin/env node
// Burn harness: spend subscription usage in a controlled way, sample the usage
// meter after every batch, and write a raw run file that analyze.mjs turns into
// the numbers on the site.
//
//   node burn/burn.mjs --mode output --model sonnet --target-pct 10
//   node burn/burn.mjs --mode output --until-limit          # full burn
//   node burn/burn.mjs --mode input  --input-tokens 60000   # input-heavy
//   node burn/burn.mjs --mode cache  --input-tokens 60000   # same prompt every call
//
// Modes hold the token mix constant so a single burn measures one weight.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUsage, resolveToken } from './usage.mjs';
import { rebuild } from './analyze.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i === -1 ? def : (argv[i + 1] ?? true); };
const flag = (name) => argv.includes(`--${name}`);
const cfg = {
  mode: opt('mode', 'output'),                       // output | input | cache
  model: opt('model', 'sonnet'),
  effort: opt('effort', 'low'),
  targetPct: Number(opt('target-pct', 10)),          // stop once 5h meter rose this much
  untilLimit: flag('until-limit'),                   // ignore target, run until rate-limited
  maxCalls: Number(opt('max-calls', 400)),
  words: Number(opt('words', 4000)),                 // output mode: words requested per call
  inputTokens: Number(opt('input-tokens', 60000)),   // input/cache modes: approx prompt tokens
  concurrency: Number(opt('concurrency', 1)),
  label: opt('label', ''),
  note: opt('note', ''),
  dry: flag('dry'),
};
if (!['output', 'input', 'cache'].includes(cfg.mode)) throw new Error(`bad --mode ${cfg.mode}`);

// ---------- prompts ----------
const SYSTEM = 'You are a plain text generator. Output only the requested text, no preamble, no headings, no markdown.';
const TOPICS = ['the history of lighthouses', 'how glaciers move', 'the economics of bread', 'urban beekeeping', 'the design of subway maps',
  'why rivers meander', 'the life of a cargo ship', 'the invention of the pencil', 'how tides work', 'the culture of chess clubs',
  'salt as a commodity', 'the geometry of snowflakes', 'how libraries are organised', 'the sound of cities at night', 'the craft of bookbinding'];
const WORDS = ('time person year way day thing man world life hand part child eye woman place work week case point government company number group problem fact ' +
  'river stone glass copper velvet orbit lantern harbor meadow cinder quartz saddle tunnel willow anchor beacon canyon ember fossil garnet').split(' ');
let seed = 1234567;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function junkText(approxTokens) {
  // ~1.35 tokens per short English word; shuffled so it never caches against itself.
  const n = Math.round(approxTokens / 1.35);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = WORDS[Math.floor(rnd() * WORDS.length)];
  return out.join(' ');
}
const cachePrompt = cfg.mode === 'cache' ? junkText(cfg.inputTokens) : null;
function promptFor(i) {
  if (cfg.mode === 'output') {
    const topic = TOPICS[i % TOPICS.length];
    return `Write a ${cfg.words}-word essay about ${topic}. Continuous prose, no headings, no lists. Do not stop early.`;
  }
  const body = cfg.mode === 'cache' ? cachePrompt : junkText(cfg.inputTokens);
  return `${body}\n\nReply with exactly the word OK and nothing else.`;
}

// ---------- one headless call ----------
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-burn-'));
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || (k.startsWith('CLAUDE_') && k !== 'CLAUDE_CODE_OAUTH_TOKEN' && k !== 'CLAUDE_CONFIG_DIR')) continue;
    env[k] = v;
  }
  return env;
}
function callClaude(prompt) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--model', cfg.model, '--output-format', 'json', '--tools', '', '--no-session-persistence',
      '--system-prompt', SYSTEM, '--effort', cfg.effort];
    const t0 = Date.now();
    const child = spawn('claude', args, { cwd: workdir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let j = null;
      try { j = JSON.parse(out); } catch {}
      const u = j?.usage ?? {};
      let cost = 0;
      for (const m of Object.values(j?.modelUsage ?? {})) cost += m.costUSD ?? 0;
      if (!cost) cost = j?.total_cost_usd ?? 0;
      resolve({
        ok: !!j && !j.is_error && code === 0,
        exit: code,
        ms: Date.now() - t0,
        input: u.input_tokens ?? 0,
        cache_write: u.cache_creation_input_tokens ?? 0,
        cache_read: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        thinking: u.output_tokens_details?.thinking_tokens ?? 0,
        cost_usd: cost,
        stop_reason: j?.stop_reason ?? null,
        model: Object.keys(j?.modelUsage ?? {})[0] ?? null,
        result_chars: (j?.result ?? '').length,
        error: (!j || j.is_error) ? ((j?.result ?? err ?? out) + '').slice(0, 400) : null,
      });
    });
  });
}
const isLimitError = (c) => c.error && /limit|rate|usage|quota|exceed/i.test(c.error);

// ---------- run ----------
const token = resolveToken();
const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + cfg.mode + (cfg.label ? '-' + cfg.label : '');
const run = {
  id, version: 1, started_at: new Date().toISOString(), ended_at: null,
  mode: cfg.mode, model: cfg.model, effort: cfg.effort, label: cfg.label, note: cfg.note,
  params: { targetPct: cfg.targetPct, untilLimit: cfg.untilLimit, maxCalls: cfg.maxCalls, words: cfg.words, inputTokens: cfg.inputTokens, concurrency: cfg.concurrency },
  runner: { host: os.hostname(), ci: !!process.env.GITHUB_ACTIONS, claude_version: null },
  pre: null, post: null, samples: [], calls: [], outcome: null, error: null,
};
try { run.runner.claude_version = (await import('node:child_process')).execSync('claude --version').toString().trim(); } catch {}

const cum = { calls: 0, ok: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, thinking: 0, cost_usd: 0 };
const snapshot = (u) => ({ at: u.at, calls: cum.calls, ...cum, five_hour: u.five_hour?.utilization ?? null, seven_day: u.seven_day?.utilization ?? null, five_hour_resets_at: u.five_hour?.resets_at ?? null });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

run.pre = await readUsage(token);
run.samples.push(snapshot(run.pre));
log(`pre: 5h=${run.pre.five_hour?.utilization}% 7d=${run.pre.seven_day?.utilization}% mode=${cfg.mode} model=${cfg.model} target=+${cfg.targetPct}% untilLimit=${cfg.untilLimit}`);
if (run.pre.five_hour?.utilization >= 100) { log('5h window already exhausted; aborting'); process.exit(2); }
if (cfg.dry) { log('dry run; prompt preview:', promptFor(0).slice(0, 120)); process.exit(0); }

const rawDir = path.join(ROOT, 'data', 'raw');
fs.mkdirSync(rawDir, { recursive: true });
const rawPath = path.join(rawDir, id + '.json');
const save = () => fs.writeFileSync(rawPath, JSON.stringify(run, null, 1));

outer: while (cum.calls < cfg.maxCalls) {
  const batch = Math.min(cfg.concurrency, cfg.maxCalls - cum.calls);
  const results = await Promise.all(Array.from({ length: batch }, (_, k) => callClaude(promptFor(cum.calls + k))));
  for (const c of results) {
    cum.calls++;
    if (c.ok) { cum.ok++; for (const k of ['input', 'cache_write', 'cache_read', 'output', 'thinking', 'cost_usd']) cum[k] += c[k]; }
    run.calls.push(c);
    if (!c.ok) {
      log(`call failed (exit ${c.exit}): ${c.error}`);
      if (isLimitError(c)) { run.outcome = 'limit_hit'; run.error = c.error; }
      else if (run.calls.filter((x) => !x.ok).length >= 3) { run.outcome = 'error'; run.error = c.error; }
    }
  }
  let u;
  try { u = await readUsage(token); } catch (e) { log('usage read failed:', e.message); await new Promise((r) => setTimeout(r, 5000)); try { u = await readUsage(token); } catch { u = null; } }
  if (u) {
    run.samples.push(snapshot(u));
    const d5 = u.five_hour.utilization - run.pre.five_hour.utilization;
    log(`calls=${cum.calls} out=${cum.output} in=${cum.input} cw=${cum.cache_write} cr=${cum.cache_read} $${cum.cost_usd.toFixed(3)} | 5h=${u.five_hour.utilization}% (+${d5}) 7d=${u.seven_day.utilization}%`);
    if (Math.abs(Date.parse(u.five_hour.resets_at) - Date.parse(run.pre.five_hour.resets_at)) > 60_000 || d5 < 0) { run.outcome = 'window_reset'; log('5h window reset mid-run; stopping'); }
    else if (!cfg.untilLimit && d5 >= cfg.targetPct) run.outcome = 'target_reached';
    else if (u.five_hour.utilization >= 100) run.outcome = 'limit_hit';
  }
  save();
  if (run.outcome) break outer;
}
if (!run.outcome) run.outcome = 'max_calls';
try { run.post = await readUsage(token); } catch (e) { log('post usage read failed, using last sample:', e.message); const s = run.samples.at(-1); run.post = { at: s.at, five_hour: { utilization: s.five_hour, resets_at: s.five_hour_resets_at }, seven_day: { utilization: s.seven_day } }; }
run.ended_at = new Date().toISOString();
save();
log(`done: ${run.outcome}; 5h ${run.pre.five_hour.utilization}% -> ${run.post.five_hour.utilization}%, output=${cum.output} cost=$${cum.cost_usd.toFixed(3)}`);
const summary = rebuild(ROOT).find((s) => s.id === id);
if (summary) log('estimate:', JSON.stringify(summary.estimates, null, 1));
fs.rmSync(workdir, { recursive: true, force: true });
