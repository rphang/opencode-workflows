## Summary

<!-- What does this change and why? Link the issue if there is one (Fixes #123). -->

## Checklist

- [ ] Tests first (TDD): a failing test was added or extended before the fix/feature.
- [ ] `npx tsc --noEmit` is clean.
- [ ] `npm test` (unit + parity) passes.
- [ ] Parity: if behavior tied to a `docs/PARITY.md` row changed, the row (status/target/test column) is updated, and every new PARITY ID has a test in `tests/parity/` whose name starts with the ID.
- [ ] opencode-specific code stays in `src/opencode/`; the engine stays host-agnostic.
- [ ] Live e2e (`OPENCODE_E2E=1`, costs money) was run, or is not needed for this change. Result:
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` for user-visible changes.
- [ ] Docs (`README.md`, `docs/`) updated if user-facing behavior changed.
