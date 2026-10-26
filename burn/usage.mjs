// Read the subscription usage meter that Claude Code itself uses for /usage.
// Token resolution: CLAUDE_CODE_OAUTH_TOKEN env var (CI / fresh account), else the
// local Claude Code credential (macOS keychain or ~/.claude/.credentials.json).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (process.platform === 'darwin') {
    try {
      const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const t = JSON.parse(raw)?.claudeAiOauth?.accessToken;
      if (t) return t;
    } catch {}
  }
  try {
    const raw = fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8');
    const t = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    if (t) return t;
  } catch {}
  throw new Error('No OAuth token found. Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`).');
}

const pick = (b) => b ? {
  utilization: b.utilization,
  resets_at: b.resets_at,
  limit_dollars: b.limit_dollars,
  used_dollars: b.used_dollars,
  remaining_dollars: b.remaining_dollars,
} : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRead = 0;
export const MIN_READ_GAP_MS = 8000; // the endpoint 429s when polled every couple of seconds

export async function readUsage(token = resolveToken(), { retries = 5 } = {}) {
  const wait = MIN_READ_GAP_MS - (Date.now() - lastRead);
  if (wait > 0) await sleep(wait);
  let r, lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
    });
    lastRead = Date.now();
    if (r.ok) break;
    lastErr = `usage endpoint HTTP ${r.status}: ${(await r.text()).replace(/\s+/g, ' ').slice(0, 200)}`;
    if (r.status !== 429 && r.status < 500) throw new Error(lastErr);
    const ra = Number(r.headers.get('retry-after'));
    await sleep(ra > 0 ? ra * 1000 : Math.min(60000, 5000 * 2 ** attempt));
  }
  if (!r.ok) throw new Error(lastErr);
  const j = await r.json();
  return {
    at: new Date().toISOString(),
    five_hour: pick(j.five_hour),
    seven_day: pick(j.seven_day),
    seven_day_sonnet: pick(j.seven_day_sonnet),
    seven_day_opus: pick(j.seven_day_opus),
    limits: j.limits ?? null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  readUsage().then((u) => console.log(JSON.stringify(u, null, 2))).catch((e) => { console.error(e.message); process.exit(1); });
}
