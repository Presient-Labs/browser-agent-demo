# Architecture note (Milestone 1 portfolio prototype)

## Components and boundaries
```
Extension side panel (MV3)  --HTTP+WS, 127.0.0.1:4200-->  Backend (coordinator)
   memory-only UI state                                     |-- Policy engine (URL/route/read-only/auth)
   secret pasted by operator                                |-- Model adapter (fake | anthropic | openai-stub)
                                                            |-- Playwright bridge --CDP, 127.0.0.1:9333--> dedicated Chromium
                                                            `-- Audit store (metadata only, in memory)
Synthetic site 127.0.0.1:4100 (SYN-#### records, fixtures, mutation counter)
```
- **Extension <-> backend.** The backend generates a random session secret at startup and prints it once to the operator's terminal. The operator pastes it in the panel (kept in JS memory only). Every HTTP call needs `x-demo-session`; mutating calls also need `Content-Type: application/json`. Origin must be exactly `chrome-extension://<id>` (id derived from the manifest `key`), Host must be loopback (anti DNS-rebinding), preflights are granted to that origin only, WebSocket upgrades check Origin and then require an auth frame. Errors are generic (`{"error":"CODE"}`). Everything binds to 127.0.0.1.
- **Local prototype vs production.** The prototype is the operator's own machine/VPS driving a dedicated Chromium over a loopback CDP endpoint. It is **not** a cloud backend remotely controlling a user's browser. A production design needs a different browser-control and trust model (isolated, ephemeral, network-fenced browser workers; client-controlled secrets store; persistence, auth and audit in the client's environment). None of that is built here.
- **Browser.** Playwright's bundled Chromium, fresh `mktemp` profile deleted on exit. The bridge connects over CDP and controls only one tab it creates, inside a **fresh isolated (non-persistent) browser context per task** with downloads and service workers disabled. The default context (extension, about:blank) is never driven by the agent.

## Model routing
Provider interface (`providers/types.ts`): `complete(system, messages, tools) -> tool calls + usage`. `resolveProvider` rejects unknown provider / unapproved `provider:model` / missing key **before any client is constructed**, so no network call can occur; a metadata-only rejection event is audited. Endpoints are code constants (no user-supplied endpoints). The Anthropic adapter uses `@anthropic-ai/sdk` tool use with SDK retries off (the coordinator owns bounded retries) and informational platform headers blanked (the SDK has no telemetry channel). Tool-result text is marked untrusted. The **OpenAI adapter is a stub that fails safely, so Milestone 2's "both providers by configuration" requirement is NOT met.** The deterministic fake provider powers the tests and offline demo and is always labelled FAKE.

## Constrained tools
`navigate`, `inspect`, `lookup_record`, `open_record`, `finish` only, each with a strict zod schema (unknown keys rejected). No JS eval, selectors, click/type, or raw Playwright. `open_record` takes an opaque link id resolved server-side. `source_url` and `retrieved_at` are set by the coordinator from the browser's URL and clock; `finish` has no such fields. The coordinator re-validates `finish` against extracted evidence: wrong values -> `uncertain`; conflicting source values -> `uncertain` (never picks a side); `not_found` is accepted only after a completed search with zero exact matches. Reported values are the evidence values.

## Enforcement points (all below the model)
1. Tool-argument validation (before any browser action).
2. URL policy pre-check on every navigation-like tool: exact scheme/host/port, no userinfo, no deceptive hosts, malformed rejected; approved read routes only; route-semantic write detection (a GET to `/delete` is a write, a POST anywhere is a write).
3. `context.route('**/*')` for **every** request (navigations, subresources, form posts, fetch): allowed requests are fetched with `maxRedirects: 0` and each redirect hop is policy-checked **before** it is sent (a plain `route.continue()` was observed to let an off-site redirect hop reach its destination; this was found by the tests and fixed).
4. `context.routeWebSocket` closes every page WebSocket (the site needs none) without connecting.
5. Popups are closed immediately and audited; any block ends the task as `blocked` (fail closed).
6. Auth boundary: before any extraction the URL and **every frame** are checked for credential/OTP fields (boolean only, no DOM content leaves the page); then a single page evaluation returns `{href, auth, data}` so a timer cannot slip between check and read; the URL and all frames are re-checked after extraction and data is dropped on any difference. Result: `human_action_required`; resume is out of scope.
7. Browser-level containment in `launch.ts`: dead proxy `127.0.0.1:9` with `--proxy-bypass-list=<-loopback>;127.0.0.1:<site>;127.0.0.1:<backend>` (`<-loopback>` removes Chrome's implicit loopback bypass), `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`, `--dns-prefetch-disable`, WebRTC non-proxied-UDP disabled, background networking/sync/component update/pings/domain reliability off.
8. Budgets: steps, model calls, retries (bounded backoff), wall time, extracted size; Stop aborts the in-flight model call and no browser/model action follows.

## Transient data flow
Page text -> in-process memory -> (tool result) model provider -> coordinator verifies -> result card in panel. Not written to disk, browser storage, logs or audit. Audit events hold only task_id, action_id, category, outcome, safe code (closed vocabulary; free text is coerced to `UNKNOWN_CODE`), timestamp, duration. The source URL is in the displayed result only. Progress messages are templated and content-free.

## Production gaps (honest list)
- **Chrome profile artifacts.** A disposable profile and a non-persistent context are used and a scan of the profile after the test run found no markers (`PROFILE-RESIDUE: 0`), but that is one measurement, not proof of "no local copy" (swap/page files, GPU/crash artifacts, OS caches are not inspected). Production needs ephemeral, encrypted, destroy-on-completion workers.
- **Background/uncontained traffic.** App-level interception cannot see browser-internal traffic. Before the proxy flags, sampled sockets showed Chromium contacting Google endpoints (:443 and :5228) during an idle window; with the flags the same sampling saw none. Flag-based containment is best effort and depends on Chrome behaviour: the extension service worker and Chrome-internal fetches share the same flags but are not individually interceptable. The production answer is an OS/network-level egress firewall (default-deny, allow-listed destinations), not browser flags.
- `<link rel=preconnect>` did not produce a connection in our run even without the flags (so that vector was not demonstrated red); UDP/STUN from WebRTC did (8 datagrams) and is now contained.
- Loopback CDP is a powerful local capability; any local process running as the same user can reach it.
- Anthropic SDK/endpoint use needs the client's secrets store and healthcare agreements; no BAA is implied. Audit store is in-memory; no persistence, crash recovery, write approvals, downloads, vision, resume, mid-task redirect.
- The panel is a standard MV3 side-panel page; the demo script opens it in a tab because Chrome offers no automation hook to open the native side-panel UI.
- Controlled-site read-only semantics (route allowlist) do **not** make arbitrary third-party portals read-only; site-specific adapters and a network boundary are future work.
- Only the Anthropic adapter is real; the OpenAI adapter is a stub.
