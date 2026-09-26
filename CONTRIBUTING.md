# Contributing

Small, testable contributions are welcome. Open an issue describing the behavior, provider/CLI version, and reproduction steps before a large adapter or architecture change. Never include account tokens, prompt transcripts, or private code.

Use Node 22+ and the built-in test runner. No dependency installation is required. Run `npm test` and `npm run check`. Tests must use temporary directories and fake processes by default; do not silently consume a contributor's model quota or edit their provider configuration.

For adapter changes, provide the exact supported effort control, resume semantics, cancellation behavior, permission boundary, and usage accounting scope. Test unsupported versions and failure cases. UI and docs must distinguish advice, requested effort, accepted configuration, and measured quality.

Performance/quality claims need an evaluation protocol with held-out tasks, independent acceptance checks, repeat runs, fixed model versions, all-attempt costs, and uncertainty. A lower escalation rate or shorter answer alone is not proof of success.

Follow the MIT license. You do not need to sign a CLA for this project.
