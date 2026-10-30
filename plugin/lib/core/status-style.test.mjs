// The state colour/symbol table: truecolor, 256, 16 colours (ASCII), NO_COLOR, pipes, narrow panes.
import assert from "node:assert/strict";
import { STATES, asciiOnly, badge, bar, barCells, colorMode, glyph, icon, paint, rank, taskState } from "./status-style.js";
import { fit, strip } from "./ui.js";

const tty = { isTTY: true }, pipe = { isTTY: false };
const truecolor = { TERM: "xterm-256color", COLORTERM: "truecolor" };
const xterm16 = { TERM: "xterm" };

// every state the task pane, `ekip tasks` and `ekip agents` use has a symbol and an ASCII fallback
for (const s of ["running", "done", "failed", "blocked", "waiting-user", "paused", "queued", "pending", "stalled"]) {
  assert.ok(STATES[s]?.glyph && STATES[s]?.ascii, s);
  assert.ok(/^[\x20-\x7e]$/.test(STATES[s].ascii), `${s} ascii`);
}
assert.deepEqual(["running", "done", "failed", "blocked", "waiting-user", "paused", "queued"].map((s) => STATES[s].glyph), ["●", "✓", "✗", "■", "?", "◌", "⧗"]);

// modes
assert.equal(colorMode(tty, truecolor), "rgb");
assert.equal(colorMode(tty, { TERM: "xterm-256color" }), "256");
assert.equal(colorMode(tty, xterm16), "16");
assert.equal(colorMode(tty, { ...truecolor, NO_COLOR: "1" }), "none");
assert.equal(colorMode(tty, { TERM: "dumb" }), "none");
assert.equal(colorMode(pipe, truecolor), "none");

// truecolor: the brand colours (teal running, green done, red failed, orange blocked)
assert.equal(paint("running", "x", tty, truecolor), "\x1b[38;2;45;212;191mx\x1b[39m");
assert.equal(paint("done", "x", tty, truecolor), "\x1b[38;2;63;207;122mx\x1b[39m");
assert.equal(paint("blocked", "x", tty, truecolor), "\x1b[38;2;245;165;36mx\x1b[39m");
assert.match(paint("waiting-user", "x", tty, truecolor), /^\x1b\[1;38;2;250;204;21mx\x1b\[22;39m$/);
assert.match(paint("queued", "x", tty, { TERM: "xterm-256color" }), /^\x1b\[38;5;\d+mx\x1b\[39m$/);
assert.equal(icon("failed", tty, truecolor), "\x1b[38;2;242;85;90m✗\x1b[39m");

// NO_COLOR: no escape codes at all, the symbols stay (they carry the state on their own)
const noColor = { ...truecolor, NO_COLOR: "1" };
for (const s of Object.keys(STATES)) {
  assert.ok(!badge(s, "label", tty, noColor).includes("\x1b"), s);
  assert.ok(!bar(s, 40, 10, tty, noColor).includes("\x1b"), s);
}
assert.equal(badge("blocked", "engellendi: anahtar yok", tty, noColor), "■ engellendi: anahtar yok");
// a pipe (the lead reading `ekip tasks`): unicode, no colour
assert.equal(icon("running", pipe, truecolor), "●");

// 16 colours: plain ASCII symbols and an ASCII bar, basic colours
assert.equal(asciiOnly(tty, xterm16), true);
assert.equal(glyph("queued", tty, xterm16), "~");
assert.equal(icon("done", tty, xterm16), "\x1b[32m+\x1b[39m");
assert.equal(strip(bar("running", 50, 10, tty, xterm16)), "[#####.....]");
assert.equal(asciiOnly(pipe, { EKIP_ASCII: "1" }), true);
assert.equal(asciiOnly(tty, { TERM: "linux" }), true);

// the unicode bar keeps its width and uses the state's colour
assert.equal(strip(bar("running", 50, 10, tty, truecolor)).length, 10);
assert.equal(strip(bar("failed", 100, 8, tty, truecolor)), "████████");
assert.ok(bar("failed", 30, 10, tty, truecolor).startsWith("\x1b[38;2;242;85;90m"));
assert.equal(strip(bar("done", -5, 6, pipe, {})), "░░░░░░");

// narrow panes: a shorter bar, and a cut line still closes its colour
assert.equal(barCells(40), 6);
assert.equal(barCells(60), 10);
assert.equal(barCells(120), 20);
const line = `  ${bar("running", 42, barCells(30), tty, truecolor)} 42%  ${badge("waiting-user", "kullanıcı bekleniyor: hangi sürüm?", tty, truecolor)}`;
const cut = fit(line, 30);
assert.ok(strip(cut).length <= 30, strip(cut));
assert.ok(strip(cut).endsWith("…"));

// task state and order: waiting for the user first, then failures, done last
assert.equal(taskState({ status: "running", hold: { kind: "waiting-user" } }), "waiting-user");
assert.equal(taskState({ status: "running", hold: { kind: "blocked" } }), "blocked");
assert.equal(taskState({ status: "running" }, { paused: true }), "paused");
assert.equal(taskState({ status: "running" }), "running");
assert.equal(taskState({ status: "done" }), "done");
const order = ["done", "running", "queued", "waiting-user", "paused", "failed", "blocked"].sort((a, b) => rank(a) - rank(b));
assert.deepEqual(order, ["waiting-user", "failed", "blocked", "paused", "running", "queued", "done"]);

console.log("status styles: ok");
