<h1 align="center">@grape-dev/grape-kit</h1>

<p align="center">English | <a href="README.zh.md">简体中文</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit"><img src="https://img.shields.io/npm/v/@grape-dev/grape-kit" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit"><img src="https://img.shields.io/npm/dm/@grape-dev/grape-kit" alt="npm downloads"></a>
  <a href="https://gitcode.com/grape-dev/grape-kit/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@grape-dev/grape-kit" alt="License: MIT"></a>
  <img src="https://img.shields.io/node/v/@grape-dev/grape-kit" alt="node">
  <a href="https://www.grapedev.cn/"><img src="https://img.shields.io/badge/grape-www.grapedev.cn-2563eb" alt="grape"></a>
</p>

<p align="center">
  <strong>Grape DevOps pipeline tools × mainstream agents</strong><br>
  Trigger, observe and advance Grape multi-agent DevOps pipelines from agents like opencode / CodeArts / WorkBuddy,<br>
  and atomically hand over cloud nodes to your agent via <strong>cloud-local collaboration</strong> — takeover sessions pull cloud nodes into your agent, results return to the platform in structured form, and the pipeline chain never breaks.<br>
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit">npm</a> · <a href="https://www.grapedev.cn/">Grape website</a> · <a href="https://gitcode.com/grape-dev/grape-kit">Source</a>
</p>

---

Grape-kit helps **mainstream agents** (opencode / CodeArts / WorkBuddy / dsh / openclaw, etc.) use [Grape](https://gitcode.com/grape-dev/grape) safely and in a structured way — an AI-native DevOps platform with multi-agent pipelines (vod → issue → coding → qa → sre).

```
agent (MCP stdio: opencode / CodeArts / WorkBuddy / dsh…; other MCP-capable agents wire up manually)
  → grape-kit (50 tools · native HTTP · Markdown rendering · initialize-instruction bootstrap)
    → grape server (pipelines / events / takeover session API; CLI only as 401 fallback)
```

## Capabilities (50 tools)

- **Pipeline control**: trigger (the only A2A entry) · wait_task · task status · cancel/resume with decision gates
- **Issues & events**: list/detail/events/my-issues · create · structured hand-back templates
- **Cloud-local collaboration** (v0.3.2+ core): **takeover sessions** atomically hand cloud nodes (e.g. coding) over to your agent — a `tko_` credential (12h) plus the full context bundle (prompt/env/workspace/skill/history) come back; your agent works locally and reports progress. Hand-back is two-phase: `request-finish` only reports completion, and after you confirm **in the conversation** the `finish` call hands back the structured result (the pipeline chain never breaks).
  - **Credential semantics**: `tko_` is repo_session-only (keep working the node / report progress, **no git credential injection**). `request-finish` works with `tko_`, but the final `finish` **requires a user-level credential (`grape_`)**; calling `finish` with `tko_` returns 403 by design. There is no UI confirm button — confirmation happens only in your chat with the agent.
  - **Skill materialization**: on takeover the platform-supplied `assets.skill` is materialized into your local workspace at `<cwd>/.grape-takeover-skills/<skill>/` (`SKILL.md` + `references/*`), and the render prints the on-disk path (`技能已物化：<path>` plus file count and whether references are included) — the takeover prompt's "skills are already materialized, read SKILL.md" stops being a promise. Both inline `files` and a `zip_url` bundle are supported (zip is extracted with Node's built-in `zlib`, zero new dependencies, store/deflate only); OBS reference-form entries (`files` entries holding only `__obs_key__`) are resolved through a short-lived signed URL in the asset or the `GET /api/skills/by-id/{id}/download` endpoint and extracted the same way — that endpoint requires a **user-level credential (`grape_`)**; `tko_`/`tk_` session credentials get 403 by design, and the failure line dispatches the next step accordingly. When neither resolves, materialization fails with the reason "the server must deliver inline/zip_url" and writes nothing (no more silent 0-byte files); entries with an explicit empty string are treated as missing content too. Older platforms send no skill bundle, so the render states "not materialized" explicitly, and a failed materialization only warns — it never invalidates the established session. Skill names go through a whitelist, entries reject path traversal / absolute paths / drive letters / symlinks, and `.skills/` is never written (the worker rmtree's that directory).
  - Platform requirement: weekly-11+; older platforms fall back to the legacy read-only context automatically. Full sequence: [docs/20261114-takeover-architecture.md](docs/20261114-takeover-architecture.md)
  - **Local takeover workspace override** (Issue #37): `grape_takeover_start` accepts an optional `workspace` (absolute local path). The resolution priority is `workspace` > `bundle.workspace.cwd_hint` > `process.cwd()`; skill materialization, the scripts' `{{CWD}}`, and `GRAPE_AUTH_FILE` are all resolved against the local path, and the result carries `workspace_effective`. When it differs from the cloud `cwd_hint`, the render explicitly states that the cloud path does not exist locally instead of silently substituting. `GRAPE_AUTH_FILE` is rewritten only when it carries `{{CWD}}` or lies under `cwd_hint` (the platform default `<hint>/.grape-takeover-token` is covered by the latter); custom absolute and relative paths are left untouched with a hint to verify/source. `grape_git_credential` shares the same session-root resolution: when `cwd_hint` exists locally it is the boundary (out-of-root paths are rejected), otherwise the explicit workspace is the root and the response explicitly discloses that no cloud boundary applies (`session_boundary` / `session_root_note`).
- **Scenes & repos**: list_scenes (market / repo copies) · apply_scene (creates the repo copy, optional set-default) · set_repo_scene (repo default = which pipeline new issues take) · host_repo · sync_repos · managed/member repos · project templates · project-info
- **Search, knowledge & skills**: search (all/event/repo/agent) · skills ×6 (list/search/detail + **upload/update/convert**: local preflight, auto ZIP with top-level dir, full server `errors`) · knowledge ×2 · dashboard
  - `grape_get_skill_detail` returns the **full** SKILL.md (the old 3000-char cut is gone); above **64KB (UTF-8 bytes)** the body is written **byte-for-byte** to a temp file and only a 2000-char preview plus an explicit `已截断，全文在 <path>` notice (with the byte count) comes back.
  - **Capability handshake & multi-skill fail-closed** (Issue #32): before a takeover the client handshakes `GET /api/health` for the server `version` + `capabilities[]` (cached in-process for 300s; `GRAPE_CAPABILITIES_TTL_MS` overrides, `GRAPE_CAPABILITIES_REFRESH=1` forces a refresh). When a node requires more than one skill and the server does not declare `skills.multi`, `grape_takeover_start` **refuses** with the stable code `E_CAP_UNSUPPORTED_MULTI_SKILL` plus required skills, server version, supported capabilities, capability source, handshake time and three remediation steps — it never silently runs only the first skill. Old servers (404 / missing fields) are treated as single-skill only; the single-skill path is unchanged. `takeover_bundle.v2` does **not** imply `skills.multi`; the only client criterion is `skills.multi`. The handshake also declares `client_capabilities` (`skills.multi=true`) so newer servers can reject old clients.
- **Scenes & repos**: list_scenes · apply_scene · host_repo · sync_repos · managed/member repos · project templates · project-info
- **Search, knowledge & skills**: search (all/event/repo/agent) · skills ×3 · knowledge ×2 · dashboard
- **Worker onboarding**: register this machine as a grape execution engine (`grape_worker_onboard`)
- **Self-management** (v0.4.1+): `grape_kit_version` (version panorama: local kit / npm latest / grape CLI / server reachability + contract version / credential source) and `grape_kit_check_update` (update check with a 3-day `dismiss` cooldown) run read-only in-process; `grape_kit_upgrade`, `grape_kit_install` and `grape_kit_uninstall` only **generate copy-pasteable commands** (install form detection: global npm / npx cache / ClawHub / local dependency) — the tools never execute anything, the user confirms and runs them. Command generation only, no silent execution.

## Quick Start

> If `--target` is omitted, the installer auto-detects agents on your machine:
>
> - **None detected**: interactive terminals show an agent picker; non-interactive shells error out with the supported target list.
> - **One detected**: installs directly to it.
> - **Multiple detected**: installs to all detected agents (`--target all` equivalent); pass `--target <agent>` to pick one.
> - `trae` is **project-level**: it is not part of `--target all` (an all-target run cannot know the project), so install it separately with `--target trae` from the target project directory; install/uninstall is refused when the current directory equals `$HOME` (no user-level writes).

### Supported hosts (10 targets)

| `--target` | Config path | Format / notes |
|---|---|---|
| `opencode` | `~/.config/opencode/opencode.json(c)` | JSONC `mcp.grape` + skill copy |
| `workbuddy` | `~/.workbuddy/mcp.json` | JSON `mcpServers.grape-kit` + skill copy |
| `codearts` | `~/.codeartsdoer/codearts_cli.jsonc` | JSONC `mcp.grape-kit`, restart the entry in the IDE |
| `officeace` | `~/.officeace/mcp.json` | import-only manifest (`mcpServers.grape-kit`) |
| `dsh` | `$DSH_HOME/profiles/web/cordis.patch.yml` | YAML managed block + skill copy |
| `codex` | `~/.codex/config.toml` | TOML `[mcp_servers.grape-kit]` + `[mcp_servers.grape-kit.env]` |
| `openclaw` | `~/.openclaw/openclaw.json` | JSON `mcp.servers` (legacy `mcpServers` compatible) |
| `hermes` | `~/.hermes/config.yaml` | YAML `mcp_servers` + skill copy |
| `atomcode` | `~/.atomcode/mcp.json` (`ATOMCODE_HOME` override) | JSON `mcpServers` |
| `trae` | `<project>/.trae/mcp.json` (`GRAPE_TRAE_CONFIG` override) | JSON `mcpServers`; project-level only, aligned with the official Trae MCP entry |

Prerequisites: **Node >= 20** (no Python needed — native HTTP since v0.3.0). Credentials go through environment variables:

```bash
export GRAPE_BASE_URL=https://www.grapedev.cn
export GRAPE_API_TOKEN=grape_xxx      # API Key: https://www.grapedev.cn/app/#account/profile
# Agents that sanitize env vars: file channel ~/.grape/config.json {"token":"grape_xxx","base_url":"..."}
```

### Credential priority & `auth init`

One entry point writes credentials; the resolution order is fixed and shared by the API client, `doctor`, and takeover scripts:

1. `GRAPE_API_TOKEN_ONCE` — runtime, current process only (highest)
2. `GRAPE_API_TOKEN` / `GRAPE_BASE_URL` — environment channel
3. `GRAPE_AUTH_FILE` or `~/.grape/config.json` (the directory can be overridden with `GRAPE_HOME`) — file channel

```bash
# write the file channel (mode 600, BOM stripped) and print the matching env commands
npx -y @grape-dev/grape-kit auth init --token grape_xxx --base-url https://www.grapedev.cn
npx -y @grape-dev/grape-kit doctor     # shows the full runtime > env > file chain (never echoes the token)
```

`auth init` writes to `GRAPE_AUTH_FILE` when it is set, otherwise `GRAPE_HOME/config.json` — the write target is always identical to the resolution target, and the file is read back and verified after writing. In `doctor` output the effective tier shows `[ok]`; missed/overridden tiers show `[--]` (informational, no action needed).

A plain `uninstall` removes only the host entry and reports any leftover credentials. Add `--clean-global` to delete `~/.grape` (file channel + worker artifacts), the user-level `GRAPE_API_TOKEN`/`GRAPE_BASE_URL` (POSIX: the exact `export` lines are removed from rc files and the backup keeps only non-credential lines — a backup holding credentials would just be the token under a different name; Windows uses `reg delete`), and only those `_npx` cache entries that contain `node_modules/@grape-dev`. `--clean-global` works with or without `--target` (with no host traces it still runs the global cleanup), and `--dry-run` previews what would be deleted without touching the disk:

```bash
npx -y @grape-dev/grape-kit uninstall --clean-global --dry-run   # preview first
npx -y @grape-dev/grape-kit uninstall --clean-global
```

> Uninstall scope: each host removes only the entry it wrote; when the config is left with nothing but the empty container it created (hermes' empty `mcp_servers`, JSON hosts' empty `mcpServers`), the file itself is removed too (backed up first, disclosed by `--dry-run` as well).

### OpenCode

```bash
npx -y @grape-dev/grape-kit install --target opencode
```

**Restart the session** after installation.

```bash
npx -y @grape-dev/grape-kit doctor --target opencode --probe
npm install -g @grape-dev/grape-kit             # update (then restart the session)
npx -y @grape-dev/grape-kit uninstall --target opencode
```

### CodeArts Agent (华为云码道)

```bash
npx -y @grape-dev/grape-kit install --target codearts
```

Writes the `mcpServers` entry into `~/.codeartsdoer/codearts_cli.jsonc` (global) or `<project>/.codeartsdoer/codearts_cli.jsonc` (project-level). After install, restart the entry in CodeArts: 设置 → MCP工具 → 已安装 → grape-kit → 「重启」.

```bash
npx -y @grape-dev/grape-kit doctor --target codearts --probe
npx -y @grape-dev/grape-kit update --target codearts
npx -y @grape-dev/grape-kit uninstall --target codearts
```

### WorkBuddy

```bash
npx -y @grape-dev/grape-kit install --target workbuddy
```

Writes `~/.workbuddy/mcp.json` (`mcpServers.grape-kit`, via npx — no global install) + skill to `~/.workbuddy/skills/grape-remote/`. **Just restart the host session** — no manual "trust" step is needed (verified: the server spawns without an authorization prompt). Credentials go through environment variables — **never** write them into mcp.json.

```bash
npx -y @grape-dev/grape-kit doctor --target workbuddy --probe
npx -y @grape-dev/grape-kit update --target workbuddy
npx -y @grape-dev/grape-kit uninstall --target workbuddy   # removes entry + skill + receipt (config backed up)
```

### DeepSeek Harness (dsh)

```bash
npx -y @grape-dev/grape-kit install --target dsh
```

Writes a **managed block** into `$DSH_HOME/profiles/web/cordis.patch.yml` (default `$DSH_HOME` = `~/.dsh`): an `insert` row with `id: grape-kit`, `name: '@deepseek-ai/dsh-mcp-client'`, `transport: stdio`, and a `node` command pointing at the local MCP entry (falls back to `npx` when the script cannot be resolved). The `grape-remote` skill is copied to `$DSH_HOME/skills/`. Only the lines between the managed markers are touched — your own patch rows stay byte-for-byte intact and every write is backed up first. **Restart the dsh session** afterwards to load the new patch.

`@deepseek-ai/dsh-mcp-client` is a `web`-profile asset: the installer tries a best-effort install and never blocks on failure. If it cannot install it, run:

```bash
npx @deepseek-ai/dsh plugin --profile web add @deepseek-ai/dsh-mcp-client
corepack enable pnpm   # first, if pnpm is missing
```

```bash
npx -y @grape-dev/grape-kit doctor --target dsh --probe   # managed block / skill copy / dsh-mcp-client
npx -y @grape-dev/grape-kit install --target dsh          # re-assembly after upgrade (idempotent)
npx -y @grape-dev/grape-kit uninstall --target dsh        # removes the managed block + skill copy only
```

> dsh uses the **MCP minimal path** (all 50 tools reused unchanged). The full native Cordis plugin lives in [grape-dsh](https://gitcode.com/grape-dev/grape-dsh); the two coexist.

### Codex CLI

```bash
npx -y @grape-dev/grape-kit install --target codex
```

Writes a marker-delimited block into `~/.codex/config.toml`: `[mcp_servers.grape-kit]` (`command` / `args`, npx) plus the `[mcp_servers.grape-kit.env]` sub-table. Only the managed block and the `grape-kit` tables are touched — other tables and comments stay intact, every write is backed up first, and re-installing is byte-for-byte idempotent. **Restart the session** afterwards.

```bash
npx -y @grape-dev/grape-kit doctor --target codex --probe
npx -y @grape-dev/grape-kit uninstall --target codex   # removes the managed block / grape-kit tables only
```

### Hermes

```bash
npx -y @grape-dev/grape-kit install --target hermes
```

Writes `mcp_servers.grape-kit` into `~/.hermes/config.yaml` (YAML, comments and other entries preserved) and copies the `grape-remote` skill to `~/.hermes/skills/`. Hermes ships an MCP client, so the entry loads directly after a session restart.

```bash
npx -y @grape-dev/grape-kit doctor --target hermes --probe
npx -y @grape-dev/grape-kit uninstall --target hermes   # removes the entry + skill copy
```

### Atomcode

```bash
npx -y @grape-dev/grape-kit install --target atomcode
```

Writes `mcpServers.grape-kit` into `~/.atomcode/mcp.json`; the root can be overridden with `ATOMCODE_HOME`. Other connectors are preserved and every write is backed up.

```bash
npx -y @grape-dev/grape-kit doctor --target atomcode --probe
npx -y @grape-dev/grape-kit uninstall --target atomcode
```

### Trae

```bash
npx -y @grape-dev/grape-kit install --target trae
```

Writes `mcpServers.grape-kit` into the project-level `.trae/mcp.json` (Trae's official MCP entry, run from the project root); `GRAPE_TRAE_CONFIG` overrides the path. User-level `~/.trae/mcp.json` is intentionally not touched: when the current directory equals `$HOME` (where the project-level path *is* the user-level path) install/uninstall is refused with a pointer to run from the target project, and `--target all` excludes trae. Other servers are preserved and every write is backed up.

```bash
npx -y @grape-dev/grape-kit doctor --target trae --probe
npx -y @grape-dev/grape-kit uninstall --target trae
```

### openclaw (ClawHub marketplace)

```bash
openclaw plugins install clawhub:grape-kit@latest
```

The `clawhub:` prefix is the source (matching devkit's listing form). Verify with the plugin's MCP tools list (50 tools). Marketplace page: https://clawhub.ai/grape-dev/plugins/grape-kit

Alternatively, register the MCP server directly with the file-based installer (no marketplace needed):

```bash
npx -y @grape-dev/grape-kit install --target openclaw   # ~/.openclaw/openclaw.json: mcp.servers.grape-kit (legacy mcpServers compatible)
npx -y @grape-dev/grape-kit uninstall --target openclaw # dry-run with --dry-run
```

### Version check & update (all targets)

```bash
npx -y @grape-dev/grape-kit --version        # version check
npm install -g @grape-dev/grape-kit          # update (then restart the agent session)
npx -y @grape-dev/grape-kit uninstall        # uninstall, target auto-detected
npx -y @grape-dev/grape-kit uninstall --clean-global   # also purge ~/.grape + user env vars + _npx cache
```

A startup version check compares against the npm registry and reminds you once when a newer release exists (24h dedupe; disable with `GRAPE_KIT_SKIP_UPDATE_CHECK=1`). Mirror registries (npmmirror etc.) may lag 1-3 days — use `--registry https://registry.npmjs.org/` for the latest.

Then just talk to your agent:

```
> Which of my grape issues have pipelines running?
> Trigger the pipeline for issue #12 of acme/demo, then wait for a terminal state
> #12's coding node is running — take it over on this machine, keep the chain   ← takeover_start
> Done — report to the platform, wait for my confirmation before formal hand-back  ← progress + request-finish + finish (finish needs a user-level credential)
> Can't finish this node — give it back to the cloud, keep the chain            ← takeover_abort
```

### Capability map after install (`intro`)

Every successful `install` ends with a **capability map**: 5 groups of what the agent can do for you, each with one copy-paste example question. If no credential is found yet, the same block starts with a 3-step API Key guide (where to generate it, the `grape_` prefix, where to put it), so the first tool call does not die with 401.

```bash
npx -y @grape-dev/grape-kit intro     # reprint the capability map at any time
```

`intro` and the install-end output share one constant, so the two cannot drift. It takes no `--target` — the map is host-independent and only local credential state is read; use the per-host sections above for host-specific commands.

## Version history

Full release notes: [CHANGELOG.md](CHANGELOG.md) — 25 条发布记录（含 0.0.0-stage 占位包与 next 通道候选 0.5.2-next.0）

| Version | Date | Highlights |
|---|---|---|
| 0.5.2-next.0 | 2026-11-26 | npm next channel candidate (published with `--tag next`, latest stays 0.5.1): local-takeover workspace override (#37) — `grape_takeover_start` gains an optional `workspace` arg, resolution priority `args.workspace` > `bundle.workspace.cwd_hint` > `process.cwd()` (`resolveLocalWorkspace`), skill materialization / takeover script `{{CWD}}` / `GRAPE_AUTH_FILE` all follow the resolved local path, response carries `workspace_effective`, cloud-vs-local mismatch is disclosed instead of silently substituted; `GRAPE_AUTH_FILE` localization (#37) — `{{CWD}}` filled with the local workspace, cloud paths under the `cwd_hint` root prefix-rewritten to the local workspace, custom absolute and relative paths untouched (absolute paths get a readability warning); `grape_git_credential` session root unified into a single resolver `resolveCredentialSessionRoot` (#37) — a locally present `cwd_hint` acts as the trusted escape boundary (workspaces outside it stay rejected, nothing written), local takeover takes the explicit workspace as session root with explicit degradation disclosure, response gains `session_root` / `session_boundary` / `session_root_note`; promotion to 0.5.2 stable awaits live `@next` regression + B1/B2/D real-machine backfill |
| 0.5.1 | 2026-11-25 | 0.5.1-next.0 promoted to stable: `mcpName` ownership field added for Official MCP Registry verification (no functional change); all next-channel payload (#28 / #30 / #31 / #32) promoted into latest |
| 0.5.1-next.0 | 2026-11-25 | npm next channel candidate (published with `--tag next`, latest stays 0.5.0): git write-back pair (#31, tools 48→50) — `grape_git_credential` (tko_ → one-shot repo credential + GIT_ASKPASS 0600, expiry self-check) and `grape_create_pull` (create PR only); takeover skill materialization (#28): `bundle.assets.skill` written to `<cwd>/.grape-takeover-skills/<skill>/` (inline files / zip_url, symlink & escape guards, 64MB inflate cap + CRC-32); client capabilities handshake (#32): `GET /api/health` before takeover, multi-required-skill nodes fail closed with `E_CAP_UNSUPPORTED_MULTI_SKILL` on servers without `skills.multi`; dispatch criteria realigned (#30): dispatched = `handoff.seq>0` / `handoff.reason=already_dispatched`, fallback re-dispatch follows the scene chain `next`; `grape_get_skill_detail` outputs SKILL.md in full up to 64KB (old 3000-char truncation removed, oversized bodies spill to a temp file with preview); promotion to 0.5.1 stable awaits live `@next` regression + #23 Windows 11 backfill |
| 0.5.0 | 2026-11-25 | Scene market-copy channel + skill upload batch (#20): `grape_apply_scene` creates a per-repo scene copy via the market apply endpoint (unmatched id/name rejected locally instead of silent `default` fallback, read-back verify, `set_default` as a second call); new `grape_set_repo_scene` (writes `managed_repos.dev_scene`, read-back verified, `clear=true`), `grape_list_scenes` repo view for `custom-` copies, `grape_upload_skill` / `grape_update_skill` / `grape_convert_skill` (server-parity local preflight + in-tree ZIP); `grape_create_issue` marks `description` required. Five new install targets (#26, `--target` 5→10): `codex` (TOML managed block, comments preserved), `openclaw` (JSON, legacy `mcpServers` compat), `hermes` (YAML comment-preserving + `grape-remote` skill copy), `atomcode` (`ATOMCODE_HOME`), `trae` (project-level only, `$HOME` guard, no user-level fallback) — each with install / uninstall (`--dry-run`) / doctor (`--probe`) / detect, wired into auto-detection and `--target all`; bare doctor covers all 10 hosts. Self-management five tools (#27, tools 39→48): `grape_kit_version` version panorama (local kit / npm latest / CLI fallback / server contract / credential tier, best-effort per channel), `grape_kit_check_update` with 3-day dismiss cooldown (decoupled from the 24h startup cache), `grape_kit_upgrade` / `grape_kit_install` / `grape_kit_uninstall` generate copy-paste commands only — never execute; install form auto-detected (global npm / npx cache / ClawHub / local dependency / unknown), `damaged` hosts listed as blocked with the parse error; `takeover_finish` re-dispatches only when the platform actually missed the node; unit tests 270→395 |
| 0.4.0 | 2026-11-23 | DeepSeek Harness (dsh) support (#21): `install --target dsh` wires grape-kit into the dsh web profile via an **MCP stdio managed patch** — a marker-delimited `insert` block in `$DSH_HOME/profiles/web/cordis.patch.yml` (`id: grape-kit` / `name: '@deepseek-ai/dsh-mcp-client'` / local script first, `npx` fallback), `grape-remote` skill copied to `$DSH_HOME/skills/`, all 39 tools reused unchanged; `uninstall --target dsh` removes only the managed block + skill copy, `doctor --target dsh` checks block / skill copy / `dsh-mcp-client`, `detect` picks up `~/.dsh`; best-effort dependency install (failure prints manual guidance, exit 0). QA hardening (PR #12): refuse to write on incomplete managed blocks or map-shaped patches (no silent deletion of user lines, no invalid YAML), byte-exact install→uninstall round-trip, empty-patch/backup cleanup; unit tests 257→270 |
| 0.3.10 | 2026-11-23 | Takeover hand-back dispatch closed (#19): the dispatch pointer is `next_seq` only (`handoff_seq` is the hand-back event seq, never evidence of dispatch); when the platform misses the dispatch the client falls back to re-dispatching coding→qa over the same A2A channel as trigger and backfills `next_seq`; blocked (`remote_may_still_run` / missing repo or issue / failed fallback) yields an explicit `pending_dispatch` marker plus readable warnings instead of silent grace. Three "unproven read as success" paths closed: a hand-back that did not succeed (`ok=false` / `changed=false`) never dispatches the next node, a node name outside the whitelist (e.g. `reviewer`) is reported as unknown instead of being silently rewritten to qa, and a fallback response without an event `seq` counts as unproven. #20 credential/uninstall batch: `auth init` as the single credential write entry, `uninstall --clean-global` (with `--dry-run`, rc backups keeping no credential lines, `_npx` narrowed to grape-kit), doctor's full credential-precedence view; unit tests 156→257 |
| 0.3.9 | 2026-11-23 | Takeover full-chain hardening (#12): takeover_start branch/MR preflight checks + warnings fully surfaced, cross-platform Node takeover scripts (report / request-finish / finish), 409 agent_mismatch hints, bundle {{CWD}} rendering, doctor credential-source line; #17 fix batch: `intro` subcommand + post-install capability map (3-step API Key guide when no credentials), trigger_pipeline `agent` param (resume from a given node), doctor base_url dual-channel with source annotated, review tools native-channel crash fixed; unit tests 136→156 |
| 0.3.8 | 2026-11-20 | Three review tools (grape_review_pass / grape_review_reject / grape_confirm_done — tools 36→39); issues table gains a "Repository" column; doctor recognizes ~/.grape/config.json file-channel credentials (no more false FAIL) |
| 0.3.7 | 2026-11-20 | Graphical rendering for trigger/task_status (node-chain diagram on trigger; status card + progress bar + next-step hints); README Quick Start rebuilt in devkit style (per-agent sections, Capabilities overview, lifecycle command group); uninstall receipt cleanup; Codex/hermes removed from surfaced targets |
| 0.3.6 | 2026-11-19 | Pipeline rendering supports the segments event-stream shape (real API payloads; no more raw-JSON fallback); stall status surfaced in the verdict line ("⚠️ suspected stall for N minutes"); segments-shape regression case added (unit tests 114→115) |
| 0.3.5 | 2026-11-19 | Agent auto-detection from local traces (workbuddy/codearts/officeace); interactive agent picker when none detected (no silent opencode fallback); clean-env auto-config + three-step onboarding output; agent matrix docs (CodeArts section, openclaw/ClawHub channel) |
| 0.3.4 | 2026-11-19 | codearts + officeace install targets (supported agents 2→4); doctor version-update line (24h dedupe, five states); installer entry-engine structural scan hardening |
| 0.3.3 | 2026-11-18 | check_update startup reminder + CHANGELOG generator; 401 fallback hardened |
| 0.3.2 | 2026-11-17 | Takeover session five tools (start/status/progress/finish/abort); #2517 client-side adaptation (abort redispatch failure alert + race warning rendering); SKILL.md dual-path semantics |
| 0.3.1 | 2026-11-11 | cancel three-choice decision gate · resume fact re-verification · search contract convergence · structured hand-back template |
| 0.3.0 | 2026-11-10 | Native HTTP transport; grape CLI/Python becomes optional (401 fallback channel) |
| 0.2.x | pre 2026-11-09 | 13→31 tools · worker_onboard · B1 takeover loop |

## Design principles

- **Trigger, observe, advance, take over — nothing more**: A2A orchestration is server-driven by default; the one client-side fallback is takeover_finish re-dispatching the scene chain's next node (e.g. coding→qa) when the platform's hand-back response carries no dispatch evidence (`handoff.seq>0` / `handoff.reason=already_dispatched`) and an event read-back confirms the next node has no `a2a_event` — and only after the hand-back itself succeeded, so a failed hand-back never pushes the next node into an un-handed-back task; `next_seq` is never treated as the dispatch pointer; a node name outside the scene chain is reported as unknown rather than rewritten; beyond that scope the platform's original hand-off behavior stands; takeovers use session primitives for atomic hand-over and hand-back
- **Scope is the first gate**: of the 219 contract commands, the 28 session-only ones (git-repo etc.) always 403 for external tokens — excluded outright; `tko_` takeover credentials are repo_session-only and revoked on completion
- **Agent-native output**: tool responses are Markdown tables / node chains / event timelines; `wait_task` polls with stage summaries and timeout hints

## Windows notes

1. **Encoding**: grape CLI / MCP output is UTF-8; PowerShell decodes it as GBK by default and shows mojibake — run `chcp 65001` first, or set `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()`.
2. **BOM**: a UTF-8 BOM in `~/.grape/config.json` makes `JSON.parse` fail — save without BOM (VS Code "Save with Encoding → UTF-8"; PowerShell `Set-Content -Encoding utf8NoBOM`).
3. **setx does not propagate**: `setx GRAPE_API_TOKEN ...` only affects **new** processes; the current agent session will not see it — restart the host (opencode / CodeArts / WorkBuddy) or re-login the terminal after setting it.

## Development & testing

```bash
npm install

npm test        # 503 unit tests (fake-grape stub, no live server)

npm run smoke   # real stdio JSON-RPC round-trip: initialize → tools/list → tools/call
```

Read-only smoke against a real server:

```bash
export GRAPE_BASE_URL=https://www.grapedev.cn GRAPE_API_TOKEN=grape_xxx
node scripts/live-smoke.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution flow, [AGENTS.md](AGENTS.md) if you are an AI coding agent working on this repo.

## Roadmap

- [x] Org repo home (grape-dev/grape-kit)
- [ ] Full CI gating (GitHub Actions-compatible workflow provided today; enable GitCode GoCI once generally available)
- [x] More install targets: codearts / officeace (three integration types)
- [x] dsh install target (MCP stdio managed patch); the full native Cordis plugin stays in [grape-dsh](https://gitcode.com/grape-dev/grape-dsh) — the two coexist

## Links

- [Grape platform](https://www.grapedev.cn/) · [grape main repo](https://gitcode.com/grape-dev/grape) · [grape-cli](https://gitcode.com/grape-dev/grape-cli) · [grape-dsh (DSH adapter)](https://gitcode.com/grape-dev/grape-dsh)
- Takeover architecture & verification report: [docs/20261114-takeover-architecture.md](docs/20261114-takeover-architecture.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) · Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · Support: [SUPPORT.md](SUPPORT.md) · Agent guide: [AGENTS.md](AGENTS.md)

## License

[MIT](LICENSE)
