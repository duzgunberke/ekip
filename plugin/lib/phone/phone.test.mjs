// The Mac side of the phone with a fake terminal back end (recorded send-text calls) and a fake hub:
// idle vs busy delivery, transcript parsing, /stop as Escape, inbox answers applied to tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-phone-mac-"));
process.env.EKIP_HOME = home;
// a hub address nothing listens on: task pushes fail fast, the phone's calls go to the fake fetch
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ hubUrl: "http://127.0.0.1:9", hubToken: "test-token-0123456789", taskPane: false }));
const env = { ...process.env, EKIP_LEAD: "1", WEZTERM_PANE: "5", TERM_PROGRAM: "WezTerm" };
delete env.EKIP_RUN_DEPTH; delete env.KITTY_WINDOW_ID; delete env.ITERM_SESSION_ID;
Object.assign(process.env, { WEZTERM_PANE: "5", EKIP_LEAD: "1" });
delete process.env.KITTY_WINDOW_ID; delete process.env.ITERM_SESSION_ID; delete process.env.EKIP_RUN_DEPTH;

const phone = await import("./phone.js");
const { typingText } = await import("../core/terminal.js");

function fakeTerm() {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    if (args.includes("list")) return { status: 0, stdout: JSON.stringify([{ pane_id: 5, tab_id: 1, window_id: 1, title: "claude" }, { pane_id: 9, tab_id: 2, window_id: 1, title: "claude" }]) };
    if (args.includes("spawn")) return { status: 0, stdout: "9\n" };
    return { status: 0, stdout: "" };
  };
  const sent = () => calls.filter((c) => c.args.includes("send-text")).map((c) => c.args.at(-1));
  return { run, calls, sent };
}
function fakeHub(items = []) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const p = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ p, body, method: init.method });
    const json = p === "/api/inbox/sync" ? { items: items.splice(0), phone: { mode: "on", verbose: false, linked: true } } : { ok: true };
    return { ok: true, status: 200, json: async () => json, arrayBuffer: async () => Buffer.from("IMG") };
  };
  return { fetchFn, calls };
}
const reset = () => { fs.rmSync(path.join(home, "phone"), { recursive: true, force: true }); phone.writeState({ linked: true, mode: "on" }); };

test("typed only when the lead is idle; while a turn runs it waits for the Stop hook", async () => {
  reset();
  const term = fakeTerm();
  await phone.hook("session", { cwd: home, transcript_path: path.join(home, "t.jsonl") }, { env });
  assert.equal(phone.readLead("wezterm-5").state, "idle");

  const r = await phone.deliver("deploy the site", { run: term.run });
  assert.equal(r.to, "lead");
  assert.deepEqual(term.sent(), ["📱 deploy the site", "\r"], "the text as the user would type it, then Enter");
  const typed = term.calls.find((c) => c.args.includes("send-text"));
  assert.ok(typed.args.includes("--no-paste") && typed.args.includes("--pane-id") && typed.args.includes("5"));
  assert.equal(phone.readLead("wezterm-5").state, "busy");

  // the prompt hook confirms a phone turn; a second message waits
  await phone.hook("prompt", { prompt: "📱 deploy the site" }, { env });
  assert.equal(phone.readLead("wezterm-5").phoneTurn, true);
  term.calls.length = 0;
  await phone.deliver("and run the tests", { run: term.run });
  assert.deepEqual(term.sent(), [], "busy: nothing is typed");
  assert.equal(phone.readQueue("wezterm-5").length, 1);

  // Stop: idle again, then the queue is typed
  phone.markIdle({ env });
  assert.equal(phone.pump("wezterm-5", { run: term.run }), true);
  assert.deepEqual(term.sent(), ["📱 and run the tests", "\r"]);
  assert.equal(phone.readQueue("wezterm-5").length, 0);
  // a prompt typed at the Mac is not a phone turn
  await phone.hook("prompt", { prompt: "local question" }, { env });
  assert.equal(phone.readLead("wezterm-5").phoneTurn, false);
});

test("several lines go in as one paste; control characters are dropped", async () => {
  reset();
  const term = fakeTerm();
  await phone.hook("session", { cwd: home }, { env });
  await phone.deliver("line one\nline two\u001b[31m", { run: term.run });
  const first = term.calls.find((c) => c.args.includes("send-text"));
  assert.ok(!first.args.includes("--no-paste"), "multi-line text is pasted, so the newline does not submit early");
  assert.equal(first.args.at(-1), "📱 line one\nline two[31m");
  assert.equal(typingText("a\u0007b\r\nc"), "ab\nc");
});

test("/stop presses Escape in the lead's pane", async () => {
  reset();
  const term = fakeTerm();
  await phone.hook("session", { cwd: home }, { env });
  await phone.hook("prompt", { prompt: "long job" }, { env });
  assert.equal(await phone.apply({ kind: "stop" }, { run: term.run }), "stopped");
  assert.deepEqual(term.sent(), ["\x1b"]);
  assert.equal(phone.readLead("wezterm-5").state, "idle", "an interrupted turn is at the prompt again");
});

test("a test EKIP_HOME never types into, interrupts or opens a tab in the real terminal", async () => {
  reset();
  // this file runs with its own EKIP_HOME and an inherited WEZTERM_PANE: without an injected back end
  // (the test double) nothing may reach the real terminal
  assert.equal(phone.testHome(), true);
  await phone.hook("session", { cwd: home }, { env });
  const r = await phone.deliver("must stay queued");
  assert.equal(r.to, "lead");
  assert.equal(phone.readLead("wezterm-5").state, "idle", "nothing was typed");
  assert.equal(phone.pump("wezterm-5"), false);
  await phone.hook("prompt", { prompt: "x" }, { env });
  assert.equal(phone.stopLead(phone.readLead("wezterm-5")), false, "no Escape into the user's pane");
  assert.equal(phone.testHome({ EKIP_HOME: "" }), false);
});

test("the transcript's last assistant message: after the last tool call, sidechains ignored", () => {
  const file = path.join(home, "session.jsonl");
  const line = (o) => JSON.stringify(o);
  fs.writeFileSync(file, [
    line({ type: "user", message: { role: "user", content: "first question" } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } }),
    line({ type: "user", message: { role: "user", content: [{ type: "text", text: "📱 fix the bug" }] } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Looking at it." }, { type: "tool_use", id: "x", name: "Bash", input: { command: "npm test" } }] } }),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } }),
    line({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Fixed: the test passes." }] } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Anything else?" }] } }),
    "not json",
  ].join("\n"));
  assert.equal(phone.lastAssistantText(file), "Fixed: the test passes.\n\nAnything else?");
  assert.equal(phone.lastAssistantText(path.join(home, "missing.jsonl")), "");
});

test("the Stop hook sends the reply (redacted) and types what waited", async () => {
  reset();
  const file = path.join(home, "s2.jsonl");
  fs.writeFileSync(file, [JSON.stringify({ type: "user", message: { role: "user", content: "📱 go" } }), JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done, token=abc123secret" }] } })].join("\n"));
  const hub = fakeHub();
  await phone.hook("session", { cwd: home }, { env });
  await phone.hook("prompt", { prompt: "📱 go" }, { env });
  await phone.hook("stop", { transcript_path: file }, { env, fetchFn: hub.fetchFn });
  const reply = hub.calls.find((c) => c.p === "/api/phone/reply");
  assert.ok(reply);
  assert.equal(reply.body.phoneTurn, true);
  assert.ok(!reply.body.text.includes("abc123secret"));
  assert.equal(phone.readLead("wezterm-5").state, "idle");
});

test("tool calls become one-liners", () => {
  assert.equal(phone.toolLine({ tool_name: "Bash", tool_input: { command: "npm test\necho done" } }), "Bash: npm test");
  assert.equal(phone.toolLine({ tool_name: "Edit", tool_input: { file_path: "/x/y/app.js" } }), "Edit: app.js");
  assert.equal(phone.toolLine({ tool_name: "mcp__ekip__memory_search", tool_input: { query: "x" } }), "memory_search: x");
  const fake = "sk" + "-abcdefghijklmnopqrstu"; // assembled so the privacy check stays clean
  assert.ok(!phone.toolLine({ tool_name: "Bash", tool_input: { command: `curl -H 'Authorization: Bearer ${fake}'` } }).includes(fake));
});

test("sync: an answer from the phone is applied to the task, acked, and never applied twice", async () => {
  reset();
  const tasks = await import("../tasks/tasks.js");
  const t = tasks.create({ title: "Pick a colour", steps: ["Design"] });
  tasks.ask(t.id, "Which colour?", ["Blue", "Green"]);
  const term = fakeTerm();
  const hub = fakeHub([{ id: "i1", kind: "answer", task: t.id, choice: "Green" }]);
  await phone.hook("session", { cwd: home }, { env });
  const r = await phone.sync({ force: true, run: term.run, fetchFn: hub.fetchFn });
  assert.equal(r.items, 1);
  const after = tasks.list().find((x) => x.id === t.id);
  assert.equal(after.answers.at(-1).answer, "Green");
  assert.equal(after.ask, undefined);
  assert.deepEqual(hub.calls.find((c) => c.p === "/api/inbox/ack").body.ids, ["i1"]);
  // the lead that asked is told (typed: it was idle)
  assert.ok(term.sent().some((s) => s.includes("Green")));
  const sync = hub.calls.find((c) => c.p === "/api/inbox/sync");
  assert.equal(sync.body.leads[0].id, "wezterm-5");
  // the same item again (an ack that was lost): not applied a second time
  const n = tasks.list().find((x) => x.id === t.id).answers.length;
  const hub2 = fakeHub([{ id: "i1", kind: "answer", task: t.id, choice: "Green" }]);
  await phone.sync({ force: true, run: term.run, fetchFn: hub2.fetchFn });
  assert.equal(tasks.list().find((x) => x.id === t.id).answers.length, n);
});

test("no lead open: a request goes to the hub's job queue", async () => {
  reset();
  const hub = fakeHub([{ id: "r1", kind: "request", text: "write the changelog", chat: 42 }]);
  await phone.sync({ force: true, run: fakeTerm().run, fetchFn: hub.fetchFn });
  const job = hub.calls.find((c) => c.p === "/api/phone/tojob");
  assert.deepEqual(job.body, { text: "write the changelog", chat: 42 });
});

test("a photo from the phone is saved in the scratch inbox and its path is typed", async () => {
  reset();
  const term = fakeTerm();
  await phone.hook("session", { cwd: home }, { env });
  const hub = fakeHub([{ id: "p1", kind: "request", text: "what is this?", files: [{ id: "abcdef012345", name: "photo-1.jpg" }] }]);
  await phone.sync({ force: true, run: term.run, fetchFn: hub.fetchFn });
  const typed = term.sent()[0];
  const file = typed.match(/\[(?:dosya|file): ([^\]]+)\]/)?.[1];
  assert.ok(file && file.startsWith(path.join(home, "scratch")), typed);
  assert.equal(fs.readFileSync(file, "utf8"), "IMG");
});

test("/new opens a lead in the project and the next messages go to it", async () => {
  reset();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-proj-"));
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify([{ name: "shop-web", path: proj }]));
  const term = fakeTerm();
  await phone.hook("session", { cwd: home }, { env });
  assert.equal(await phone.apply({ kind: "new", project: "shop-web" }, { run: term.run }), "opened");
  const spawnCall = term.calls.find((c) => c.args.includes("spawn"));
  assert.ok(spawnCall.args.includes(proj));
  // the new lead starts in that folder: it becomes the target
  await phone.hook("session", { cwd: proj }, { env: { ...env, WEZTERM_PANE: "9" } });
  assert.equal(phone.readState().target, "wezterm-9");
  assert.equal(phone.pickLead(phone.liveLeads({ run: term.run })).id, "wezterm-9");
});

test("not a lead (a worker, a plain claude): the hooks do nothing", async () => {
  reset();
  await phone.hook("session", { cwd: home }, { env: { ...env, EKIP_RUN_DEPTH: "1" } });
  await phone.hook("session", { cwd: home }, { env: { ...env, EKIP_LEAD: "" } });
  assert.equal(phone.leads().length, 0);
});

test("the lead prompt mentions the phone only while one is linked", () => {
  phone.writeState({ linked: false });
  assert.equal(phone.leadPrompt(env), "");
  phone.writeState({ linked: true });
  assert.match(phone.leadPrompt(env), /phone/);
  assert.doesNotMatch(phone.leadPrompt(env), /phone listen/, "WezTerm can be typed into: no listener");
  assert.match(phone.leadPrompt({ ...env, WEZTERM_PANE: "", TERM_PROGRAM: "Apple_Terminal" }), /ekip phone listen/);
});

// the watcher: a launchd agent that keeps `ekip phone watch` running
{
  const { watcherPlist } = await import("./phone.js");
  const x = watcherPlist({ node: "/n", bin: "/b/ekip.js", log: "/l.log" });
  for (const s of ["<string>io.ekip.phone</string>", "<string>phone</string><string>watch</string>", "<key>KeepAlive</key><true/>", "<key>RunAtLoad</key><true/>"]) assert.ok(x.includes(s), s);
  console.log("phone watcher plist: ok");
}
