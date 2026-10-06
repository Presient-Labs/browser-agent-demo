import { randomUUID } from "node:crypto";

export type ActionCategory =
  | "task" | "model_call" | "navigate" | "inspect" | "lookup_record" | "open_record" | "finish"
  | "subresource" | "popup" | "auth_check" | "provider_config" | "api_auth";
export type Outcome = "allowed" | "blocked" | "paused" | "ok" | "rejected" | "error" | "stopped";

/** Metadata ONLY. Fields are closed enums / ids / numbers; there is no free-text field by construction. */
export interface AuditEvent {
  event_id: string;
  task_id: string;
  action_id: string;
  category: ActionCategory;
  outcome: Outcome;
  code: string; // safe error / policy code from a closed vocabulary, or "OK"
  ts: string; // UTC ISO 8601
  duration_ms: number;
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,48}$/;

export class AuditStore {
  private events: AuditEvent[] = [];
  private listeners = new Set<(e: AuditEvent) => void>();
  record(e: { task_id: string; action_id?: string; category: ActionCategory; outcome: Outcome; code?: string; started?: number }) {
    const code = e.code ?? "OK";
    const ev: AuditEvent = {
      event_id: randomUUID(),
      task_id: e.task_id,
      action_id: e.action_id ?? randomUUID(),
      category: e.category,
      outcome: e.outcome,
      code: SAFE_CODE.test(code) ? code : "UNKNOWN_CODE", // refuse free text
      ts: new Date().toISOString(),
      duration_ms: e.started ? Math.max(0, Date.now() - e.started) : 0,
    };
    this.events.push(ev);
    this.listeners.forEach((l) => l(ev));
    return ev;
  }
  list(task_id?: string) { return this.events.filter((e) => !task_id || e.task_id === task_id); }
  onEvent(fn: (e: AuditEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
