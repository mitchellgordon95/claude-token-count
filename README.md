# Claude Subscription Token Count

How many output tokens does the cheapest Claude Pro plan actually buy per 5-hour window?
A burn harness spends a real Pro account's usage in a controlled way, reads the same usage
meter that Claude Code's `/usage` shows, and publishes the numbers on a static site.

## Layout

- `burn/burn.mjs` — the harness. Runs headless `claude -p` calls with tools disabled, samples the meter after every batch, writes `data/raw/<run>.json`.
- `burn/analyze.mjs` — summarizes raw runs into `data/runs.json` and `data/latest.json`.
- `burn/usage.mjs` — reads the OAuth usage endpoint (optional; needs an interactive-login token). `npm run usage` prints the current meter.
- `index.html` — the site. Plain HTML, fetches `data/runs.json`. Works on Vercel or GitHub Pages as-is.
- `.github/workflows/burn.yml` — scheduled burns in GitHub Actions; commits results back to the repo.

## Run a burn

Needs Node 22+, the Claude Code CLI, and a subscription token for the account to burn:

```sh
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # from `claude setup-token` on the burn account
npm run usage                                      # confirm the meter reads (should be ~0% on a fresh window)
npm run burn -- --mode output --target-pct 10      # partial burn: stop once the 5h meter rises 10 points
npm run burn -- --mode output --until-limit        # full burn: run until rate-limited
npm run burn -- --mode input --input-tokens 60000  # input-heavy run, for the cost-weighting test
npm run burn -- --mode cache --input-tokens 60000  # same prompt every call, hits the prompt cache
```

Without the env var the harness falls back to the local Claude Code login, which is handy for
smoke tests but burns your own account.

Useful flags: `--model sonnet|opus|haiku`, `--words 4000` (output per call), `--concurrency 2`,
`--max-calls 400`, `--label weekly`, `--note "..."`, `--dry`.

## How the meter is read

Every headless call streams a `rate_limit_event` carrying the five-hour and weekly utilization
(the same numbers `/usage` shows), so each burn call is also a meter read. The reading comes
from the response headers, i.e. before that call's own output is counted, so the harness pairs
it with the spend of the calls before it. A tiny probe call ("reply OK") brackets the run at
each end. `--meter endpoint` uses `/api/oauth/usage` instead, which needs the `user:profile`
scope that `claude setup-token` tokens don't have.

## Modes

Each mode holds the token mix constant so a run measures one weight:

| mode   | prompt                                   | what it measures                        |
|--------|------------------------------------------|-----------------------------------------|
| output | tiny prompt, long essay                  | percent per output token                |
| input  | ~60K tokens of shuffled words, reply OK  | percent per fresh input token           |
| cache  | the same ~60K prompt every call          | percent per cache-read token            |

Every call also reports its API-list-price cost. If the plan is a cost-weighted budget,
percent-per-dollar should match across modes. The site shows that column.

## Findings so far (2026-10-25, Pro)

Three burns per model with different token mixes fit one linear meter per model. Relative to each model's own
output: input and 1-hour cache writes cost about 0.23–0.26x output (≈1.25x input, the 5-minute write rate, with
no 1-hour premium), and cache reads about 0.004–0.005x output (≈0.02x input, about a quarter of the list 0.1x).
Across models the meter prices Opus 5.5 output at about 1.4x Sonnet 5.5 output, where list says 2x. A Pro
five-hour window is about 980K Sonnet or 720K Opus output-equivalent tokens; the weekly cap is roughly 12 such
windows (coarse). Requests flagged by the safeguard classifier still charge the meter.

## Estimation

The meter reports whole percents. A partial run reports three things:

- **ratio**: `tokens * 100 / delta_percent`, with a likely range from the ±1 rounding.
- **step fit**: a regression through every tick-up of the meter (needs ≥3 ticks). More precise; used when available.
- **measured**: a full burn that hit the wall; no extrapolation.

## Scheduling

`burn.yml` runs a weekly partial burn (Sunday 10:00 UTC, +10%) and a monthly full burn
(1st of the month). Add the repo secret with the burn account's token:

```sh
gh secret set CLAUDE_CODE_OAUTH_TOKEN --body 'sk-ant-oat01-...'
```
 Results are committed to
`data/`; the site redeploys from the push (Vercel git integration or GitHub Pages).
`workflow_dispatch` lets you run any mode by hand from the Actions tab.
