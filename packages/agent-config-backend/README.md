# AI application configuration backend

This private, dependency-free workspace package belongs to the plugin repository. Its source is bundled separately into the `ccswitch` and `codex-pets` Node backends; the eNest host does not import application adapters, config mergers, sessions or pet business DTOs.

- `ccswitch` 1.3.0 owns the ten application adapters, JSON/TOML/YAML updates, bounded session reads and backup/restore UI.
- `codex-pets` 1.2.0 uses only the Codex adapter and `pets/` assets. Its mode cannot call config/session operations.
- Both require eNest >=0.2.2 and a new explicit `backend.node` grant. Old `config.agent.*` grants do not authorize this capability. A Node backend is fully trusted local code, **not an OS sandbox**.
- Generic control protocol v1 supplies the runtime owner and `appDataPath`. Writes, restores and deletes call the host's `dialog.confirm` and stop on false, failure or runtime closure. Renderer `confirmed` fields never substitute for native confirmation. No secrets are included in confirmation text.
- Saved provider credentials remain vault references in the frontend. Only after native confirmation does the backend call generic `secret.resolve`, injecting the existing Claude `env.ANTHROPIC_AUTH_TOKEN`, Gemini `env.GOOGLE_API_KEY`, or Codex `auth.json.OPENAI_API_KEY` field. No arbitrary secret target is supported, no resolved key is returned to the frontend, and failures after resolution use a generic error rather than parser/OS text that might contain a credential. Existing provider refs continue to work after reopening the plugin.

## Data compatibility and boundaries

Application config/session/pet paths are unchanged. Backup storage remains `<dirname(appDataPath)>/agent-config-backups/<app>/<id>`, including custom eNest data roots; old timestamp-only IDs remain readable. New IDs add a short collision-resistant suffix. Config updates keep the minimal-merge behavior and save all existing adapter files before writing. Restore validates all backup files and targets, then saves a safety snapshot before replacing any file.

Read/write targets use application whitelists and checked filesystem anchors. Symlink components, traversal, encoded separators, non-regular files and whole `pets/` root deletion are rejected. File writes use a same-directory private temporary file, fsync and rename. This is defense against accidental path escapes, not isolation from a malicious fully trusted backend or all external filesystem races.

Session reads are read-only JSON/JSONL, at most 512 KiB per call. Asset uploads keep the existing 8 MiB/file, 20 files and 32 MiB total limits while using <=256 KiB raw chunks under the generic 4 MiB request cap. Up to two upload stages may coexist. Stage files live in a private OS temporary directory, hold a generic activity lease, and expire after 60 seconds without a chunk. Explicit discard, commit, denial and shutdown clean up temporary files and release activity. A completed stage still requires native confirmation before touching application data.

## Focused migration verification

`node --test packages/agent-config-backend/tests/agent-migration.test.mjs`

The dedicated migration checks use synthetic configuration, sessions and assets under OS temporary directories plus a mocked generic host-control port. They do not read real application configs, sessions, API keys or connect to services. Existing historical suites are not part of this check.
