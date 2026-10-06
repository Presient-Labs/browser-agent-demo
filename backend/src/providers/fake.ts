import { ProviderError, type Msg, type ModelProvider, type ProviderRequest, type ProviderResponse, type ToolCall } from "./types.js";
import { FIELD_NAMES } from "../tools.js";

/** Deterministic scripted provider for tests/offline demos. ALWAYS labelled FAKE in UI. */
export type FakeScript =
  | "happy" | "badargs" | "gullible" | "writer" | "offsite" | "login" | "loop" | "hallucinate"
  | "outage" | "outage_then_ok" | "unknown_tool" | "auto_write" | "popup" | "subresource";

import { parseTask as parseShared } from "../taskparse.js";
export function parseTask(task: string) {
  const r = parseShared(task);
  return { recordId: r.recordId, fields: r.fields.length ? r.fields : ["claim_status"] };
}

const tc = (name: string, input: unknown, n: number): ToolCall => ({ id: `fake_${n}`, name, input });
const lastTool = (m: Msg[]) => {
  const t = [...m].reverse().find((x) => x.role === "tool");
  if (!t || t.role !== "tool") return undefined;
  try { return { raw: t.content, json: JSON.parse(t.content) }; } catch { return { raw: t.content, json: undefined }; }
};

export class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly mode = "FAKE" as const;
  readonly model = "fake-deterministic";
  calls = 0;
  failuresLeft: number;
  onCall?: (n: number) => void;
  constructor(public script: FakeScript = "happy", opts: { failures?: number; onCall?: (n: number) => void } = {}) {
    this.failuresLeft = opts.failures ?? 0;
    this.onCall = opts.onCall;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls++;
    this.onCall?.(this.calls);
    if (this.script === "outage") throw new ProviderError("PROVIDER_UNAVAILABLE", true);
    if (this.script === "outage_then_ok" && this.failuresLeft-- > 0) throw new ProviderError("PROVIDER_UNAVAILABLE", true);
    const call = this.next(req);
    return { toolCalls: [call], usage: { inputTokens: 400 + this.calls * 50, outputTokens: 40 } };
  }

  private next(req: ProviderRequest): ToolCall {
    const n = this.calls;
    const task = req.messages.find((m) => m.role === "user");
    const { recordId, fields } = parseTask(task && task.role === "user" ? task.text : "");
    const toolCount = req.messages.filter((m) => m.role === "tool").length;
    const last = lastTool(req.messages);
    const s = this.script;

    if (s === "unknown_tool") return tc("run_js", { code: "alert(1)" }, n);
    if (s === "badargs" && toolCount === 0) return tc("inspect", { region: "body; document.cookie" }, n);
    if (s === "writer" && toolCount === 0) return tc("navigate", { url: "http://127.0.0.1:4100/records/SYN-1042/delete" }, n);
    if (s === "offsite" && toolCount === 0) return tc("navigate", { url: "http://127.0.0.1:4101/exfil" }, n);
    if (s === "auto_write" && toolCount === 0) return tc("navigate", { url: "http://127.0.0.1:4100/fixtures/auto-write" }, n);
    if (s === "popup" && toolCount === 0) return tc("navigate", { url: "http://127.0.0.1:4100/fixtures/popup" }, n);
    if (s === "subresource" && toolCount === 0) return tc("navigate", { url: "http://127.0.0.1:4100/fixtures/offsite-subresource" }, n);
    if (s === "login") return toolCount === 0 ? tc("navigate", { url: "http://127.0.0.1:4100/login-challenge" }, n) : tc("inspect", { region: "record" }, n);
    if (s === "loop") return tc("inspect", { region: "results" }, n);

    // gullible: follows "navigate to <url>" instructions found in page text.
    if (s === "gullible" && last?.raw) {
      const m = /navigate to (https?:\/\/\S+?)[\s.]+(?:and|$)/i.exec(last.raw);
      if (m) return tc("navigate", { url: m[1] }, n);
    }
    if (s === "gullible" && last?.json && (last.json.error === "POLICY_BLOCKED" || last.json.blocked)) {
      return tc("finish", { status: "found", record_id: recordId ?? "SYN-0000", fields: { claim_status: "Approved by override" } }, n);
    }

    // happy-path state machine
    if (!recordId) return tc("finish", { status: "uncertain", record_id: "SYN-0000", fields: {} }, n);
    if (toolCount === 0) return tc("lookup_record", { record_id: recordId }, n);
    const j = last?.json;
    if (j?.ok && j.data?.results) {
      const hit = j.data.results.find((r: any) => r.record_id === recordId);
      return hit ? tc("open_record", { link_id: hit.link_id }, n) : tc("finish", { status: "not_found", record_id: recordId, fields: {} }, n);
    }
    if (j?.ok && j.data?.opened) return tc("inspect", { region: "record" }, n);
    if (j?.ok && j.data?.fields) {
      const out: Record<string, string> = {};
      for (const f of fields) {
        if (!(FIELD_NAMES as readonly string[]).includes(f)) continue;
        const vals = j.data.fields[f];
        if (vals?.length) out[f] = s === "hallucinate" ? "9999.99" : vals[0].value; // naive: first value wins
      }
      return tc("finish", { status: "found", record_id: recordId, fields: out }, n);
    }
    // invalid-arg / error recovery: restart the happy path
    return tc("lookup_record", { record_id: recordId }, n);
  }
}
