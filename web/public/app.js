// Live demo client. All server data is written with textContent, never innerHTML.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

const FALLBACK = {
  cap: "Today's live runs are used up. Here is a recorded real run; the live demo resumes tomorrow (UTC).",
  no_key: "The live demo is offline right now. Here is a recorded real run.",
  browser_down: "The live demo is offline right now. Here is a recorded real run.",
  model_error: "The AI model service did not answer. Here is a recorded real run.",
};
const SIMULATED = "Simulated misbehaving model (the real model refuses this)";
let stream = null;
let busy = false;

function setBusy(on) {
  busy = on;
  document.querySelectorAll("#presets button, #free button").forEach((b) => { b.disabled = on; });
}

function showMsg(text) { const m = $("form-msg"); m.textContent = text; m.hidden = !text; }

function resetRun() {
  $("run").hidden = false;
  $("recorded").hidden = true;
  $("steps").replaceChildren();
  $("audit").tBodies[0].replaceChildren();
  $("result").hidden = true;
  $("result").replaceChildren();
  $("frame").removeAttribute("src");
  $("mode").textContent = "";
}

function showFallback(reason) {
  $("recorded").hidden = false;
  $("recorded-why").textContent = FALLBACK[reason] ?? FALLBACK.no_key;
  $("status").textContent = "Showing the recorded run.";
}

function addStep(text, cls) { const li = el("li", cls, text); $("steps").append(li); li.scrollIntoView({ block: "nearest" }); }

function addAudit(ev) {
  const tr = el("tr", ev.outcome === "blocked" ? "blocked" : ev.outcome === "paused" ? "paused" : "");
  for (const v of [ev.ts.slice(11, 19), ev.category, ev.outcome, ev.code]) tr.append(el("td", "", v));
  $("audit").tBodies[0].append(tr);
  if (ev.outcome === "blocked") addStep(`Blocked by policy: ${ev.category} (${ev.code})`, "blocked");
}

const STATUS_TEXT = {
  success: "Done — the answer below came from the page.",
  blocked: "Blocked — the policy stopped a forbidden action. Nothing on the site changed.",
  human_action_required: "Paused — a sign-in page needs a person. The agent read nothing from it.",
  uncertain: "Uncertain — the agent could not confirm a single value from the page, so it reports none rather than guess.",
  not_found: "Not found — no record with that ID exists.",
  error: "Stopped — the task ended early.",
  stopped: "Stopped.",
};

function showResult(r, mutations) {
  const box = $("result");
  box.replaceChildren();
  box.className = `result s-${r.status}`;
  box.append(el("p", "result-status", STATUS_TEXT[r.status] ?? r.status));
  const dl = el("dl");
  const row = (k, v) => { dl.append(el("dt", "", k), el("dd", "", v)); };
  row("Record", r.record_id ?? "—");
  for (const [k, v] of Object.entries(r.fields ?? {})) row(k.replace(/_/g, " "), v);
  row("Source page", r.source_url ?? "—");
  row("Read at (UTC)", r.retrieved_at ?? "—");
  row("Reason code", r.code);
  row("Site change counter", String(mutations));
  row("Model calls · est. cost", `${r.usage.model_calls} · $${r.usage.estimated_cost_usd.toFixed(3)}`);
  box.append(dl);
  box.hidden = false;
}

function listen(runId) {
  stream?.close();
  stream = new EventSource(`api/runs/${runId}/events`);
  // After a dropped connection EventSource reconnects and the server replays the run from the start, so each (re)connect
  // starts from a clean display instead of appending the replay to what is already shown.
  stream.onopen = () => {
    $("steps").replaceChildren();
    $("audit").tBodies[0].replaceChildren();
    $("result").hidden = true;
    $("result").replaceChildren();
  };
  stream.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === "queued") $("status").textContent = e.position === 1 ? "You're next — one run at a time." : `You're number ${e.position} in line — one run at a time.`;
    else if (e.type === "started") { $("status").textContent = "Running…"; $("mode").textContent = e.mode === "REAL" ? `Real model: ${e.model}` : "FAKE model (offline test mode)"; }
    else if (e.type === "frame") $("frame").src = `data:image/jpeg;base64,${e.jpeg}`;
    else if (e.type === "progress") addStep(e.text);
    else if (e.type === "simulated") addStep(SIMULATED, "simulated");
    else if (e.type === "audit") addAudit(e.event);
    else if (e.type === "result") { $("status").textContent = ""; showResult(e.result, e.mutations); }
    else if (e.type === "fallback") showFallback(e.reason);
    else if (e.type === "end") { stream.close(); stream = null; setBusy(false); }
  };
  stream.onerror = () => { if (stream && stream.readyState === EventSource.CLOSED) { stream = null; setBusy(false); } };
}

async function start(body) {
  if (busy) return;
  showMsg("");
  setBusy(true);
  try {
    const r = await fetch("api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 202) { showMsg(j.message ?? "Something went wrong. Try again in a minute."); setBusy(false); return; }
    resetRun();
    $("status").textContent = "Starting…";
    listen(j.run_id);
    $("run").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {
    showMsg("Could not reach the demo. Check your connection and try again.");
    setBusy(false);
  }
}

async function init() {
  const list = await (await fetch("api/presets")).json();
  for (const p of list) {
    const b = el("button", "preset");
    b.type = "button";
    b.append(el("span", "preset-label", p.label), el("span", "preset-shows", p.shows));
    b.addEventListener("click", () => start({ preset: p.id }));
    $("presets").append(b);
  }
  $("free").addEventListener("submit", (ev) => { ev.preventDefault(); start({ text: $("free-text").value }); });
}
init();
