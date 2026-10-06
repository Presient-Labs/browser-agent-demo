# Dependency license inventory (direct dependencies)

Project code: MIT (see package.json). No AGPL/GPL/LGPL dependency, direct or transitive (checked over every package in `node_modules` by reading each `package.json` `license` field on 2026-10-06).

| Package | Version | License | Role |
|---|---|---|---|
| playwright | 1.63.0 | Apache-2.0 | CDP automation |
| @anthropic-ai/sdk | 0.131.0 | MIT | Anthropic provider adapter |
| zod | 4.6.5 | MIT | tool-argument schemas |
| ws | 8.22.0 | MIT | WebSocket server |
| typescript | 7.0.2 | Apache-2.0 | dev |
| tsx | 4.23.15 | MIT | dev (runner) |
| vitest | 5.0.3 | MIT | dev (tests) |
| esbuild | 0.28.2 | MIT | dev (extension bundler) |
| @types/node, @types/ws, @types/chrome | 26.6.4 / 8.18.2 / 0.3.4 | MIT | dev (types) |

Transitive license mix across all installed packages: MIT 48, Apache-2.0 6, MPL-2.0 3, ISC 1, BSD-3-Clause 1, Unlicense 1 (+ the 4 workspace packages). The three MPL-2.0 packages are `lightningcss*` (dev-only, pulled in by vitest/vite); MPL-2.0 is file-level weak copyleft, not used at runtime, flagged here for visibility.

Not an npm dependency: the browser binary (Playwright's bundled Chromium / Chrome for Testing 153.0.8010.12), downloaded by `npx playwright install chromium` and licensed under Chromium's BSD-style and bundled third-party licenses.
