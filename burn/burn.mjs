#!/usr/bin/env node
// Burn harness: spend subscription usage in a controlled way, read the usage meter
// as we go, and write a raw run file that analyze.mjs turns into the numbers on the site.
//
//   node burn/burn.mjs --mode output --model sonnet --target-pct 10
//   node burn/burn.mjs --mode output --until-limit          # full burn
//   node burn/burn.mjs --mode input  --input-tokens 60000   # input-heavy
//   node burn/burn.mjs --mode cache  --input-tokens 60000   # same prompt every call
//
// Meter source: every headless call streams a `rate_limit_event` carrying the five-hour
// and weekly utilization, so each call doubles as a meter read (--meter stream, default).
// The reading arrives in the response headers, i.e. BEFORE that call's own output is
// counted, so a call's reading is paired with the cumulative spend of the calls before it.
// --meter endpoint uses the /api/oauth/usage endpoint instead (needs user:profile scope,
// which `claude setup-token` tokens lack).
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
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
  meter: opt('meter', 'stream'),                     // stream | endpoint
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
if (!['stream', 'endpoint'].includes(cfg.meter)) throw new Error(`bad --meter ${cfg.meter}`);

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
  const n = Math.round(approxTokens / 1.35); // ~1.35 tokens per short English word
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
const PROBE = 'Reply with exactly the word OK and nothing else.';

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
// The stream event reports utilization as a 0..1 fraction (the endpoint reports 0..100).
// Normalize to percent, rounded to kill float noise like 7.000000000000001.
const pct = (v) => (v == null ? null : Math.round(v * 100 * 1000) / 1000);
function callClaude(prompt) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--model', cfg.model, '--output-format', 'stream-json', '--verbose', '--tools', '', '--no-session-persistence',
      '--system-prompt', SYSTEM, '--effort', cfg.effort];
    const t0 = Date.now();
    const child = spawn('claude', args, { cwd: workdir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let result = null, meter = null;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.type === 'result') result = j;
        else if (j.type === 'rate_limit_event' && j.rate_limit_info) {
          const w = j.rate_limit_info.unifiedWindows ?? {};
          meter = {
            at: new Date().toISOString(),
            five_hour: pct(w.five_hour?.utilization), seven_day: pct(w.seven_day?.utilization),
            five_hour_resets_at: w.five_hour?.resetsAt ? new Date(w.five_hour.resetsAt * 1000).toISOString() : null,
            seven_day_resets_at: w.seven_day?.resetsAt ? new Date(w.seven_day.resetsAt * 1000).toISOString() : null,
            status: j.rate_limit_info.status, raw: j.rate_limit_info,
          };
        }
      }
      const j = result, u = j?.usage ?? {};
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
        meter,
        error: (!j || j.is_error) ? ((j?.result ?? err ?? out) + '').slice(0, 400) : null,
      });
    });
  });
}
const isLimitError = (c) => (c.error && /limit|rate|usage|quota|exceed/i.test(c.error)) || c.meter?.status === 'rejected';

// Meter read: a probe call (stream) or the endpoint.
async function readMeter(token) {
  if (cfg.meter === 'endpoint') {
    const u = await readUsage(token);
    return { at: u.at, five_hour: u.five_hour?.utilization ?? null, seven_day: u.seven_day?.utilization ?? null,
      five_hour_resets_at: u.five_hour?.resets_at ?? null, seven_day_resets_at: u.seven_day?.resets_at ?? null, status: null, raw: u, probe: null };
  }
  const c = await callClaude(PROBE);
  if (!c.meter) throw new Error(`probe call gave no rate_limit_event (exit ${c.exit}): ${c.error ?? ''}`);
  return { ...c.meter, probe: c };
}

// ---------- run ----------
const token = resolveToken();
const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + cfg.mode + (cfg.label ? '-' + cfg.label : '');
const run = {
  id, version: 2, started_at: new Date().toISOString(), ended_at: null,
  mode: cfg.mode, model: cfg.model, effort: cfg.effort, meter: cfg.meter, label: cfg.label, note: cfg.note,
  params: { targetPct: cfg.targetPct, untilLimit: cfg.untilLimit, maxCalls: cfg.maxCalls, words: cfg.words, inputTokens: cfg.inputTokens, concurrency: cfg.concurrency },
  runner: { host: os.hostname(), ci: !!process.env.GITHUB_ACTIONS, claude_version: null },
  pre: null, post: null, samples: [], calls: [], outcome: null, error: null,
};
try { run.runner.claude_version = execSync('claude --version').toString().trim(); } catch {}

const cum = { calls: 0, ok: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, thinking: 0, cost_usd: 0 };
const addCall = (c) => { cum.calls++; if (c.ok) { cum.ok++; for (const k of ['input', 'cache_write', 'cache_read', 'output', 'thinking', 'cost_usd']) cum[k] += c[k]; } run.calls.push(c); };
// A sample pairs a meter reading with the cumulative spend the reading reflects.
const sample = (m, spend) => ({ at: m.at, ...spend, five_hour: m.five_hour, seven_day: m.seven_day, five_hour_resets_at: m.five_hour_resets_at, status: m.status ?? null });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const toUsage = (m) => ({ at: m.at, five_hour: { utilization: m.five_hour, resets_at: m.five_hour_resets_at }, seven_day: { utilization: m.seven_day, resets_at: m.seven_day_resets_at } });

const rawDir = path.join(ROOT, 'data', 'raw');
fs.mkdirSync(rawDir, { recursive: true });
const rawPath = path.join(rawDir, id + '.json');
const save = () => fs.writeFileSync(rawPath, JSON.stringify(run, null, 1));

if (cfg.dry) { log('dry run; prompt preview:', promptFor(0).slice(0, 120)); process.exit(0); }

// Pre reading. In stream mode the probe is a real (tiny) call, so it is counted in the run.
const pre = await readMeter(token);
if (pre.probe) addCall(pre.probe);
run.pre = toUsage(pre);
run.samples.push(sample(pre, { ...cum, calls: 0, ok: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, thinking: 0, cost_usd: 0 }));
log(`pre: 5h=${pre.five_hour}% 7d=${pre.seven_day}% mode=${cfg.mode} model=${cfg.model} meter=${cfg.meter} target=+${cfg.targetPct}% untilLimit=${cfg.untilLimit}`);
if (pre.five_hour >= 100 || pre.status === 'rejected') { log('5h window already exhausted; aborting'); fs.rmSync(workdir, { recursive: true, force: true }); process.exit(2); }

outer: while (cum.calls < cfg.maxCalls) {
  const batch = Math.min(cfg.concurrency, cfg.maxCalls - cum.calls);
  const spendBefore = { ...cum };
  const results = await Promise.all(Array.from({ length: batch }, (_, k) => callClaude(promptFor(cum.calls + k))));
  let latest = null;
  for (const c of results) {
    addCall(c);
    if (c.meter) { run.samples.push(sample(c.meter, spendBefore)); latest = c.meter; }
    if (!c.ok) {
      log(`call failed (exit ${c.exit}): ${c.error}`);
      if (isLimitError(c)) { run.outcome = 'limit_hit'; run.error = c.error; }
      else if (run.calls.filter((x) => !x.ok).length >= 3) { run.outcome = 'error'; run.error = c.error; }
    }
  }
  if (cfg.meter === 'endpoint') { try { latest = await readMeter(token); run.samples.push(sample(latest, { ...cum })); } catch (e) { log('usage read failed:', e.message); } }
  if (latest) {
    const d5 = latest.five_hour - pre.five_hour;
    log(`calls=${cum.calls} out=${cum.output} in=${cum.input} cw=${cum.cache_write} cr=${cum.cache_read} $${cum.cost_usd.toFixed(3)} | 5h=${latest.five_hour}% (+${d5}) 7d=${latest.seven_day}% ${latest.status ?? ''}`);
    if (latest.five_hour_resets_at && pre.five_hour_resets_at && Math.abs(Date.parse(latest.five_hour_resets_at) - Date.parse(pre.five_hour_resets_at)) > 60_000 || d5 < 0) { run.outcome = 'window_reset'; log('5h window reset mid-run; stopping'); }
    else if (!run.outcome && !cfg.untilLimit && d5 >= cfg.targetPct) run.outcome = 'target_reached';
    else if (!run.outcome && latest.five_hour >= 100) run.outcome = 'limit_hit';
  }
  save();
  if (run.outcome) break outer;
}
if (!run.outcome) run.outcome = 'max_calls';

// Post reading: in stream mode this is another tiny probe, so the final meter value includes every burn call.
try {
  const post = await readMeter(token);
  if (post.probe) addCall(post.probe);
  run.post = toUsage(post);
  run.samples.push(sample(post, { ...cum }));
  if (post.status === 'rejected' && run.outcome === 'max_calls') run.outcome = 'limit_hit';
} catch (e) {
  log('post meter read failed, using last sample:', e.message);
  const s = run.samples.at(-1);
  run.post = { at: s.at, five_hour: { utilization: s.five_hour, resets_at: s.five_hour_resets_at }, seven_day: { utilization: s.seven_day } };
}
run.ended_at = new Date().toISOString();
save();
log(`done: ${run.outcome}; 5h ${run.pre.five_hour.utilization}% -> ${run.post.five_hour.utilization}%, output=${cum.output} cost=$${cum.cost_usd.toFixed(3)} calls=${cum.calls}`);
const summary = rebuild(ROOT).find((s) => s.id === id);
if (summary) log('estimate:', JSON.stringify(summary.estimates.five_hour));
fs.rmSync(workdir, { recursive: true, force: true });
