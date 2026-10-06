// Side panel UI. State lives in memory only: no chrome.storage, localStorage or cookies are used.
const BACKEND = "http://127.0.0.1:4200";
const WS_URL = "ws://127.0.0.1:4200/ws";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let secret = "";
let ws: WebSocket | undefined;
let running = false;

function setState(s: string) {
  const el = $("state"); el.textContent = s.replace(/_/g, " "); el.className = `state ${s}`;
}
function setRunning(r: boolean) {
  running = r;
  ($("run-btn") as HTMLButtonElement).disabled = r;
  ($("stop-btn") as HTMLButtonElement).disabled = !r;
  if (r) setState("running");
}
function td(text: string) { const c = document.createElement("td"); c.textContent = text; return c; }

function addAudit(e: any) {
  const tr = document.createElement("tr");
  [e.ts.slice(11, 23), String(e.task_id).slice(0, 6), String(e.action_id).slice(0, 6), e.category, e.outcome, e.code, String(e.duration_ms)].forEach((t) => tr.appendChild(td(t)));
  $("audit-rows").appendChild(tr);
}
function addProgress(text: string) {
  const li = document.createElement("li"); li.textContent = text; $("progress").appendChild(li);
}

function showResult(r: any) {
  setRunning(false);
  setState(r.status);
  $("result-card").hidden = false;
  const body = $("result-body"); body.textContent = "";
  const card = document.createElement("div"); card.className = "card";
  const dl = document.createElement("dl");
  const add = (k: string, v: string | HTMLElement) => {
    const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd");
    if (typeof v === "string") dd.textContent = v; else dd.appendChild(v);
    dl.append(dt, dd);
  };
  add("status", r.status);
  add("record_id", r.record_id ?? "—");
  for (const f of r.requested_fields) add(f, r.fields?.[f] ?? "(not reported)");
  if (r.source_url) {
    const a = document.createElement("a"); a.href = r.source_url; a.textContent = r.source_url; a.target = "_blank"; a.rel = "noreferrer noopener";
    add("source_url", a);
  } else add("source_url", "—");
  if (r.retrieved_at) {
    const d = new Date(r.retrieved_at);
    add("retrieved_at", `${r.retrieved_at} (${d.toUTCString()})`);
  } else add("retrieved_at", "—");
  card.appendChild(dl); body.appendChild(card);
  if (r.status !== "success") {
    const n = document.createElement("div"); n.className = "note";
    n.textContent = `${r.message} Next: ${r.next_action}`; body.appendChild(n);
  }
  const u = r.usage;
  const c = document.createElement("p"); c.className = "muted";
  c.textContent = `steps ${u.steps}, model calls ${u.model_calls}, tokens in/out ${u.input_tokens}/${u.output_tokens}, cost ≈ $${u.estimated_cost_usd} (estimate, configurable rates)`;
  body.appendChild(c);
}

function applyState(s: any) {
  const b = $("mode-badge");
  b.textContent = `MODE: ${s.mode} · ${s.provider} · ${s.model}`;
  b.className = `badge ${s.mode === "FAKE" ? "fake" : "real"}`;
  const ul = $("unsupported-list"); ul.textContent = "";
  for (const u of s.unsupported ?? []) { const li = document.createElement("li"); li.textContent = u; ul.appendChild(li); }
  $("unsupported").hidden = false;
  setRunning(!!s.running);
  if (!s.running && !running) setState($("state").className.includes("running") ? "idle" : ($("state").className.split(" ")[1] || "idle"));
}

function connect() {
  secret = ($("secret") as HTMLInputElement).value.trim();
  ($("secret") as HTMLInputElement).value = "";
  if (!secret) return;
  ws?.close();
  ws = new WebSocket(WS_URL);
  ws.onopen = () => ws!.send(JSON.stringify({ type: "auth", secret }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "state") {
      $("conn-msg").textContent = "Connected."; $("task").hidden = false; $("audit").hidden = false;
      applyState(m.state);
    } else if (m.type === "progress") addProgress(m.text);
    else if (m.type === "result") showResult(m.result);
    else if (m.type === "audit") addAudit(m.event);
    else if (m.type === "audit_backlog") m.events.forEach(addAudit);
  };
  ws.onclose = () => { if ($("task").hidden) $("conn-msg").textContent = "Connection refused. Check the secret and that the backend is running."; };
}

async function api(path: string, body?: unknown) {
  const r = await fetch(BACKEND + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-demo-session": secret },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
}

$("connect-btn").addEventListener("click", connect);
($("secret") as HTMLInputElement).addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
$("run-btn").addEventListener("click", async () => {
  if (running) return;
  $("progress").textContent = ""; $("result-card").hidden = true;
  setRunning(true);
  const r = await api("/api/tasks", { task: ($("task-input") as HTMLTextAreaElement).value });
  if (!r.ok) {
    setRunning(false); setState("error");
    $("result-card").hidden = false;
    $("result-body").textContent = r.json?.error === "BROWSER_NOT_CONNECTED"
      ? "The dedicated browser is not reachable. Launch it with scripts/launch-browser.sh, then retry."
      : `Request rejected (${r.json?.error ?? r.status}).`;
  }
});
$("stop-btn").addEventListener("click", () => { void api("/api/tasks/stop", {}); });
