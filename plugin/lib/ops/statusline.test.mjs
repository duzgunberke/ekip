import test from "node:test";
import assert from "node:assert/strict";
import { taskPaneOpen } from "./statusline.js";

test("taskPaneOpen: hides the line only when the lead's tab shows the task pane", async () => {
  assert.equal(await taskPaneOpen({ term: { findTaskPane: () => "7" } }), true);
  assert.equal(await taskPaneOpen({ term: { findTaskPane: () => "" } }), false);
  // could not ask (slow or failed answer): keep the line
  assert.equal(await taskPaneOpen({ term: { findTaskPane: () => null } }), false);
  assert.equal(await taskPaneOpen({ term: { findTaskPane: () => { throw new Error("x"); } } }), false);
  // a plain terminal without panes keeps the line
  assert.equal(await taskPaneOpen({ env: {} }), false);
});
