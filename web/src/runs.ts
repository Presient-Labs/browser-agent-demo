import { randomUUID } from "node:crypto";
import type { Config } from "../../backend/src/config.js";
import type { AuditEvent, AuditStore } from "../../backend/src/audit.js";
import type { BrowserBridge } from "../../backend/src/browser/bridge.js";
import { TaskRunner, type TaskResult } from "../../backend/src/coordinator.js";
import type { ModelProvider } from "../../backend/src/providers/types.js";
import { log } from "../../backend/src/logger.js";
import { PRESETS, validateFreeText, providerFor, type Preset } from "./presets.js";
import type { RateLimiter, SpendLedger } from "./limits.js";

export type FallbackReason = "cap" | "no_key" | "browser_down" | "model_error";
export type RunEvent =
  | { type: "queued"; position: number }
  | { type: "started"; mode: "FAKE" | "REAL"; model: string; preset: string | null }
  | { type: "frame"; jpeg: string }
  | { type: "progress"; text: string }
  | { type: "audit"; event: AuditEvent }
  | { type: "simulated" }
  | { type: "result"; result: TaskResult; mutations: number }
  | { type: "fallback"; reason: FallbackReason }
  | { type: "end" };

export type SubmitResult =
  | { ok: true; runId: string; position: number }
  | { ok: false; status: 400 | 429 | 503; error: string; message: string; retryAfterMin?: number };

export interface RunManagerDeps {
  cfg: Config;
  bridge: BrowserBridge;
  audit: AuditStore;
  realProvider: ModelProvider | null; // null: no key
  allowFake: boolean; // tests and local use only
  spend: SpendLedger;
  limiter: RateLimiter;
  mutations: () => number; // the synthetic site's change counter
  maxQueue?: number; // waiting runs, default 10
  keepMs?: number; // how long a finished run's events stay for late subscribers, default 120 s
}

interface Run {
  id: string;
  preset: Preset | null;
  text: string;
  events: RunEvent[]; // everything except frames
  lastFrame: string | null;
  listeners: Set<(e: RunEvent) => void>;
  done: boolean;
}

export class RunManager {
  private runs = new Map<string, Run>();
  private queue: Run[] = [];
  private active: Run | null = null;
  constructor(private d: RunManagerDeps) {}

  presets() { return PRESETS.map(({ id, label, shows }) => ({ id, label, shows })); }
  has(id: string) { return this.runs.has(id); }

  /** Why a live run cannot start right now, or null when it can. */
  fallbackReason(): FallbackReason | null {
    if (!this.d.realProvider && !this.d.allowFake) return "no_key";
    if (!this.d.bridge.connected) return "browser_down";
    if (!this.d.spend.canStart()) return "cap";
    return null;
  }

  submit(ip: string, body: { preset?: unknown; text?: unknown }): SubmitResult {
    let preset: Preset | null = null;
    let text: string;
    if (body.preset !== undefined) {
      preset = PRESETS.find((p) => p.id === body.preset) ?? null;
      if (!preset) return { ok: false, status: 400, error: "UNKNOWN_PRESET", message: "Pick one of the listed tasks." };
      text = preset.task;
    } else {
      const v = validateFreeText(body.text);
      if (!v.ok) return { ok: false, status: 400, error: "BAD_TASK", message: v.message };
      text = v.text;
    }
    if (this.queue.length >= (this.d.maxQueue ?? 10)) return { ok: false, status: 503, error: "QUEUE_FULL", message: "The demo is busy. Try again in a minute." };
    const wait = this.d.limiter.take(ip);
    if (wait !== null) return { ok: false, status: 429, error: "RATE_LIMITED", message: `You have used your 5 runs for this hour. Try again in ${wait} min.`, retryAfterMin: wait };

    const run: Run = { id: randomUUID(), preset, text, events: [], lastFrame: null, listeners: new Set(), done: false };
    this.runs.set(run.id, run);
    const reason = this.fallbackReason();
    if (reason) {
      this.emit(run, { type: "fallback", reason });
      this.finish(run);
      return { ok: true, runId: run.id, position: 0 };
    }
    this.queue.push(run);
    this.pump();
    const position = this.active === run ? 0 : this.queue.indexOf(run) + 1;
    if (position > 0) this.emit(run, { type: "queued", position });
    return { ok: true, runId: run.id, position };
  }

  /** Replays what the run has sent so far (plus its latest frame), then streams the rest. Null for an unknown run. */
  subscribe(id: string, fn: (e: RunEvent) => void): (() => void) | null {
    const run = this.runs.get(id);
    if (!run) return null;
    const replay = [...run.events];
    const endAt = replay.findIndex((e) => e.type === "end");
    const head = endAt < 0 ? replay : replay.slice(0, endAt);
    for (const e of head) fn(e);
    if (run.lastFrame) fn({ type: "frame", jpeg: run.lastFrame });
    if (run.done) { fn({ type: "end" }); return () => {}; }
    run.listeners.add(fn);
    return () => { run.listeners.delete(fn); };
  }

  private emit(run: Run, e: RunEvent) {
    if (e.type === "frame") run.lastFrame = e.jpeg;
    else run.events.push(e);
    for (const l of run.listeners) l(e);
  }

  private finish(run: Run) {
    run.done = true;
    this.emit(run, { type: "end" });
    run.listeners.clear();
    setTimeout(() => this.runs.delete(run.id), this.d.keepMs ?? 120_000).unref();
  }

  private pump() {
    if (this.active || this.queue.length === 0) return;
    const run = this.queue.shift()!;
    this.active = run;
    this.queue.forEach((r, i) => this.emit(r, { type: "queued", position: i + 1 }));
    void this.execute(run).finally(() => {
      this.active = null;
      this.finish(run);
      this.pump();
    });
  }

  private async execute(run: Run) {
    const reason = this.fallbackReason(); // conditions may have changed while the run waited
    if (reason) { this.emit(run, { type: "fallback", reason }); return; }
    const taskId = randomUUID();
    const t0 = Date.now();
    const provider = providerFor(run.preset, this.d.realProvider, this.d.cfg.siteOrigin, () => this.emit(run, { type: "simulated" }));
    const off = this.d.audit.onEvent((ev) => { if (ev.task_id === taskId) this.emit(run, { type: "audit", event: ev }); });
    this.d.bridge.onFrame = (jpeg) => this.emit(run, { type: "frame", jpeg });
    this.emit(run, { type: "started", mode: provider.mode, model: provider.model, preset: run.preset?.id ?? null });
    try {
      const runner = new TaskRunner(this.d.cfg, provider, this.d.bridge, this.d.audit, (e) => {
        if (e.task_id === taskId) this.emit(run, { type: "progress", text: e.text });
      });
      const result = await runner.run(run.text, taskId);
      this.emit(run, { type: "result", result, mutations: this.d.mutations() });
      // TaskRunner turns a browser that cannot start into an INTERNAL_ERROR result instead of throwing.
      if (result.code.startsWith("PROVIDER_")) this.emit(run, { type: "fallback", reason: "model_error" });
      else if (result.code === "INTERNAL_ERROR" || !this.d.bridge.connected) this.emit(run, { type: "fallback", reason: "browser_down" });
      // A spend-file write failure must not turn a finished run into a failed one (add() updates the in-memory total first).
      try { this.d.spend.add(result.usage.estimated_cost_usd); } catch {
        log("web_run", { run: run.id.slice(0, 8), preset: run.preset?.id ?? "free", status: "error", code: "SPEND_WRITE_FAILED" });
      }
      log("web_run", { run: run.id.slice(0, 8), preset: run.preset?.id ?? "free", status: result.status, code: result.code, usd: result.usage.estimated_cost_usd, ms: Date.now() - t0 });
    } catch {
      this.emit(run, { type: "fallback", reason: "browser_down" });
      log("web_run", { run: run.id.slice(0, 8), preset: run.preset?.id ?? "free", status: "error", code: "RUN_THREW", ms: Date.now() - t0 });
    } finally {
      off();
      this.d.bridge.onFrame = undefined;
    }
  }
}
