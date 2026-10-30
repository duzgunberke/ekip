# Contributing

ekip turns one Claude Code session into a team lead that delegates work to agents on other quotas.
It prepares project context and provides a terminal and optional hub for coordinating that work.

## Development setup

Clone the repository and run the CLI directly from the checkout; no build step is needed:

```bash
node plugin/bin/ekip.js help
```

Before submitting, run `node --check` on every JavaScript file you touched. Match the surrounding code: ESM, two spaces, double quotes, small named functions, and a comment above non-obvious functions. Avoid minified one-liners. User-facing CLI strings use Turkish source strings passed through `t()` with an English entry in `plugin/lib/core/i18n.js`.

Update `README.md`, `README.tr.md`, and relevant files in `docs/` when behavior changes.

## Privacy and safety

Never commit personal data: project names, hosts, tokens, UUIDs, logs, or files in `data/`. Put personal configuration in `data/config.json` at runtime through a setup command. Features that touch servers or databases must refuse production targets by design. Destructive commands must require an explicit `--yes`.

## Pull requests

Keep one topic per pull request and write commit messages, branch names and merge subjects in English, in the imperative (the repository is public; Turkish belongs only in the `t()` source strings). For vulnerability reports, use GitHub Security Advisories privately; do not open a public issue.

## Branches and releases

Work on a branch (`feat/<topic>`, `fix/<topic>`) and merge it into `main` when `bash scripts/smoke.sh`
and the privacy check pass. Every commit that lands on `main` gets a fresh-install test on a clean
machine; when it passes, it is released automatically: the version comes from the commit subjects
merged since the last tag (`feat:` or `minor:` bumps the minor version, `major:` or `BREAKING CHANGE`
the major one, anything else the patch), that exact commit is tagged and a GitHub release lists the
changes. There is no release commit: ekip reads its version from the tag. Never tag by hand.

## Moving or renaming modules

ekip runs from its own checkout, and long-lived processes (a worker that started before your change,
the task pane, the doctor) load modules lazily. When a module moves, leave a one-line forwarder at the
old path (`export * from "./new/place.js";`) for at least one release, so those processes do not fail
with "Cannot find module" halfway through.
