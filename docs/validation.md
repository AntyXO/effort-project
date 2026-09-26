# Validation record

Release: **0.1.0 experimental**, checked September 26, 2026. Development host: macOS, Node 24.16.0. This is a functional acceptance record, not a study of coding quality or cost savings.

## Deterministic acceptance

The release suite covers the policy and its uncertainty, effort caps, repeated-failure recovery, environment/authentication stops, session preservation, unsupported models, approval denial, malformed and excessive provider output, subprocess timeout/abort cleanup, usage accounting, private metadata boundaries, MCP negotiation/calls/termination, and dashboard authentication/Host/Origin checks.

On the development host, **75 tests passed, with zero failures or skips**. The JavaScript syntax check also passed.

Run `npm test` and `npm run check`. Ordinary tests use fake providers and temporary fixtures, make no paid model calls, and do not modify provider configuration. The public [CI workflow](https://github.com/AntyXO/effort-project/actions/workflows/ci.yml) runs Node 22 and 24 on Linux, macOS, and Windows; refer to the actual run for platform results. POSIX-only process-group assertions are explicitly skipped on Windows.

Independent review found and corrected four defects before publication: surviving verifier descendants; unstable failure signatures caused by test timing output; swallowed MCP termination signals; and hidden provider diagnostics. Real repeated failing Node tests now produce the same signature. Verification removes node:test's inherited nesting marker so the requested child tests actually execute.

The first CI matrix also exposed a Codex cancellation race on macOS/Node 24: the parent could close before a descendant was reaped. A stronger fixture reproduced that failure locally by making the child ignore SIGTERM. The adapter now confirms process-group disappearance with a bounded deadline. All 32 Codex tests and 20 repeated stubborn-child cancellations passed after the fix; the child-absence assertions remain strict.

A later run alongside package checks exposed a test-only startup race: the 300ms timeout could expire before the fake CLI accepted its turn. That test now waits for acceptance, advances the same deadline with Node's mock timer, and restores real timers for cleanup. Its timeout, interrupt-message, and dead-process assertions remain intact, with a separate real-time watchdog. No provider behavior changed.

## Live provider checks

| Check | Version/model | Evidence and limit |
| --- | --- | --- |
| Codex new turn at low, resume at high | CLI 0.153.4, gpt-6-astra | Both completed in the same thread and recalled a marker. The app-server accepted explicit effort and thread readback matched low/high. This confirms configuration, not internal reasoning quality. |
| Claude new turn at low, resume at high | CLI 2.1.282, claude-opus-5-5[1m] | Both completed in the same session and recalled a marker. Launch flag plus child environment requested low/high. Applied internal effort is not observable; organization caps can apply. |
| Codex constrained file repair | Same Codex version/model, low | Corrected addition in a disposable sum module on the first attempt. Independent positive/negative/zero checks passed. The verifier file stayed byte-identical. |
| Claude restricted file repair | Same Claude version/model, low | Corrected addition in a disposable sum module. Independent positive/negative/zero checks passed. The verifier file stayed byte-identical. |

An unadvertised Codex model was rejected before a model task, as intended. Initial integration tests also exposed two Claude compatibility issues: a native built-in plugin descriptor and missing OS identity environment variables needed for macOS Keychain. Both were corrected with regression tests. No credentials were printed or published.

The first Codex edit check stopped at an approval request. Explicitly authorized write runs now use the provider's workspace-write sandbox with its on-request approval policy; approval requests themselves are still denied. The revised edit check passed within the disposable workspace, with network access disabled.

Provider tests used disposable workspaces. Codex used a separate local runtime directory. The user's existing Codex config.toml and Claude settings.json retained their original hashes. Claude retains its own normal transcripts for session resume; Effort's metadata store does not retain task prompts or responses.

## Interface checks

The actual local dashboard was inspected in a browser: real empty/history states, high and low recommendations, keyboard submit, copy buttons, reload/session retention, 390px layout without horizontal overflow, dialogs and focus return, filtering, zero versus missing usage, untrusted strings rendered as text, and authentication/offline behavior. No browser console errors were observed. Full screen-reader testing was not performed.

The September 26 dashboard usability update was checked with the real frontend and local API, an empty in-memory store, and three explicitly synthetic run records (including a long model name and missing usage). No provider was launched during this UI review. The initial DOM order now puts recommendations first for empty history and run history first for populated history; later refreshes do not move the panels or interrupt an interaction already underway.

- Inspected desktop, 768px tablet, 390px phone, and 320px narrow layouts. No page horizontal overflow was measured; the phone dialog also had matching client and scroll widths. On the 390px first-use layout, the recommendation button is fully within the first viewport instead of starting below 1,500px of introductory/history content.
- Measured 44px or larger heights for Refresh, provider options, outcome filtering, Copy, and dialog Close; the primary action is 48px high. Task input is 16px, with 13–14px secondary text. Contrast calculated from resolved CSS colors is 5.27:1 for secondary text on the page background, 5.61:1 for the placeholder, and 6.61:1 for the primary button.
- Verified required-input feedback, provider-change invalidation, Codex/Claude recommendation templates, and advisory-only guidance for other tools. Copied templates contain literal task/path placeholders and a validated provider/effort, omit write permission, and never interpolate the entered task into shell syntax.
- Verified no-match filtering and recovery, chronological attempts, native telemetry/identifier disclosures, missing costs shown as “Not reported,” and Escape returning focus to the originating run. Setup shortcuts update the hash and current navigation item; manual desktop scrolling also updates the current section.
- Independent source review caught and corrected width-based IntersectionObserver margins and ambiguous accessible run names. Section observation uses viewport-height pixel margins and rebuilds on resize; run names include their distinguishing ID. Browser console checks found no errors in the connected review session.

Impeccable's detector was unavailable because its engine was not installed; screenshots, DOM measurements, source review, and interaction checks supplied the UI evidence. Physical-device, full screen-reader, and actual 200% browser-zoom testing remain unperformed; viewport reflow is not evidence of those checks.

A follow-up reproduced a missed entry path in the user's Safari tab: opening `web/index.html` directly failed to load the root-relative assets, leaving an unstyled page stuck on “Connecting.” Relative assets and a deferred classic script now render a clearly labeled file preview with startup instructions, working command copying, and disabled server actions. The working dashboard was then started through the real CLI and opened in Safari; a local recommendation returned successfully. The live dashboard was also checked at 390px with matching page client and scroll widths.

The same review reproduced an existing tab failing to adopt a newly opened access URL. Missing and expired sessions now reconnect in that tab without losing the entered draft, and consume the token fragment. Five offline frontend regression tests cover file asset resolution, preview startup without API calls or polling, reload persistence, token adoption, and stale-response handling. These tests execute the shipped script in a minimal DOM harness; native browser behavior was checked separately. No provider task was launched during these checks.

MCP was tested through the packaged command entry point with initialization, tool discovery and calls. This establishes stdio protocol behavior. It does not establish installation into every desktop app, nor automatic effort control of a host conversation.

The download was built and installed into an isolated local prefix. CLI help/recommendation, MCP initialization/tool calls, dashboard HTML/JavaScript/CSS, and the authenticated API passed. `npm run smoke:package` automates this offline archive/install check in a temporary directory on every CI matrix job.

A 10,000-call microbenchmark of the local rules on two short prompts measured p95 below 0.001 ms and maximum below 0.5 ms on this host. It excludes process startup, repository metadata scanning, provider startup and inference. It is not an end-to-end latency guarantee.

## What remains unproven

- Equal coding quality at lower total cost, or reduced user intervention.
- A calibrated difficulty predictor, multilingual task classification, or personalization.
- Native in-flight effort changes inside Codex/Claude desktop chats.
- Live provider compatibility on Windows/Linux, other provider/CLI versions, or every account/organization policy.
- A universal spending cap. Unknown/cumulative usage is not treated as zero or summed as per-turn usage.

The next research step is a controlled held-out task benchmark, described in [architecture.md](architecture.md). These limitations are visible in the product and README; no savings percentage is advertised.
