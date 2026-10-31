<h1><img src="brand/logo-mark.svg" width="40" height="40" alt="" style="vertical-align: middle"> Built not to get stuck</h1>

What ekip does when long agent work fails quietly: a CLI hangs, a free model stops answering, a task says "running" all night.

[README](../README.md) · [How it works](architecture.md) · [Memory](memory.md) · [Skills](skills.md) · **Reliability** · [Install](install.md) · [Commands](commands.md) · [Operations](operations.md)

<table>
  <tr>
    <td width="50%"><img src="demo/terminal-status.gif" alt="ekip status: running now, waiting for you, stuck, finished with results and links, and the release line"><br><sub><b>ekip status</b> · what runs, what waits for you, what is stuck, what finished</sub></td>
    <td width="50%"><img src="demo/terminal-track.gif" alt="ekip track: an upload with percent, speed and finish time that ends done, and a copy that warns it is slower than expected"><br><sub><b>ekip track</b> · a long upload with percent, speed and finish; a slow copy warns at once</sub></td>
  </tr>
</table>

## What ekip handles by itself



- **Every worker has a watchdog.** 15 minutes without output or 90 minutes in total, and it is stopped;
  the reason goes onto the task and `auto` moves the work to the next pool. A worker waiting on a
  long job of its own is not idle while that job uses CPU. After a silent pool the weak pools are
  skipped, and a second silent pool in a row stops the chain and blocks the task instead of burning
  another hour.
- **No ghost workers.** A worker whose process died is closed with the reason (signal, likely cause)
  by every task command, the pane and the hub sync; `ekip task cancel` stops the task's live workers.
  A running step with no live worker shows as "paused", not "running".
- **Waiting is not stalling.** `ekip task block ID "why"` and `ekip task wait ID "what you decide"`
  mark a task blocked or waiting for you (you get a notification); neither shows a stall warning or
  an estimate.
- **Decisions stay on the panel.** When the lead asks you something in chat it also runs `ekip task
  ask ID "question" --option A --option B`; the question and its options sit at the top of the panel
  and of `ekip status` until you answer.
- **Every finished task says what it produced.** `ekip task done ID "result" --link <file or URL>`,
  or, by itself, the first paragraph and the paths/URLs of the worker's report: "Result: …" with
  clickable links in the pane, `ekip status` and the panel.
- **Work waits for its turn.** `ekip run --after ID` or `--when "CMD"` waits in the background until
  a task or run finished, or a shell test passes. Heavy local work (`--heavy`, or a brief about a
  render) takes one of the machine's slots (from cores and memory, `maxLocalWorkers`) and queues
  when the Mac is full or overloaded. `--resume RUN` restarts a cut-off brief where it stopped,
  `--retry-on-kill` restarts a worker killed by load once the load drops.
- **Pool switches are visible.** Every fallback is noted on the task ("codex out of quota, resets
  …, moved to copilot"); `--min-tier strong` never falls to a weak pool.
- **Long commands are watched, not forgotten.** An upload, an encode or a queue script runs through
  `ekip track --task ID --label "..." -- <command>` instead of a bare background shell. It reads
  progress from the output (`12%`, `3/12`, `256 MiB/1.5 GiB`) or from `--measure "<cmd>"` against
  `--total`, keeps the step's percent, speed and finish time true, blocks the step when nothing moves
  for `--stall` minutes, warns at once when the first two minutes' speed would miss `--eta-max`, and
  closes the step done or failed (with the last lines and the signal cause) when the command ends.
- **Orphans come first.** A step marked running with no live worker or tracked job for 10 minutes
  shows as paused, and the lead's next message starts with it as an action it must take: close it or
  restart it under a live process.
- **Tasks close themselves** when their steps are done or their last worker ends, and a task nobody
  touched for 6 hours is closed as stalled. The pane and the panel never show yesterday's work as live.
- **Estimates are measured, not guessed.** The finish time comes from the real rate of progress; with
  no basis yet, ekip shows none instead of a made-up number.
- **Background jobs run one copy at a time**, so two imports never fight over the same quota.
- **Every worker starts from the project's knowledge.** `ekip run --project` searches the project's
  skills and memory with the brief and appends what matches, even when the lead forgot to look.
- **You can see whether that knowledge is used.** `ekip stats` counts memory, wiki, skill and code
  graph lookups per project, by the lead's hook, worker briefs and MCP calls, with hit rates, which
  skills workers actually opened, and run success with and without knowledge (signals, not proof).
- **Nothing runs out of sight.** Workers open in a pane, and any long job the lead starts itself
  gets one too (`ekip show <log>`).
- **One screen answers "what is going on?"** `ekip status` (`ekip durum`) shows what runs now
  (percent, speed, finish, last output line), what waits for you, what is stuck and what ekip did
  about it, what finished in the last 24 hours with its result and links, and ekip's own release
  (version, main under test or passed, hub up to date). The task pane and the panel's task page show
  the same digest on top, questions in red and stuck work in orange.
- **A pool whose quota ran out leaves the rotation** until it resets, instead of failing every job sent
  to it; the reset time is read from the CLI's own message and `ekip agents` shows when it comes back.
- **Workers keep out of each other's way.** Every brief tells them to stop only processes they
  started, by PID, never with `pkill`/`killall`; a job handed over with `ekip show --pid` survives
  when its worker is stopped.
- **The panel tells the truth.** Updates that did not reach the hub are sent again, every finished
  run brings its log, a long step stays "alive" while real work is measured, and the terminal pane
  restarts itself when ekip is updated.
- **Memory stays in your language.** A nightly sweep rewrites any memory a free model wrote in the
  wrong language, text, search index and vector together.

## The same states everywhere

The terminal task pane, the WezTerm tab bar, `ekip status` and the panel use one set of states; what
waits for you is always on top.

| State | Looks like | | State | Looks like |
|---|---|---|---|---|
| waiting for you | yellow `?` | | running | teal `●` |
| blocked | orange `■` and why | | queued | blue `⧗` and its place |
| failed | red `✗` | | done | green `✓` |
| paused, no live worker | grey `◌` | | | |

Without 256 colours the terminal falls back to ASCII, and `NO_COLOR` is respected. The mechanics
(watchdog limits, reaper, tracked jobs, machine slots) are in [How it works](architecture.md#seeing-what-is-going-on).

---

[← Skills](skills.md) · Next: [Install](install.md)
