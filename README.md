<p align="center">
  <img src="docs/brand/banner.svg" alt="ekip: one terminal, one Claude, a whole team" width="100%">
</p>

<p align="center">
  <b>Turn one Claude Code session into a team lead.</b><br>
  Claude plans and reviews. Agents on other quotas do the work, each starting from the project's own memory and skills.
</p>

<p align="center">
  <a href="https://github.com/duzgunberke/ekip/releases"><img src="https://img.shields.io/github/v/release/duzgunberke/ekip?style=flat-square&label=release&color=2DD4BF" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-FFA95E?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-Node%2022%2B-6B7280?style=flat-square" alt="macOS, Node 22+">
  <img src="https://img.shields.io/badge/hub-any%20Linux%20VPS-6B7280?style=flat-square" alt="Hub: any Linux VPS with Docker">
</p>

<p align="center">
  <b>English</b> · <a href="README.tr.md">Türkçe</a>
</p>

<p align="center">
  <img src="docs/demo/terminal-wezterm.gif" alt="Typing ekip opens the lead in WezTerm: the Claude session on the left, two workers writing their logs on the right, the task pane below with running, queued, blocked, waiting-for-you and done tasks" width="100%"><br>
  <sub>Type <code>ekip</code>: the lead on the left, workers on the right, live tasks below (<a href="docs/demo/terminal-wezterm.mp4">MP4</a>)</sub>
</p>

## Why: Claude's limit goes to deciding, not reading

Most of a Claude Code limit is spent **reading**: files, logs, history, the same context again in every
session. ekip moves that work off Claude:

- **Claude only decides.** It understands the request, splits it, picks a worker for each part and
  reviews the result. Reading and typing run on **other quotas**: Antigravity, Codex, Copilot, Qwen,
  OpenCode, grok and about 60 free-tier models behind one endpoint.
- **Context is prepared once.** Every project gets a memory: past sessions in a vector database, an LLM
  wiki from its docs, a code graph and its own skills. Workers start from that instead of re-reading
  the repo, and the lead gets only the few facts that matter for the message.
- **Measured, not promised.** `ekip savings` shows the share of the work that ran outside Claude.

<p align="center"><img src="docs/assets/savings.svg" alt="Share of the work that ran outside Claude, measured with ekip savings: 58% during the two-day setup, 81% the next day" width="100%"></p>

## Quick start

Needs macOS, Node 22+, Docker and [Claude Code](https://claude.com/claude-code).

```bash
git clone https://github.com/duzgunberke/ekip.git && cd ekip && node plugin/bin/ekip.js init
ekip setup     # step by step: free model keys, worker sign-ins, your projects
ekip           # start the lead and talk to it as you talk to Claude
```

`ekip init` installs the services, the plugin, the MCP servers, the worker CLIs and ekip's own
terminal (WezTerm, with an `ekip.app` in the Dock). `ekip setup` shows what is still missing and
remembers what you snoozed; every start reminds you of the most useful next step once. `ekip lang en`
or `ekip lang tr` sets the language. New releases install themselves.

## What you get

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/terminal-wezterm-hero.png" alt="ekip in WezTerm: the lead on the left, two workers on the right, the task pane below with a card per task"><br><br>
      <b>A team on other quotas.</b> Claude splits each request and hands the parts to Antigravity, Codex, Copilot, Qwen, OpenCode, grok and about 60 free models. <code>ekip mesai on</code> keeps every pool busy.
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/panel-tasks-dark.png" alt="The panel's task page: a digest card with waiting for you, stuck, running and finished, above the live tasks"><br><br>
      <b>Everything in sight.</b> Each request is a task with live steps, in a pane under the session and on the web panel. Questions for you sit on top in red, stuck work in orange.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/demo/terminal-status.gif" alt="ekip status: running now, waiting for you, stuck, finished with results and links, and the release line"><br><br>
      <b>One answer to "what is going on?"</b> <code>ekip status</code> shows what runs, what waits for you, what is stuck and what finished, with results, links and the release line.
    </td>
    <td width="50%" valign="top">
      <img src="docs/demo/terminal-track.gif" alt="ekip track: an upload with percent, speed and finish time that ends done, and a copy that warns it is slower than expected"><br><br>
      <b>Built not to get stuck.</b> Watchdogs, a reaper for dead workers, pool fallback, queues (<code>--after</code>, <code>--when</code>), <code>--resume</code>, and <code>ekip track</code> for long uploads and renders.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/panel-codemap-dark.png" alt="The panel's code map: a project's repositories, folders and the symbols of one file"><br><br>
      <b>Memory per project.</b> Past sessions in a vector database, an LLM wiki from the docs, a code graph, skills and lessons. Mention a project and its facts arrive in a second. <a href="#memory-that-follows-your-message">More ↓</a>
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/skill-loop-mini.svg" alt="The skill loop, small: runs logged, repeats grouped, skill learn, you accept, .claude/skills, every brief; lessons on top of every brief and the lead"><br><br>
      <b>Skills it learns.</b> Work that repeats in a project becomes a <code>SKILL.md</code> you approve, and every later worker brief in that project uses it. <a href="#skills-that-come-from-your-own-work">How it works ↓</a>
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <img src="docs/demo/panel-demo.gif" alt="The ekip web panel in dark mode: the status digest above live tasks, the command menu, the code map, runs across projects, project cards and worker pools with their quotas" width="100%"><br><br>
      <b>The web panel.</b> With a hub linked, the same tasks, runs across projects, worker pools with their quotas and each project's code map open in the browser, from any device, behind the password and a passkey. <a href="docs/demo/panel-demo.mp4">MP4</a> · <a href="docs/architecture.md#seeing-what-is-going-on">More</a>
    </td>
  </tr>
</table>

## Memory that follows your message

Every registered project gets its own memory, built once and kept current, and every worker starts
from it instead of from zero:

- **A vector database** of past Claude sessions, decisions and worker reports, searched by meaning.
- **An LLM wiki** written from the project's docs, and **a code graph** of its files and symbols.
- **Skills** learned from its own work, and **lessons** from the mistakes you corrected.

Mention a project, even misspelled, and ekip adds what matters to Claude's context in about a second.
`ekip stats` shows whether that knowledge is really used: lookups, hit rate, the skills workers opened.

<p align="center"><img src="docs/assets/memory-follows.svg" alt="You write about ios-ap with a typo; ekip finds the ios-app project, searches its memory in about a second and adds the relevant facts and skills to Claude's context" width="100%"></p>

How memory works and why vectors matter, in depth: [docs/memory.md](docs/memory.md) and the author's
2023 article [Vektörel Database nedir, ne işe yarar?](https://medium.com/@duzgunberke/vekt%C3%B6rel-database-nedir-ne-i%C5%9Fe-yarar-f832b30421ac) (in Turkish).

## Skills that come from your own work

Every project has procedures nobody wrote down: how it releases, which check catches the usual bug,
the one flag that must never be forgotten. ekip finds them in the work you already did and turns them
into plain Claude Code skills.

<p align="center"><img src="docs/assets/skill-loop.svg" alt="The skill loop: runs are logged, repeats are grouped, ekip skill learn drafts a SKILL.md, you accept it, it lives in .claude/skills, every later worker brief and the lead use it; corrected mistakes become lessons on top of every brief and the lead's context" width="100%"></p>

- **From real runs.** Every worker brief and report is logged per project. Runs with the same label or
  overlapping briefs are grouped; a group of three or more gets a drafted `SKILL.md` with the
  procedure, files, checks, traps and a definition of done. Commands come only from the runs and the
  project's own docs.
- **You approve.** Drafts wait as candidates. Accepting one puts it in the project's `.claude/skills/`,
  committed with the code; rejecting one means it is not proposed again. `ekip doctor` drafts once a
  day by itself.
- **Used without asking.** `ekip run` matches the brief against the project's skills and appends the
  ones that fit, so does the lead's prompt hook. Skills that memory extracted from past sessions are
  found the same way, and through the `skill_search` and `skill_get` tools.
- **Lessons on top.** When you correct a mistake, `ekip project lesson` writes it down and every later
  brief in that project starts with it, whatever it is about.

A video-editing project ran "render the 9:16 cut, check the loudness, upload it" three times. ekip
drafted `flow-production-unit` with the composition to render, the loudness check and the trap that
broke one run. After one `accept`, the next render brief listed it and the worker followed it.

```bash
ekip skill learn my-app                    # group repeated runs, draft SKILL.md candidates
ekip skill candidates                      # read what was drafted
ekip skill accept my-app release-ios       # install it into my-app/.claude/skills
```

More: [docs/skills.md](docs/skills.md) (the loop step by step, lessons, project reviews, `.ekip/` settings).

## How it works

<p align="center"><img src="docs/assets/how-it-works.svg" alt="You talk to one Claude lead. It routes each part of the work to Antigravity, Codex, Copilot or the free pool. Every worker starts from the project memory: facts, wiki, code graph, skills. An optional VPS hub keeps memory, the free pool and a job queue running." width="100%"></p>

You talk to one Claude session. It creates a task, routes each part to the pool with quota and the
best recent record, and reviews what comes back with `ekip review`. Claude's limit goes to deciding;
reading and typing run elsewhere. `ekip savings` measures the share: 81% of the work ran outside
Claude on a normal day of the author's, 58% during the cold setup ([the numbers](docs/architecture.md#why)).

<details>
<summary><b>More, in short</b></summary>

- **Registering a project** (`ekip project add`) imports its past Claude sessions, builds a code graph
  and a wiki, and writes a project card. [Memory](docs/memory.md)
- **Pool choice** follows tested pools, recent success and detected quota limits; the free pool is
  last. [How it works](docs/architecture.md)
- **Stuck work** is found and handled: silent workers are stopped, dead ones closed with the reason,
  long jobs tracked with real percent and finish time. [Reliability](docs/reliability.md)
- **Agents can talk** to each other through hoptell, and work against safe dev databases (`ekip dev`).
  [How it works](docs/architecture.md#agents-that-talk-to-each-other)
- **A VPS hub** keeps memory, the free pool and a job queue running while the Mac is off, and serves
  the web panel. [Install](docs/install.md#optional-vps-hub)
- **A private hub:** `ekip hub private` puts the hub on your Tailscale tailnet, so the panel and API
  open only from your own devices, with no domain or DNS record. [Install](docs/install.md#private-hub-with-tailscale)
- **Your phone** (a Telegram bot on the hub) follows every task live, answers the lead's questions
  with buttons and types new work into the live lead; with the Mac off, work goes to the hub's queue.
  `ekip phone setup` connects it. [Phone](docs/install.md#optional-your-phone-telegram)

</details>

What it does not do: it does not make free models as good as Claude. They are slower, time out under
load and cool down at their limits. ekip routes around that and keeps Claude for decisions.

## Learn more

| | |
|---|---|
| [How it works](docs/architecture.md) | request lifecycle, pool choice, mesai mode, what you see where |
| [Memory](docs/memory.md) | project indexing, vectors, wiki, code graph, what is stored |
| [Skills](docs/skills.md) | the learning loop, lessons, project reviews, `.ekip/` settings |
| [Reliability](docs/reliability.md) | watchdogs, queues, tracked jobs, task states |
| [Install](docs/install.md) | Mac setup, guided setup, terminal, provider keys, the VPS hub |
| [Commands](docs/commands.md) | every command, every worker pool |
| [Operations](docs/operations.md) | upstream patches, troubleshooting, data and privacy |
| [Roadmap](docs/roadmap.md) | v2 shared team memory, v3 integrations (errors, uptime, analytics) |

## Built on

[freellmapi](https://github.com/tashfeenahmed/freellmapi) ·
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) ·
[codegraph](https://github.com/colbymchenry/codegraph) ·
[hoptell](https://github.com/EminUZUN/hoptell) ·
[shadcn-admin](https://github.com/satnaing/shadcn-admin) ·
[WezTerm](https://wezterm.org) ·
and the agent CLIs of Antigravity, Codex, Copilot, Qwen Code, OpenCode and grok-cli.

MIT licensed; the projects it builds on keep their own licenses. See [Contributing](CONTRIBUTING.md)
before opening a pull request.
