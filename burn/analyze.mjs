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
      est.stepfit = { crossings: pts.length, output_tokens: 100 / f.slope, usd: g && g.slope > 0 ? 100 / g.slope : null, r2: f.r2, delta_fit: g && g.slope > 0 ? g.slope * tot.cost_usd : null };
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

const LIST = { // API list price per 1M tokens: output, input, cache read (used only to label the meter weights)
  'claude-sonnet-5-5': { output: 10, input: 2, cache_read: 0.2 }, 'claude-opus-5-5': { output: 20, input: 4, cache_read: 0.2 },
  'claude-haiku-5-5': { output: 0.5, input: 0.1, cache_read: 0.01 }, 'claude-fable-5-1': { output: 50, input: 10, cache_read: 0.25 },
};
function solve3(A, b) { // Gaussian elimination, 3x3
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) { let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r; [M[i], M[p]] = [M[p], M[i]];
    for (let r = 0; r < 3; r++) { if (r === i) continue; const f = M[r][i] / M[i][i]; for (let c = i; c < 4; c++) M[r][c] -= f * M[i][c]; } }
  return M.map((r, i) => r[3] / r[i]);
}
const deltaOf = (r) => r.estimates.five_hour.stepfit?.delta_fit ?? r.estimates.five_hour.delta;

/** Pool several runs of one mode into one pseudo-run: summed totals, summed meter deltas. */
export function pool(rs) {
  const totals = { calls: 0, ok: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, thinking: 0, cost_usd: 0, ms: 0 };
  let delta = 0;
  for (const r of rs) { for (const k of Object.keys(totals)) totals[k] += r.totals[k] ?? 0; delta += deltaOf(r); }
  return { id: rs.map((r) => r.id), ids: rs.map((r) => r.id), mode: rs[0].mode, totals, delta, started_at: rs[0].started_at, n: rs.length };
}
const dOf = (x) => x.delta ?? deltaOf(x);

/** Per model: meter weights (points per token of each kind) solved from the latest valid run of each mode. */
/** Weights for a model from a {mode: run-or-pool} set. Without an explicit set: the latest UTC day that has all
 *  three modes, with every run of a mode that day pooled, so one odd run cannot swing the headline. */
export function weightsFor(runs, model, latestOverride = null) {
  let latest = latestOverride;
  if (!latest) {
    const byDay = {};
    for (const r of runs) if (r.valid && (r.model_reported ?? r.model) === model) ((byDay[r.started_at.slice(0, 10)] ??= {})[r.mode] ??= []).push(r);
    const day = Object.keys(byDay).sort().reverse().find((d) => ['output', 'input', 'cache'].every((m) => byDay[d][m]));
    if (!day) return null;
    latest = Object.fromEntries(Object.entries(byDay[day]).map(([m, rs]) => [m, pool(rs)]));
  }
  const modes = ['output', 'input', 'cache'];
  if (!modes.every((m) => latest[m])) return null;
  const A = modes.map((m) => { const t = latest[m].totals; return [t.output, t.input + t.cache_write, t.cache_read]; });
  const b = modes.map((m) => dOf(latest[m]));
  const w = solve3(A, b);
  const corners = [];
  for (const d1 of [-1, 1]) for (const d2 of [-1, 1]) for (const d3 of [-1, 1]) corners.push(solve3(A, [b[0] + d1, b[1] + d2, b[2] + d3]));
  const list = LIST[model] ?? null;
  const rel = (i) => (list ? list.output * w[i] / w[0] : null);
  return {
    model, day: latest.output.started_at.slice(0, 10), runs: Object.fromEntries(modes.map((m) => [m, latest[m].ids ?? latest[m].id])),
    points_per_million: { output: w[0] * 1e6, input_or_cache_write: w[1] * 1e6, cache_read: w[2] * 1e6 },
    implied_price_per_million: { output: rel(0), input_or_cache_write: rel(1), cache_read: rel(2) },
    implied_price_range: { input_or_cache_write: [Math.min(...corners.map((c) => list.output * c[1] / c[0])), Math.max(...corners.map((c) => list.output * c[1] / c[0]))],
      cache_read: [Math.min(...corners.map((c) => list.output * c[2] / c[0])), Math.max(...corners.map((c) => list.output * c[2] / c[0]))] },
    list_price_per_million: list,
    window: { output_equiv_tokens: 100 / w[0], usd_at_list: list ? 100 / w[0] * list.output / 1e6 : null, cache_read_equiv_tokens: 100 / w[2] },
  };
}

/** Output-equivalent tokens a run spent, by that model's meter weights. */
function outputEquiv(r, W) {
  const t = r.totals, w = W.points_per_million;
  return t.output + (t.input + t.cache_write) * (w.input_or_cache_write / w.output) + t.cache_read * (w.cache_read / w.output);
}

/** Five-hour meter points a run spent, by its model's weights (model-independent unit: 100 = one full window). */
function pointsSpent(r, W) {
  const t = r.totals, w = W.points_per_million;
  return (t.output * w.output + (t.input + t.cache_write) * w.input_or_cache_write + t.cache_read * w.cache_read) / 1e6;
}

/** Weekly cap in five-hour windows, pooled across every valid run of every model with solved weights:
 *  sum of five-hour points spent inside runs / sum of weekly points moved inside runs. Using within-run
 *  weekly deltas (not first-pre to last-post) keeps spend outside the runs out of the denominator. */
export function weeklyPooled(runs, weightsByModel) {
  const rs = runs.filter((r) => r.valid && weightsByModel[r.model_reported ?? r.model] && r.estimates.seven_day && r.estimates.seven_day.delta >= 0);
  if (!rs.length) return null;
  const pts = rs.reduce((s, r) => s + pointsSpent(r, weightsByModel[r.model_reported ?? r.model]), 0);
  const moved = rs.reduce((s, r) => s + r.estimates.seven_day.delta, 0);
  if (moved <= 0) return { runs: rs.length, points_5h_spent: pts, weekly_points_moved: moved, windows_per_week: null };
  const err = Math.sqrt(rs.length); // each run's weekly delta carries +-1 of rounding
  return { runs: rs.length, points_5h_spent: pts, weekly_points_moved: moved, windows_per_week: pts / moved,
    windows_per_week_low: pts / (moved + err), windows_per_week_high: moved - err > 0 ? pts / (moved - err) : null };
}

export function weeklyFor(weightsByModel, model, pooled) {
  const W = weightsByModel[model]; if (!W || !pooled || !pooled.windows_per_week) return null;
  const win = W.window.output_equiv_tokens;
  return { windows_per_week: pooled.windows_per_week, output_equiv_tokens: win * pooled.windows_per_week,
    output_equiv_tokens_low: win * pooled.windows_per_week_low, output_equiv_tokens_high: pooled.windows_per_week_high ? win * pooled.windows_per_week_high : null,
    usd_at_list: W.list_price_per_million ? win * pooled.windows_per_week * W.list_price_per_million.output / 1e6 : null, runs: pooled.runs, weekly_points_moved: pooled.weekly_points_moved };
}

/** One row per day per model: the five-hour window measured that day, in output-equivalent tokens.
 *  A day with all three modes solves its own weights. A day with only an output run derives the output
 *  weight from that run and carries the other two weights from the nearest solved day. */
export function dailyFor(runs, model, fallbackWeights) {
  const rs = runs.filter((r) => r.valid && (r.model_reported ?? r.model) === model);
  const byDay = {};
  for (const r of rs) ((byDay[r.started_at.slice(0, 10)] ??= {})[r.mode] ??= []).push(r);
  const out = [];
  let carried = null;
  for (const date of Object.keys(byDay).sort()) {
    const d = Object.fromEntries(Object.entries(byDay[date]).map(([m, list]) => [m, pool(list)])); // every run of a mode that day, pooled
    let W = weightsFor(runs, model, d), source = 'three modes measured this day';
    if (!W && d.output) {
      const base = carried ?? fallbackWeights; if (!base) continue;
      const o = d.output, t = o.totals, bw = base.points_per_million;
      const wOut = (dOf(o) - ((t.input + t.cache_write) * bw.input_or_cache_write + t.cache_read * bw.cache_read) / 1e6) / t.output;
      if (!(wOut > 0)) continue;
      W = { ...base, points_per_million: { ...bw, output: wOut * 1e6 }, window: { ...base.window, output_equiv_tokens: 100 / wOut, usd_at_list: base.list_price_per_million ? 100 / wOut * base.list_price_per_million.output / 1e6 : null } };
      source = 'output run this day; input and cache weights carried';
    }
    if (!W) continue;
    if (source.startsWith('three')) carried = W;
    out.push({ date, model, source, runs: Object.values(d).flatMap((r) => r.ids), modes: Object.keys(d).sort(),
      window: W.window, points_per_million: W.points_per_million, list_price_per_million: W.list_price_per_million });
  }
  return out;
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
  const models = [...new Set(runs.filter((r) => r.valid).map((r) => r.model_reported ?? r.model))];
  const weights = {};
  for (const m of models) { const w = weightsFor(runs, m); if (w) weights[m] = w; }
  const pooled = weeklyPooled(runs, weights);
  const daily = {};
  for (const m of Object.keys(weights)) daily[m] = dailyFor(runs, m, weights[m]);
  const weekly = {};
  for (const m of Object.keys(weights)) weekly[m] = weeklyFor(weights, m, pooled);
  // cross-model: how the meter prices one model's output against another's, vs list
  const ms = Object.keys(weights), model_ratios = {};
  for (const a of ms) for (const b of ms) if (a !== b) model_ratios[`${a}/${b}`] = { meter: weights[a].points_per_million.output / weights[b].points_per_million.output,
    list: weights[a].list_price_per_million && weights[b].list_price_per_million ? weights[a].list_price_per_million.output / weights[b].list_price_per_million.output : null };
  const plans = { pro: { label: 'Pro', multiplier: 1, measured: true }, max5: { label: 'Max 5x', multiplier: 5, measured: false }, max20: { label: 'Max 20x', multiplier: 20, measured: false } };
  fs.writeFileSync(path.join(root, 'data', 'summary.json'), JSON.stringify({ generated_at: new Date().toISOString(), measured_plan: 'pro', plans, models: Object.keys(weights), weights, weekly, weekly_pooled: pooled, model_ratios, daily,
    runs_by_model: Object.fromEntries(models.map((m) => [m, runs.filter((r) => (r.model_reported ?? r.model) === m).map((r) => r.id)])) }, null, 1));
  return runs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runs = rebuild(root);
  console.log(`rebuilt ${runs.length} run(s)`);
  for (const r of runs) console.log(r.id, r.outcome, r.valid ? 'valid' : 'invalid', r.estimates.five_hour?.method, Math.round(r.estimates.five_hour?.output_tokens ?? 0), 'out-tok/5h', '$' + (r.estimates.five_hour?.usd ?? 0).toFixed(2));
}
