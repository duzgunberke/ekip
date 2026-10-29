---
name: ekip-setup
description: Use when someone has cloned ekip and wants first-time setup, needs setup gaps handled, or asks how to update ekip.
---

# Set up ekip from a clone

1. Check prerequisites: macOS, Node 22+, Docker running, Claude Code, and git.

   iTerm2 is recommended for the task pane.
2. If notifications are wanted, install `terminal-notifier` with `brew install

   terminal-notifier`.
3. From the cloned repository, run `node plugin/bin/ekip.js init`. It is

   interactive and safe to rerun.
4. Init links the CLI, starts local services, installs the Claude Code plugin

   and MCP servers, installs supported worker CLIs, opens provider-key setup,
   and begins worker sign-in.
5. Let the user complete interactive provider and account steps: run `ekip

   keys` to open free provider key pages and `ekip agents login` to
   authenticate available worker CLIs.
6. Register existing work with `ekip project add PATH` or discover repositories

   using `ekip project scan PATH`.
7. Project registration builds a card, code graph, wiki, memory context, and

   imports recent Claude history as configured.
8. Run `ekip doctor` and use its findings to close the useful setup gaps. Do

   not repeat an optional offer after the user declines it in the session.
9. Offer the optional VPS hub once when useful; it keeps the panel, free pool,

   memory, and job queue available while the Mac is off.
10. Explain briefly that the user starts with `ekip`, talks as usual, sees

   progress in a pane/panel, and can see commands with `ekip help`.
11. Check the installed version using `node plugin/bin/ekip.js version`. Update the checkout with

   `ekip update`; it fast-forwards and prints the changelog.
12. After an update, restart the lead or reload plugins so new hooks and skills

   are loaded. The hub picks up its update on its next deploy.
13. On macOS, notifications may require the user to grant terminal-notifier/ekip

   notification permission in system settings.
14. Do not block the user's actual request while setup gaps are being offered or

   repaired. Track longer setup work as a task.
15. “Done” means `ekip doctor` has no unresolved required setup gaps, at least
   one usable worker pool is connected when delegation is wanted, and
   registered projects show their context.
