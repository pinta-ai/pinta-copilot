# TODO — pinta-copilot

Code for all four layers is implemented, verified, and pushed (see
[`DESIGNDOC.md`](./DESIGNDOC.md) §10). What remains is release / deploy work
(not code) plus a few optional follow-ups.

## Release / deploy (blocking full pipeline)

- [ ] **npm publish** `@pinta-ai/pinta-copilot@0.2.0`.
- [ ] **Fill catalog sha256 placeholders** (currently `0×64`) in `pinta-catalog`:
  - [ ] `catalog/pinta-copilot/0.2.0.yaml` → `artifact.sha256` = the published npm tarball's SHA-256.
  - [ ] `catalog/index.json` → the `pinta-copilot` manifest `sha256` = SHA-256 of `pinta-copilot/0.2.0.yaml`.
- [ ] **OpenSearch mapping** — run `aware-backend` `scripts/setup-opensearch.ts` (local → stage → prod) to add the additive `copilot*` field mappings (no reindex).
- [ ] **Merge the branches** (all `minho/pinta-copilot`, pushed):
  - [ ] `aware-backend` — copilot ingest slice (Phase 2)
  - [ ] `pinta-manager` — sidecar enroll + catalog-schema `copilot` types (Phase 3)
  - [ ] `pinta-catalog` — `pinta-copilot` entry
  - [ ] `pinta-copilot` `main` already carries Phase 1 (direct); open a PR if a review gate is wanted.

## Verify after deploy

- [ ] End-to-end with a live Pinta Manager: run a real Copilot CLI + VS Code session, confirm spans are **stored and queryable** in aware-backend (not just accepted by the relay), and that guard `DENY` surfaces with its reason.
- [ ] Confirm the managed install path: Manager auto-installs `~/.copilot/hooks/pinta-copilot.json` + `~/.copilot/pinta-copilot.env` via the catalog entry (replacing the manual `~/.copilot/sync-from-codex.sh`).

## Optional follow-ups (non-blocking)

- [ ] `tools/setup.ts` — one-shot interactive installer (endpoint/token → build → install-hooks), like pinta-codex.
- [ ] Decide the **dist strategy**: the local hook points at `dist/index.js`, which git ops can wipe (→ fail-closed). CI (`build-dist`) force-commits `dist/` to `main`; managed installs use the npm tarball's stable path. Either keep this, or pin the hook to a stable installed location.
- [ ] Raise the guard default timeout (currently 50ms; cold-process first fetch can approach ~60ms). For now set `PINTA_GUARD_TIMEOUT_MS` per deployment (live = 300ms).
- [ ] Bonus surfaces / experiments (see golden doc `../copilot-cli/BACKGROUND_RESEARCH.md` §11.2): native OTel passthrough (KU12), Claude-format hooks parsing (KU13), cloud agent (`.github/hooks/`, currently out of scope).
- [ ] Clean stale `.claude/worktrees/*` and other untracked junk out of the sibling repos before merging (was accidentally swept into a commit once and removed).
