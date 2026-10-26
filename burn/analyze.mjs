// Turn raw run files into the summaries the site reads.
//   node burn/analyze.mjs            # rebuild data/runs.json + data/latest.json from data/raw/*.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INVALID = new Set(['window_reset', 'error']);

function ols(points) { // points: [{x,y}] -> slope, intercept, r2
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n, my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept: my - slope * mx, r2, n };
}

function estimateBucket(run, bucket, tot) {
  const pre = run.pre?.[bucket]?.utilization;
  const post = run.post?.[bucket]?.utilization ?? run.samples.at(-1)?.[bucket];
  if (pre == null || post == null) return null;
  const delta = post - pre;
  const est = { pre, post, delta, method: null, output_tokens: null, usd: null, output_tokens_low: null, output_tokens_high: null, stepfit: null };
  if (delta <= 0) return est;

  // Simple ratio. The meter reports whole percents, so the true delta lies within +-1 of what we saw.
  est.output_tokens = tot.output * 100 / delta;
  est.usd = tot.cost_usd * 100 / delta;
  est.output_tokens_low = tot.output * 100 / (delta + 1);
  est.output_tokens_high = delta > 1 ? tot.output * 100 / (delta - 1) : null;
  est.method = 'simple';

  // Step fit: every time the integer meter ticks up we learn a threshold crossing. With
  // several crossings a regression beats the single-delta ratio and shrinks the +-1 error.
  const pts = [], ptsUsd = [];
  for (let i = 1; i < run.samples.length; i++) {
    const a = run.samples[i - 1], b = run.samples[i];
    if (b[bucket] != null && a[bucket] != null && b[bucket] > a[bucket]) {
      pts.push({ x: (a.output + b.output) / 2, y: b[bucket] });
      ptsUsd.push({ x: (a.cost_usd + b.cost_usd) / 2, y: b[bucket] });
    }
  }
  if (pts.length >= 3) {
    const f = ols(pts), g = ols(ptsUsd);
    if (f && f.slope > 0) {
      est.stepfit = { crossings: pts.length, output_tokens: 100 / f.slope, usd: g && g.slope > 0 ? 100 / g.slope : null, r2: f.r2 };
      est.method = 'stepfit';
      est.output_tokens = est.stepfit.output_tokens;
      if (est.stepfit.usd) est.usd = est.stepfit.usd;
    }
  }
  if (run.outcome === 'limit_hit' && bucket === 'five_hour') {
    // We hit the wall: the window total is measured, not extrapolated.
    est.method = 'measured';
    est.output_tokens = tot.output * 100 / (100 - pre);
    est.usd = tot.cost_usd * 100 / (100 - pre);
    est.output_tokens_low = est.output_tokens_high = null;
  }
  return est;
}

export function summarize(run) {
  const tot = { calls: 0, ok: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, thinking: 0, cost_usd: 0, ms: 0 };
  for (const c of run.calls ?? []) { tot.calls++; tot.ms += c.ms ?? 0; if (c.ok) { tot.ok++; for (const k of ['input', 'cache_write', 'cache_read', 'output', 'thinking', 'cost_usd']) tot[k] += c[k] ?? 0; } }
  const five_hour = estimateBucket(run, 'five_hour', tot);
  const seven_day = estimateBucket(run, 'seven_day', tot);
  const valid = !INVALID.has(run.outcome) && !!five_hour && five_hour.delta >= 1 && tot.ok > 0;
  return {
    id: run.id, started_at: run.started_at, ended_at: run.ended_at, mode: run.mode, model: run.model, effort: run.effort,
    label: run.label || null, note: run.note || null, outcome: run.outcome, valid, ci: !!run.runner?.ci,
    claude_version: run.runner?.claude_version ?? null, model_reported: run.calls?.find((c) => c.model)?.model ?? null,
    totals: tot,
    pct_per_million_output: five_hour?.delta > 0 ? five_hour.delta / (tot.output / 1e6) : null,
    pct_per_usd: five_hour?.delta > 0 ? five_hour.delta / tot.cost_usd : null,
    estimates: { five_hour, seven_day },
  };
}

export function rebuild(root) {
  const rawDir = path.join(root, 'data', 'raw');
  const runs = fs.existsSync(rawDir)
    ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.json')).map((f) => summarize(JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'))))
    : [];
  runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
  fs.writeFileSync(path.join(root, 'data', 'runs.json'), JSON.stringify(runs, null, 1));
  const headline = [...runs].reverse().find((r) => r.valid && r.mode === 'output') ?? null;
  const byMode = {};
  for (const r of runs) if (r.valid) byMode[r.mode] = r;
  fs.writeFileSync(path.join(root, 'data', 'latest.json'), JSON.stringify({ generated_at: new Date().toISOString(), runs: runs.length, headline, latest_by_mode: byMode }, null, 1));
  return runs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runs = rebuild(root);
  console.log(`rebuilt ${runs.length} run(s)`);
  for (const r of runs) console.log(r.id, r.outcome, r.valid ? 'valid' : 'invalid', r.estimates.five_hour?.method, Math.round(r.estimates.five_hour?.output_tokens ?? 0), 'out-tok/5h', '$' + (r.estimates.five_hour?.usd ?? 0).toFixed(2));
}
