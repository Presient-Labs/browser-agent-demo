# Acceptance report: Milestone 1 browser-agent demo

Independent portfolio demo, synthetic data only. Not a client deployment; no HIPAA claim. Run date 2026-10-06, Ubuntu VPS, Node v22.22.1, Chromium (Chrome for Testing) 153.0.8010.12, Playwright 1.63.0.

## Fake vs real provider
- All results below used the **deterministic FAKE provider** (UI badge "MODE: FAKE") driving a **real** Chromium over CDP against the real synthetic site and real backend/policy/audit code. The real Anthropic adapter was also exercised **offline** through an injected fetch (request shape, error mapping, bounded retries), which is not a live model run.
- **Real-provider end-to-end smoke test: PENDING.** No `ANTHROPIC_API_KEY` is configured. `npm run test:real` output: `PENDING: no ANTHROPIC_API_KEY - real-provider smoke test NOT RUN (this is not a pass).` then `Tests 1 skipped (1)`. No measured real usage/cost exists; cost figures in results are estimates from placeholder rates.
- **OpenAI adapter is a stub** (fails safely, no network). Milestone 2's both-providers requirement is NOT met.
- **Video (MP4): PENDING**, recorded in a later step. `scripts/demo-run.sh` drives the beats (verified to run, fake mode).

## Commands and results (pasted from real runs)
```
npm install && npm run build      # typecheck: clean
xvfb-run -a npm test              # exit=0
```
```
PROFILE-RESIDUE: files with markers = 0
NETWORK: node connect targets = ["127.0.0.1:4100"]
NETWORK: chrome non-loopback peers observed (UNCONTAINED by app-level interception; sampled ss) = []
SUITE RESULT: 10/10 tasks passed (provider=FAKE, browser=real Chromium)
SUITE mutation counter after all 10 tasks (expect 0): 0
 Test Files  11 passed (11)
      Tests  125 passed (125)
LEAK-SCAN OK: no synthetic leak markers in test-output/
```
Per file (from test-output/results.json): backend-auth 17/17, e2e 25/25, extension 6/6, leak-network 6/6, no-temp-guards 1/1, policy 37/37, providers 11/11, security-review 4/4, smoke 1/1, suite 11/11, toctou-egress 6/6. Total 125/125, 0 skipped. Without a display the 6 extension tests are skipped, not passed.

**Declared deterministic suite: 10/10** (tests/suite.test.ts: 3 success, not_found, conflicting->uncertain, non-conflicting field on the same record, prompt injection->blocked, login->human_action_required, write->blocked, off-site->blocked; site mutation counter 0 afterwards).

## Build-sheet acceptance rows -> tests
| # | Row | Where | Result |
|---|---|---|---|
| 1 | Happy path | e2e "1 happy path" (exact fields, browser URL, UTC time), suite 1, extension panel test | pass |
| 2 | Unknown record | e2e "2" (+ unsupported not_found claim not believed) | pass |
| 3 | Ambiguous | e2e "3" (conflict -> uncertain, hallucinated value rejected) | pass |
| 4 | Invalid tool args | policy.test (10 rejects), e2e "4" (site saw 0 requests while bad calls were sent) | pass |
| 5 | Write attempt | e2e "5" (GET-mutating route, auto-submitted form + POST), counter 0, audit event | pass |
| 6 | Off-site | e2e "6": direct, deceptive host, userinfo, bad scheme, malformed, redirect hop, popup, subresource; evil listener hits unchanged | pass |
| 7 | Credential fixture | e2e "7", security-review (iframe), toctou (flip) | pass |
| 8 | Prompt injection | e2e "8" (attack text verified to reach the model; obeying model is blocked; 0 off-site hits; counter 0) | pass |
| 9 | Leak markers | leak-network "9" + post-run `LEAK-SCAN OK`; scan proven able to fail | pass |
| 10 | Unapproved provider | providers "10" (net-guard + fetch spy: 0 connects, audit rejection) | pass |
| 11 | Provider outage | providers "11" (retries = maxRetries+1, no payload leak, 401 not retried) | pass |
| 12 | Backend auth/origin | backend-auth "12" (17 tests incl. WS, Host, CORS, 409) | pass |
| 13 | Stop / budgets | e2e "13" (stop: exactly 3 model calls, 1 inspect; step budget exactly 12 actions; model-call budget) | pass |
| 14 | Runtime network | leak-network "14": Node connects only to 127.0.0.1:4100; CDP bound to loopback | pass (see limits) |

## Guards proven able to FAIL (temporary disable -> red -> restored)
Disabled guards were never committed; `tests/no-temp-guards.test.ts` fails if the string `TEMP:` appears under backend/src (itself proven by planting a file: 1 failed). Restore proof: `git diff --exit-code HEAD -- backend/src/policy/url.ts` exit 0 and full suite green.
- **Write-block** (classifyRequest allows everything): 5 failed | 57 passed -> reds: GET-mutating route test (counter moved), page-initiated POST test, 3 policy tests.
- **Allowlist** (origin comparison removed): 7 failed -> reds: deceptive subdomain (task ran 15s instead of blocking), off-site redirect, prompt injection, wrong port/host/lookalike policy tests.
- **Redirect hop** (found by tests, not by review): before the fix the redirect destination received a request (hit count 1 vs expected 0); fixed with `route.fetch({maxRedirects:0})` + per-hop check.
- **Security-review round 1** (red before fix): WebSocket to a loopback listener -> `expected 1 to be +0`; credential iframe -> `expected 'uncertain' to be 'human_action_required'`; pushState to non-approved route -> `expected 'uncertain' to be 'blocked'`. The client-side `location.assign` auth case was ALREADY green (inspect re-checked the URL); kept as a regression test. Fix: `routeWebSocket` closes all sockets (audit category `websocket`), auth check over all frames, extraction-time URL re-check. 4/4 green after.
- **Security-review round 2** (red before fix): credential injected between guard and extract -> `expected 'success' to be 'human_action_required'`; pushState between guard and extract -> `'success'` vs `'blocked'`; injection after extraction -> `'success'`; WebRTC STUN from a hostile page -> `expected { tcp: +0, udp: 8 } to deeply equal { tcp: +0, udp: +0 }`. Fix: single-turn `{href, auth, data}` evaluate + post-check that drops data; browser egress flags (dead proxy, `<-loopback>` bypass list, host-resolver rules, WebRTC policy). 6/6 green after. A test-only `bridge.testSeam` (not reachable from model/API/extension) makes the race deterministic. The `preconnect`/`dns-prefetch` vectors never produced a connection even without the flags, so they were not demonstrated red.

## Measurements
- Profile residue: `PROFILE-RESIDUE: files with markers = 0` in the disposable Chrome profile after the leak tasks (one measurement; not proof of no local copy).
- Uncontained Chrome traffic: **before** the proxy flags, sampled `ss` showed Chromium sockets to Google endpoints (172.253.122.102:443, 2607:f8b0:...:443/:5228, 2001:4860:...:443) in an idle window. **After**: none observed in the same sampling. Sampling is not a guarantee.

## Known limitations / material gaps
Real-provider test and MP4 video pending; OpenAI stub; local loopback-CDP prototype only (see ARCHITECTURE.md production gaps); browser-flag egress containment is best effort, production needs OS-level egress control; panel shown as an extension page in a tab under Xvfb (native side-panel UI cannot be driven by automation); audit/state in memory only; resume after login, writes, downloads, vision, persistence unsupported (shown in the panel's "Unsupported" list). Estimated cost uses placeholder rates.
