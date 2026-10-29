# Contributing

ekip turns one Claude Code session into a team lead that delegates work to agents on other quotas.
It prepares project context and provides a terminal and optional hub for coordinating that work.

## Development setup

Clone the repository and run the CLI directly from the checkout; no build step is needed:

```bash
node plugin/bin/ekip.js help
```

Before submitting, run `node --check` on every JavaScript file you touched. Match the surrounding code: ESM, two spaces, double quotes, small named functions, and a comment above non-obvious functions. Avoid minified one-liners. User-facing CLI strings use Turkish source strings passed through `t()` with an English entry in `plugin/lib/i18n.js`.

Update `README.md`, `README.tr.md`, and relevant files in `docs/` when behavior changes.

## Privacy and safety

Never commit personal data: project names, hosts, tokens, UUIDs, logs, or files in `data/`. Put personal configuration in `data/config.json` at runtime through a setup command. Features that touch servers or databases must refuse production targets by design. Destructive commands must require an explicit `--yes`.

## Pull requests

Keep one topic per pull request and use imperative commit messages. For vulnerability reports, use GitHub Security Advisories privately; do not open a public issue.
