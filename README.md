# YoreBot

YoreBot is a local desktop assistant designed to make private AI chat and
approved computer tasks simple for ordinary people.

The MVP automatically chooses a verified local model, keeps ordinary chat
free, and offers one narrow agent task: organizing a Downloads folder with a
reviewed plan, approval before every change, non-overwriting moves, and undo.

## Release status

YoreBot does **not** have a public signed download yet. Current Windows builds
are unsigned internal test installers produced by the repository workflow.
Do not treat upstream Atomic Chat downloads as YoreBot releases.

## Build from source

Prerequisites: Node.js 20+, Yarn 4.5.3+, Rust, and the platform requirements in
[`DEVELOP.md`](DEVELOP.md).

```bash
yarn install
make dev
```

The internal Windows workflow builds an unsigned NSIS installer for testing.
Signing, updater keys, and a public release remain intentionally disabled.

## Upstream attribution

YoreBot is a product fork based on
[Atomic Chat v2.0.0](https://github.com/AtomicBot-ai/Atomic-Chat/releases/tag/v2.0.0),
which is itself a hard fork of [Jan](https://github.com/janhq/jan).
The repository retains upstream copyright notices, licenses, legacy internal
identifiers, and component-specific license terms. See [`LICENSE`](LICENSE)
and the included dependency notices before redistribution.
