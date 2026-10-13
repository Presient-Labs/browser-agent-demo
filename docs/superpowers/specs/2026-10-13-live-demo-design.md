# Live browser-agent demo at agent.shawndemos.com: design

**Status:** design approved by the operator on 2026-10-13 (approach A; presets plus free text; $3/day cap; sections 1–4).

## Why

Upwork clients judge a proposal in minutes. A video shows the agent, but a client cannot try it. This page lets anyone run the real agent against the synthetic records site from a phone or laptop, with nothing to install. It is portfolio proof for the agency site at shawndemos.com, which will link to it.

## Scope

**In:**
- a public web page;
- a public server that queues runs through the existing agent;
- a live view of the agent's browser;
- spend, rate and queue limits;
- a recorded-run fallback;
- a Docker deployment behind Traefik at agent.shawndemos.com.

**Out:**
- changes to the agent's policy engine, tools or model adapters;
- the Chrome extension, which stays unchanged and is not used in the hosted path;
- accounts or logins;
- any real or third-party site;
- the shawndemos.com catalog, which is a separate project.

## Architecture

New code lives in `web/` in this repo. It imports the existing backend code and copies none of it.

```
visitor's browser ──HTTPS──> Traefik ──> web server (container, port 4300)
                                           ├─ serves the page (web/public)
                                           ├─ POST /api/runs, GET /api/runs/:id/stream (SSE)
                                           ├─ run queue (one live run at a time)
                                           ├─ limits: daily spend cap, per-IP rate, queue length
                                           └─ TaskRunner (existing coordinator, policy unchanged)
                                                 └─ BrowserBridge ──CDP (loopback)──> headless Chromium
                                                                                      └─ synthetic site 127.0.0.1:4100
```

- **One container** runs the web server, the synthetic site (`site/`, loopback only), and Playwright's Chromium.
  - The existing launcher starts Chromium, with the same containment flags: dead proxy, resolver rules, WebRTC off, fresh profile.
- **Exposed:** only port 4300, through Traefik.
- **Not used in the hosted path:** the existing loopback backend server (`backend/src/server.ts`). The web server drives `TaskRunner` in-process instead.
- **Live view:**
  - The task tab is captured with CDP `Page.startScreencast`: JPEG, at most 1280×800, at most 5 frames per second.
  - Frames are forwarded on the run's event stream. Nothing is stored.
  - The bridge gains one small hook: start or stop a screencast on the task tab, and hand frames to a callback. Existing behaviour is unchanged when the hook is unused.
- **Model:** the Anthropic adapter with `claude-sonnet-5-5`, the model of the verified real run.
  - The key comes from the container's environment and is workspace-scoped. It is never logged or printed.
  - The fake provider is used in tests and when no key is set; the page then labels runs FAKE.

## Visitor flow

1. **Header:** what this is, "Synthetic data — not a real patient system", and a link to GitHub.
2. **Presets.** Five buttons, each labelled with the capability it shows. The exact task texts and record IDs are fixed in `web/presets.ts`, and each preset has an end-to-end test.
   - Look up a claim's status: success, with source URL and time.
   - Try to submit a form: blocked, and the site's mutation counter stays 0.
   - Try to leave the allowed sites: blocked.
   - Hit a sign-in wall: the agent stops with `human_action_required`.
   - Summarise a record with its sources.
3. **Free text:**
   - at most 300 characters;
   - exactly one `SYN-####` ID, as the agent already requires;
   - anything else is rejected before queueing, with a plain message saying why.
4. **During a run:**
   - the live browser view;
   - the queue position or status;
   - each step as it happens, with every policy block highlighted.
5. **At the end:** the result card (status, values, source URL, UTC time) and the run's metadata-only audit events.
6. **Footer:**
   - the full demo video;
   - "The product is a Chrome side panel; this page runs the same agent on a server so you can try it", with a short clip from the existing video;
   - a link to the honest-limits section of `ARCHITECTURE.md`.

## Limits and fallback

| Limit | Value | When reached |
|---|---|---|
| Live runs at once | 1 | Later runs queue |
| Queue length | 10 | The page asks the visitor to retry in a minute |
| Runs per IP | 5 per rolling hour | Message with the minutes left |
| Daily model spend (UTC day) | $3.00 | Recorded run, labelled "Recorded run — live demo resumes tomorrow" |
| Per-run budget | 8 model calls, 90 s wall time (existing budgets) | Run ends `blocked`/`timeout`, as today |

- **Spend tracking.** Spend is counted from each provider call's reported token usage at the configured rates. It is kept in a small JSON file, so a restart does not reset the day.
- **When a run may start.** Only if the day's spend so far is below $3.00 minus the per-run maximum. The cap is therefore never exceeded.
- **Client IP.** It is taken from Traefik's `X-Forwarded-For`, using only the hop Traefik adds. A client-supplied header is never trusted directly.
- **The recorded run.** This is the 2026-10-07 real run, re-encoded as a short clip with its event log. It plays in the same layout whenever a live run cannot start:
  - the cap is reached;
  - no key is set;
  - the model or browser fails to start;
  - the browser bridge is not connected.

## Privacy and safety

- **The agent's safety is unchanged:**
  - read-only tools;
  - the URL policy on every request;
  - a fresh, non-persistent browser context per run;
  - the browser can reach only the synthetic site.
- **What is kept:**
  - no task text or page content is stored;
  - server logs and the spend file hold only run ID, preset ID or "free", outcome code, cost and duration;
  - IPs are held in memory only, for the rate window.
- **What visitors see on errors:** generic error codes, never a stack trace.
- **Page hardening:**
  - a strict Content-Security-Policy (self only, plus `data:` for frames);
  - no third-party scripts;
  - HTTPS through Traefik.

## Failure handling

- **Stuck run:** a run that exceeds its wall time is aborted through the existing abort path, and the queue moves on.
- **Chromium exits:**
  - the server restarts it once;
  - if that fails, every request gets the recorded run until the container restarts;
  - a health endpoint reports `browser: down`.
- **Visitor disconnects:** the run continues to the end, and its result is dropped.

## Testing

**Unit tests**, written test-first in `tests/` with vitest, like the existing suite:
- queue order and the queue length limit;
- the per-IP rate window;
- spend accounting and the cap rule, including persistence across a restart;
- the fallback decision for each failure cause;
- free-text validation;
- forwarded-IP parsing.

**End-to-end test** (Playwright, fake provider):
- open the page;
- run the claim-lookup preset and see a live frame and a success result;
- run the blocked-write preset and see the block highlighted, with the mutation counter at 0.

**Existing tests:** all 185 must keep passing.

**After deployment:**
- one real-model run of each preset on the live URL;
- a check on a phone-sized viewport.

**Review:** an independent Opus review of `web/` and the bridge hook before the DNS record goes live, because the server faces the internet.

## Done when

- A phone visitor can run all five presets and a free-text task at agent.shawndemos.com and see the live browser view.
- The cap, the rate limit, the queue limit and the recorded-run fallback each trigger, both in tests and once on the live server.
- The existing tests and the new tests pass.
- The review has no open Critical or Important findings.
