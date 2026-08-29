# MVP Codebase Selection

> Status: approved sole foundation; Windows/Qwen3.8/safety smoke pending
> Audited: 2026-08-28
> Product constraint: minimize original code; ship Windows first

## Decision

Fork only **[Atomic Chat v2.0.0](https://github.com/AtomicBot-ai/Atomic-Chat/releases/tag/v2.0.0)** (`e9810b0c99f3d14f4dfb5d2e28b8c1fdbd044233`). Jan, OMP, Pi, Hermes, and custom harnesses are outside the MVP.

Atomic is an Apache-2.0 Jan fork that has already added the largest missing subsystem: an embedded agent designed for local GGUF models, with filesystem tools and approval machinery. Its release pipeline already builds and signs Windows NSIS/MSI installers and produces Tauri updater artifacts. The shortest product path is therefore to **remove choices, harden the existing guard, and pin behavior**, not combine a chat app with a separate agent harness.

This is a source-audit verdict, not product proof. Atomic has not yet passed our Qwen3.8 Windows, privacy, safety, signing, or nontechnical-user gates.

## What Atomic already gives us

Atomic v2.0.0 already solves chat, persistence, Hugging Face/GGUF downloads, llama.cpp lifecycle, hardware fitting, Windows packaging, updates, and most of the embedded agent subsystem:

- a Rust agent loop for local/open models;
- filesystem and shell tools;
- an approval gate and dialog for actions it classifies as approval-gated;
- `deny`, `allow once`, and `always allow` decisions;
- a per-thread manual-versus-skip mode;
- agent UI and tests inside the desktop app.

The shipped policy is not safe enough: `os.fs.write`, `os.fs.mkdir`, and `os.fs.edit` are classified as `FsWrite`, not `ApprovalGated`, so they can execute inside an authorized root without the action dialog. Shell previews deliberately omit the command and arguments; write previews expose only path/mode/byte count rather than content or a diff. These are blocking but localized fixes inside an existing guard and preview pipeline.

## Agent capability path

Atomic v2.0.0 already contains the harness. Its isolated Rust loop talks directly to the active local llama.cpp session, constrains output to tool calls, executes bounded steps, streams events to the existing UI, persists sessions, detects loops, supports cancellation, and pauses approval-gated actions. Its native catalog already covers files and documents, archives, shell, Git, processes, web search/fetch and HTTP, clipboard, notifications, image understanding, and terminal replies.

Use the existing extension seams in this order:

1. **Native tools already present:** ship them after approval hardening; they cover nearly all of the MVP task.
2. **Instruction-only bundled skills:** compose existing tools with one `SKILL.md`; the registry, prompt loading, platform filter, and packaging already exist.
3. **One narrow native primitive when composition is impossible:** G2.2 requires `os.fs.move`, which the current catalog lacks. Add only `move { source, destination }`: no overwrite, both paths confined, approval-gated, exact preview, and reversible by swapping the paths.
4. **Bundled scripts only when unavoidable:** Atomic can execute exact reviewed scripts with its shipped Bun runtime, but they are unsandboxed child processes after approval and the manifest's `dangerous` field is only model-facing metadata.
5. **One generic MCP bridge after MVP:** Atomic already has a separate MCP client/server manager used by ordinary chat, but the autonomous Rust agent's grammar and catalog do not consume it. Reuse that host through one curated, approval-gated `mcp.view`/`mcp.call` adapter instead of writing per-service tools.

Do not add every possible tool for launch. Hide the skill catalog and ship only a scriptless Downloads-organizer skill plus the hardened native tools it needs. Browser control, memory/tasks, dynamic MCP inside agent mode, window control, and filesystem watching are not part of the autonomous agent path at this exact tag. Browser automation is the first post-MVP capability candidate; reuse a pinned browser MCP behind the generic bridge rather than adding another agent.

## Smallest remaining delta

1. Apply the final app brand; replace application IDs, publisher, icons, updater keys/endpoints, and signing identity while preserving required notices. Keep canonical upstream model names.
2. Force one assistant, one pinned model pack, and automatic hardware/runtime selection and download. Pin every model and runtime artifact by exact version, URL, size, and SHA-256; reject absent or mismatched hashes.
3. Hide or route-block the Hub, model picker, providers, inference controls, MCP/API configuration, assistants, and advanced settings.
4. Add the narrow `os.fs.move` primitive required by G2.2. Make the backend fail closed for every mutating tool and shell execution. Before execution, show the exact command or file diff. Add a broad regression test proving a deny decision leaves files/processes unchanged. Remove **Skip all approvals** and **Always allow**; retain only deny and one-action approval.
5. Remove cloud-provider paths, PostHog/Sentry telemetry, external web search, and other default egress; prove local behavior with a network audit.
6. Add only the missing product seams: compatibility gate, model entitlement, hosted checkout/restore including the seven-day full-tier trial, About-this-AI provenance, and the acceptance task.

## Hard gates and risks

- **Qwen3.8 is unproved.** Atomic says it accepts arbitrary GGUF models, but neither its v2.0.0 registry nor this audit proves `Qwen/Qwen3.8-27B` on Windows. Runtime compatibility, quant, tool grammar, speed, RAM/VRAM, and task success must pass.
- **Atomic's privacy claims are not our evidence.** The source contains telemetry/cloud integrations. They must be disabled or removed, then tested for no prompt/file/inference egress.
- **Its guard is currently fail-open for ordinary writes.** Hiding permissive UI is insufficient; backend classification, enforcement, previews, and deny-with-no-side-effect tests must change before any user task.
- **Downloads are not launch-grade reproducible by default.** Backend selection can resolve a dynamic latest release, and SHA-256 is optional in the generic downloader. The product path must require pinned hashes for the model, runtime, and sidecars.
- **Its release infrastructure belongs to Atomic.** Our fork needs its own signing certificate, Tauri updater key, endpoints, identifiers, and reproducible release proof. The upstream workflow signs NSIS/MSI artifacts; Authenticode coverage of the installed executable, CLI, runtime, and sidecars remains a separate gate.
- **A fork creates upstream debt.** Pin the exact release, keep the consumer simplification as a shallow patch set, and cherry-pick only verified upstream fixes.
- **Commerce is not included.** Entitlement and payment remain product-specific work and must not make a permanent model pack dependent on a perpetual online license server.

## Foundation smoke

On a clean supported Windows machine:

1. Build Atomic v2.0.0 without Atomic credentials and produce an internal NSIS installer.
2. Install, launch, and automatically load model/runtime artifacts only after matching pinned SHA-256 values.
3. Turn every mutating tool into an approval-gated action, show an exact command or diff, then run G2.2's fixed Downloads-folder task; verify deny causes no side effect and approve-once completes exactly one action.
4. Confirm no user data leaves the machine with cloud providers, telemetry, web search, MCP, and the local API disabled.
5. Inventory the exact files needed to hide the technical UI, apply app branding/rekey packaging, and Authenticode-sign every shipped executable payload.

If a smoke fails, fix the smallest failing Atomic seam or narrow the supported hardware/capability claim. Do not compare foundations, runtimes, quants, or harnesses, and do not write a custom shell, inference runtime, or agent loop.

## Approved goal-tree resolution

- `D13`: Atomic Chat v2.0.0 is the sole MVP foundation.
- `S4`: fork and simplify Atomic's Tauri desktop shell.
- `S3`: use and harden Atomic's embedded local agent; do not integrate another harness.
- `D2`: use Atomic's default llama.cpp/GGUF path and require only the pass/fail product smoke.

## Primary sources

- [Atomic Chat repository, license, features, requirements, and Jan heritage](https://github.com/AtomicBot-ai/Atomic-Chat)
- [Atomic Chat v2.0.0 release: local agent, GGUF, file tools, approvals](https://github.com/AtomicBot-ai/Atomic-Chat/releases/tag/v2.0.0)
- [Atomic v2.0.0 resource classification: ordinary writes are not approval-gated](https://github.com/AtomicBot-ai/Atomic-Chat/blob/v2.0.0/src-tauri/src/core/agent/resource_class.rs)
- [Atomic v2.0.0 authorization and deliberately limited previews](https://github.com/AtomicBot-ai/Atomic-Chat/blob/v2.0.0/src-tauri/src/core/agent/tools/mod.rs)
- [Atomic v2.0.0 approval dialog](https://github.com/AtomicBot-ai/Atomic-Chat/blob/v2.0.0/web-app/src/containers/dialogs/AgentApprovalDialog.tsx)
- [Atomic v2.0.0 Windows release workflow](https://github.com/AtomicBot-ai/Atomic-Chat/blob/v2.0.0/.github/workflows/release.yml)
- [Atomic v2.0.0 autonomous-agent architecture](https://github.com/AtomicBot-ai/Atomic-Chat/blob/v2.0.0/src-tauri/src/core/agent/ARCHITECTURE.md)
- [Atomic v2.0.0 static agent tool grammar; dynamic MCP is excluded](https://github.com/AtomicBot-ai/Atomic-Chat/blob/v2.0.0/src-tauri/src/core/agent/grammar.rs)
- [Atomic v2.0.0 bundled agent skills](https://github.com/AtomicBot-ai/Atomic-Chat/tree/v2.0.0/src-tauri/resources/agent-skills)
- [Atomic v2.0.0 separate MCP host and tool-call implementation](https://github.com/AtomicBot-ai/Atomic-Chat/blob/v2.0.0/src-tauri/src/core/mcp/commands.rs)
- [Microsoft Playwright MCP browser server](https://github.com/microsoft/playwright-mcp)
- [MCP tool safety guidance: retain a human deny/confirmation path](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/draft/server/tools.mdx#user-interaction-model)
