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
 Test Files  18 passed (18)
      Tests  183 passed (183)
LEAK-SCAN OK: no synthetic leak markers in captured stdout/stderr or test-output/
TEST EXIT: vitest=0 leak=0
```
Per file (redacted test-output/results.json): backend-auth 18/18, e2e 25/25, extension 6/6, launcher 1/1, leak-network 6/6, leakwrap 1/1, no-temp-guards 1/1, panel-link 12/12, policy 37/37, providers 11/11, review-fixes 20/20, round2-browser 11/11, round2-extract 7/7, round2-lifecycle 4/4, round2-panel 2/2, security-review 4/4, suite 11/11, toctou-egress 6/6. Total 183/183, 0 skipped (after round 2).
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
| 9 | Leak markers | leak-network "9" + `scripts/run-tests.ts` scan of captured stdout/stderr and test-output/ (runs on failing runs too; proven able to fail with a planted marker). CORRECTION: an earlier version of this report marked this pass while tests printed result content to stdout and the scan only covered test-output/; fixed, see Review fixes #4 | pass (after fix) |
| 10 | Unapproved provider | providers "10" (net-guard + fetch spy: 0 connects, audit rejection) | pass |
| 11 | Provider outage | providers "11" (retries = maxRetries+1, no payload leak, 401 not retried) | pass |
| 12 | Backend auth/origin | backend-auth "12" (18 tests incl. WS, Host, CORS, 409). CORRECTION: earlier a missing HTTP Origin was accepted; fixed (#10) | pass (after fix) |
| 13 | Stop / budgets | e2e "13" + review-fixes #5/#6. CORRECTION: earlier Stop during navigation and the wall-time budget were not enforced mid-operation; fixed | pass (after fix) |
| 14 | Runtime network | leak-network "14": Node connects only to 127.0.0.1:4100; CDP bound to loopback | pass (see limits) |

## Guards proven able to FAIL (temporary disable -> red -> restored)
Disabled guards were never committed; `tests/no-temp-guards.test.ts` fails if the string `TEMP:` appears under backend/src (itself proven by planting a file: 1 failed). Restore proof: `git diff --exit-code HEAD -- backend/src/policy/url.ts` exit 0 and full suite green.
- **Write-block** (classifyRequest allows everything): 5 failed | 57 passed -> reds: GET-mutating route test (counter moved), page-initiated POST test, 3 policy tests.
- **Allowlist** (origin comparison removed): 7 failed -> reds: deceptive subdomain (task ran 15s instead of blocking), off-site redirect, prompt injection, wrong port/host/lookalike policy tests.
- **Redirect hop**: first-hop-only check was found by tests; the full chain bypass was found by external review (see Review fixes #1).
- **Security-review round 1** (red before fix): WebSocket to a loopback listener -> `expected 1 to be +0`; credential iframe -> `expected 'uncertain' to be 'human_action_required'`; pushState to non-approved route -> `expected 'uncertain' to be 'blocked'`. The client-side `location.assign` auth case was ALREADY green (inspect re-checked the URL); kept as a regression test. Fix: `routeWebSocket` closes all sockets (audit category `websocket`), auth check over all frames, extraction-time URL re-check. 4/4 green after.
- **Security-review round 2** (red before fix): credential injected between guard and extract -> `expected 'success' to be 'human_action_required'`; pushState between guard and extract -> `'success'` vs `'blocked'`; injection after extraction -> `'success'`; WebRTC STUN from a hostile page -> `expected { tcp: +0, udp: 8 } to deeply equal { tcp: +0, udp: +0 }`. Fix: single-turn `{href, auth, data}` evaluate + post-check that drops data; browser egress flags (dead proxy, `<-loopback>` bypass list, host-resolver rules, WebRTC policy). 6/6 green after. A test-only `bridge.testSeam` (not reachable from model/API/extension) makes the race deterministic. The `preconnect`/`dns-prefetch` vectors never produced a connection even without the flags, so they were not demonstrated red.

## Measurements
- Profile residue: `PROFILE-RESIDUE: files with markers = 0` in the disposable Chrome profile after the leak tasks (one measurement; not proof of no local copy).
- Uncontained Chrome traffic: **before** the proxy flags, sampled `ss` showed Chromium sockets to Google endpoints (172.253.122.102:443, 2607:f8b0:...:443/:5228, 2001:4860:...:443) in an idle window. **After**: none observed in the same sampling. Sampling is not a guarantee.

## Known limitations / material gaps
Real-provider test and MP4 video pending; OpenAI stub; local loopback-CDP prototype only (see ARCHITECTURE.md production gaps); browser-flag egress containment is best effort, production needs OS-level egress control; panel shown as an extension page in a tab under Xvfb (native side-panel UI cannot be driven by automation); audit/state in memory only; resume after login, writes, downloads, vision, persistence unsupported (shown in the panel's "Unsupported" list). Estimated cost uses placeholder rates.

## Review fixes (external adversarial review of f209973, 12 findings)
Each row: red = the new test failing against the f209973 code (pasted failure message), green = same test passing after the fix. Tests in `tests/review-fixes.test.ts` unless noted. Round 1 closed these 12 as reported by the author; an independent re-review (round 2, below) confirmed #1, #3, #9, #10, #11, #12 and found #2, #4, #5, #6, #7, #8 only partially fixed. See the Round 2 table.
| # | Finding | Test | Red (before) | Fix |
|---|---|---|---|---|
| 1 | Redirect chain only checked on first hop (allowed -> allowed -> /delete mutated) | review-fixes "finding 1" (4 tests incl. loop and 2-hop control) | `expected 1 to be +0` (mutation counter); off-site chain and loop `'uncertain' to be 'blocked'`; control passed | Chromium never follows redirects: handler checks Location, aborts, goto() re-issues each hop as a new checked navigation; hop cap 5 |
| 2 | Hostile page JS overrides DOM APIs to hide credential form; hidden fields extracted | "finding 2" (2 tests) | `'success' to be 'human_action_required'`; hidden token reached model (`true to be false`) | CDP isolated world for all reads; visible allow-listed fields only |
| 3 | Provider 307 could re-POST content to another host | "finding 3" (real SDK transport, loopback 307 server + second listener) | `expected 1 to be +0` (second listener got a request) | fetch wrapper with redirect:"manual", 3xx refused |
| 4 | Content printed by tests/scripts; SDK logging; leak scan too narrow | "finding 4" (ANTHROPIC_LOG=debug spy), tests/zz planted-marker run of scripts/run-tests.ts, smoke dump removed | smoke run stdout contained the record values (grep count 1); SDK spy `LEAK ids=M3` | logLevel "off"; content dumps removed; content-safe assertion helpers (labels/IDs only); run-tests.ts scans captured stdout/stderr + test-output and runs even when vitest fails (planted marker: `LEAK-SCAN FAIL ... ids=M0,M1`, exit 1) |
| 5 | Stop did not cancel in-flight browser work | "finding 5" | `{ auth: 3, extract: 1 } to deeply equal { auth: 0, extract: 0 }` | task-wide AbortSignal; Stop closes the task context; gate checked after every await |
| 6 | Wall-time not a deadline | "finding 6" (2 tests) | `[ 'GET /' ] to deeply equal []`; hanging provider: test timed out at 60000ms | deadline timer aborts the same signal; provider calls and backoff raced against it |
| 7 | Extraction limits applied after unbounded extraction | "finding 7" | `expected 6000 to be less than or equal to 40` | caps on count, per-field, source and aggregate bytes inside the page script; truncated flag; real size counted |
| 8 | Backend attached to any CDP browser | "finding 8" (rogue Chromium without flags) | `promise resolved "undefined" instead of rejecting` | backend verifies real command line via Browser.getBrowserCommandLine (required flags, bad-profile dir); launcher refuses busy port and checks per-launch nonce |
| 9 | Launcher exit skipped profile cleanup | tests/launcher.test.ts (SIGTERM the launcher script) | `expected true to be false` (profile dir still existed) | single awaited shutdown path; cleanup always runs |
| 10 | HTTP accepted missing Origin | backend-auth "review #10" | `expected 202 to be 403` | Origin required on all HTTP endpoints |
| 11 | `SYN-10420` silently became SYN-1042 | "finding 11" (5 rejects + 1 control) | `expected 'OK' to be 'TASK_UNPARSEABLE'` (4 of 5; SYN-104 already rejected) | exact-id parser: exactly one standalone SYN-#### |
| 12 | Service-worker test passed without a worker | extension "review #12" | with the manifest background removed: `expected 0 to be greater than or equal to 1` | asserts target type service_worker + background.js URL (manifest restored; git diff clean) |

Notes. `tests/smoke.test.ts` was deleted because it only dumped the full result (content) to stdout and duplicated e2e "1 happy path" and suite task 1, which assert the same fields content-safely; no coverage was lost. `--enable-automation` is now passed to Chromium because the provenance check needs it (Chrome shows its automation infobar). The launcher cannot clean up after SIGKILL of itself. The adversarial review's other overclaims (ARCHITECTURE.md redirect, logging, profile-deleted, Origin) were corrected in ARCHITECTURE.md. Video: the earlier recorded take was rejected and is not part of this commit (work parked on branch wip/video-take2); video status is PENDING.

## Round 2 (independent re-review of 6eb4546: 8 new findings; closes the 6 partials)
Red = new test failing against 6eb4546 behaviour; green = passing after the fix. Run via `scripts/run-tests.ts`.
| # | Finding | Test | Red (before) | Fix |
|---|---|---|---|---|
| N1 (partial #2) | Hidden descendant / opacity text extracted; shadow-root password missed | round2-extract "N1" (3 tests) | `model-visible text: PRESENT`; open and closed shadow: `status: DIFFERENT` | node-by-node visible-text walk; open-shadow traversal + CDP pierced-DOM credential scan |
| N2 (partial #8) | Backend acceptance not nonce-bound; bypass list prefix-only; negative test never reached validator | round2-browser (11 tests) | positive control `expected false to be true`; look-alike browser accepted (`promise resolved "undefined"`) | nonce + exact profile dir via 0600 handoff, exact bypass list, all background flags. Validator mutated to always-true: 1 passed, 10 failed (every negative test red), restored, 11/11 green |
| N3 (partial #5/#6) | Stop lost during connect; context creation not abortable; active=false before cleanup; old close clears new task | round2-lifecycle (4 tests) | `status: DIFFERENT` (task ran); `elapsed<1500: false`; `active during cleanup: DIFFERENT`; `B still has a tab: DIFFERENT` | `begin()`/`run()` split, abortable newContext with late-close, `active` after cleanup, per-call handle capture |
| N4 | Late URL change after post-check; source URL re-sampled; panel linked write routes | round2-extract "N4"; panel-link (12 tests) | `success srcWrite=true`; panel-link: module did not exist | source URL = href from the extraction turn; route re-validated after the last await; panel `safeSourceLink` |
| N5 (partial #7) | Silent truncation could verify as success; aggregate budget skipped on continue paths | round2-extract "N5" (3 tests) | whitespace-padded qualification `status: DIFFERENT`; repeated truncated searches `code: DIFFERENT`. The 400-char-prefix case was already uncertain (finish values are capped at 200 chars by the tool schema): kept as a control, NOT shown red | whitespace normalisation + `truncated` on every cut; budget check at loop top |
| N6 (partial #4) | Failing tests persisted content; real test bypassed the wrapper | leakwrap | `persisted artifacts with markers: /results.json:M1` | raw JSON report to a private temp dir, redacted copy persisted, content-bearing assertions replaced by label-only helpers, `test:real` routed through the wrapper |
| N7 | Panel stuck "Connected"/"running" after backend loss | round2-panel (2 tests) | `waitForFunction` timeout x2 | WS close and fetch rejection -> Disconnected, running reset, Run enabled, next-action text |
| N8 | README manual fallback fails verification | n/a (docs) | n/a | fallback removed; the launcher is the only supported path |

Note on `npm run test:real`: a git-ignored repo `.env` now exists that I did not create and did not read. With it present the real-provider smoke test ran once and ended `status=error` (cause not investigated; the test prints only status). That is a failed attempt, not a pass. Real-provider end-to-end stays PENDING.

## Known limitations
See ARCHITECTURE.md "Known limitations": heuristic visibility (same-colour / font-size:0 / off-screen text still read), same-user local access to the handoff file and CDP port, in-flight CDP commands abandoned rather than cancelled, flag-based egress containment, launcher SIGKILL leaves the profile dir. Video remains PENDING.
