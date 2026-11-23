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

Grape-kit helps **mainstream agents** (opencode / CodeArts / WorkBuddy / openclaw, etc.) use [Grape](https://gitcode.com/grape-dev/grape) safely and in a structured way — an AI-native DevOps platform with multi-agent pipelines (vod → issue → coding → qa → sre).

```
agent (MCP stdio: opencode / CodeArts / WorkBuddy…; other MCP-capable agents wire up manually)
  → grape-kit (39 tools · native HTTP · Markdown rendering · initialize-instruction bootstrap)
    → grape server (pipelines / events / takeover session API; CLI only as 401 fallback)
```

## Capabilities (39 tools)

- **Pipeline control**: trigger (the only A2A entry) · wait_task · task status · cancel/resume with decision gates
- **Issues & events**: list/detail/events/my-issues · create · structured hand-back templates
- **Cloud-local collaboration** (v0.3.2+ core): **takeover sessions** atomically hand cloud nodes (e.g. coding) over to your agent — a `tko_` credential (12h) plus the full context bundle (prompt/env/workspace/skill/history) come back; your agent works locally and reports progress. Hand-back is two-phase: `request-finish` only reports completion, and after you confirm **in the conversation** the `finish` call hands back the structured result (the pipeline chain never breaks).
  - **Credential semantics**: `tko_` is repo_session-only (keep working the node / report progress, **no git credential injection**). `request-finish` works with `tko_`, but the final `finish` **requires a user-level credential (`grape_`)**; calling `finish` with `tko_` returns 403 by design. There is no UI confirm button — confirmation happens only in your chat with the agent.
  - Platform requirement: weekly-11+; older platforms fall back to the legacy read-only context automatically. Full sequence: [docs/20261114-takeover-architecture.md](docs/20261114-takeover-architecture.md)
- **Scenes & repos**: list_scenes · apply_scene · host_repo · sync_repos · managed/member repos · project templates · project-info
- **Search, knowledge & skills**: search (all/event/repo/agent) · skills ×3 · knowledge ×2 · dashboard
- **Worker onboarding**: register this machine as a grape execution engine (`grape_worker_onboard`)

## Quick Start

> If `--target` is omitted, the installer auto-detects agents on your machine:
>
> - **None detected**: interactive terminals show an agent picker; non-interactive shells error out with the supported target list.
> - **One detected**: installs directly to it.
> - **Multiple detected**: installs to all detected agents (`--target all` equivalent); pass `--target <agent>` to pick one.

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

### openclaw (ClawHub marketplace)

```bash
openclaw plugins install clawhub:grape-kit@latest
```

The `clawhub:` prefix is the source (matching devkit's listing form). Verify with the plugin's MCP tools list (39 tools). Marketplace page: https://clawhub.ai/grape-dev/plugins/grape-kit

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

Full release notes: [CHANGELOG.md](CHANGELOG.md) — 20 条发布记录（含 0.0.0-stage 占位包）

| Version | Date | Highlights |
|---|---|---|
| 0.3.10 | 2026-11-23 | Takeover hand-back dispatch closed (#19): the dispatch pointer is `next_seq` only (`handoff_seq` is the hand-back event seq, never evidence of dispatch); when the platform misses the dispatch the client falls back to re-dispatching coding→qa over the same A2A channel as trigger and backfills `next_seq`; blocked (`remote_may_still_run` / missing repo or issue / failed fallback) yields an explicit `pending_dispatch` marker plus readable warnings instead of silent grace. Three "unproven read as success" paths closed: a hand-back that did not succeed (`ok=false` / `changed=false`) never dispatches the next node, a node name outside the whitelist (e.g. `reviewer`) is reported as unknown instead of being silently rewritten to qa, and a fallback response without an event `seq` counts as unproven. #20 credential/uninstall batch: `auth init` as the single credential write entry, `uninstall --clean-global` (with `--dry-run`, rc backups keeping no credential lines, `_npx` narrowed to grape-kit), doctor's full credential-precedence view; unit tests 156→221 |
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

- **Trigger, observe, advance, take over — nothing more**: A2A orchestration is server-driven by default; the one client-side fallback is takeover_finish re-dispatching coding→qa when the platform's hand-back response carries no dispatch pointer (`next_seq=0`) — and only after the hand-back itself succeeded, so a failed hand-back never pushes the next node into an un-handed-back task; a node name outside the known set is reported as unknown rather than rewritten; beyond that scope the platform's original hand-off behavior stands; takeovers use session primitives for atomic hand-over and hand-back
- **Scope is the first gate**: of the 219 contract commands, the 28 session-only ones (git-repo etc.) always 403 for external tokens — excluded outright; `tko_` takeover credentials are repo_session-only and revoked on completion
- **Agent-native output**: tool responses are Markdown tables / node chains / event timelines; `wait_task` polls with stage summaries and timeout hints

## Windows notes

1. **Encoding**: grape CLI / MCP output is UTF-8; PowerShell decodes it as GBK by default and shows mojibake — run `chcp 65001` first, or set `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()`.
2. **BOM**: a UTF-8 BOM in `~/.grape/config.json` makes `JSON.parse` fail — save without BOM (VS Code "Save with Encoding → UTF-8"; PowerShell `Set-Content -Encoding utf8NoBOM`).
3. **setx does not propagate**: `setx GRAPE_API_TOKEN ...` only affects **new** processes; the current agent session will not see it — restart the host (opencode / CodeArts / WorkBuddy) or re-login the terminal after setting it.

## Development & testing

```bash
npm install
npm test        # 221 unit tests (fake-grape stand-in, no real server needed)
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
- [ ] dsh is served by the dedicated [grape-dsh](https://gitcode.com/grape-dev/grape-dsh) plugin, no duplicate effort

## Links

- [Grape platform](https://www.grapedev.cn/) · [grape main repo](https://gitcode.com/grape-dev/grape) · [grape-cli](https://gitcode.com/grape-dev/grape-cli) · [grape-dsh (DSH adapter)](https://gitcode.com/grape-dev/grape-dsh)
- Takeover architecture & verification report: [docs/20261114-takeover-architecture.md](docs/20261114-takeover-architecture.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) · Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · Support: [SUPPORT.md](SUPPORT.md) · Agent guide: [AGENTS.md](AGENTS.md)

## License

[MIT](LICENSE)
