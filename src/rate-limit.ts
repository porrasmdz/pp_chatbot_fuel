import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const WINDOW_MS = 60_000;
const MAX_MESSAGES = 50;
const BLOCK_MS = 8 * 60 * 60 * 1000;
const FILE_PATH = join(process.env.APP_DATA_DIR || ".", "rate_limits.json");

type SenderState = { timestamps: number[]; blockedUntil: number };
export type RateResult = "allowed" | "just_blocked" | "blocked";

export class RateLimiter {
  private states = new Map<string, SenderState>();

  constructor() {
    mkdirSync(dirname(FILE_PATH), { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(FILE_PATH, "utf8")) as Record<string, SenderState>;
      for (const [jid, state] of Object.entries(saved)) {
        if (Array.isArray(state.timestamps) && Number.isFinite(state.blockedUntil)) this.states.set(jid, state);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  check(jid: string, now = Date.now()): RateResult {
    const state = this.states.get(jid) ?? { timestamps: [], blockedUntil: 0 };
    if (state.blockedUntil > now) return "blocked";
    state.timestamps = state.timestamps.filter(time => Number.isFinite(time) && time > now - WINDOW_MS && time <= now);
    state.blockedUntil = 0;
    state.timestamps.push(now);
    let result: RateResult = "allowed";
    if (state.timestamps.length > MAX_MESSAGES) {
      state.blockedUntil = now + BLOCK_MS;
      state.timestamps = [];
      result = "just_blocked";
    }
    this.states.set(jid, state);
    this.save();
    return result;
  }

  isBlocked(jid: string, now = Date.now()): boolean {
    return (this.states.get(jid)?.blockedUntil ?? 0) > now;
  }

  private save(): void {
    const data = Object.fromEntries(this.states);
    writeFileSync(`${FILE_PATH}.tmp`, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    renameSync(`${FILE_PATH}.tmp`, FILE_PATH);
  }
}
