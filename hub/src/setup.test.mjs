import { test } from "node:test";
import assert from "node:assert/strict";
import { hubSetup } from "./setup.js";

test("a bare hub misses its CI folder, commit, free pool and memory", () => {
  const s = hubSetup({ ciDir: "/data/ci" }, { exists: () => false });
  assert.deepEqual(s.map((x) => [x.id, x.done]), [["hub-ci", false], ["hub-commit", false], ["hub-free", false], ["hub-memory", false]]);
  for (const x of s) assert.ok(x.title && x.why && x.command);
});

test("a configured hub is complete", () => {
  const s = hubSetup({ ciDir: "/data/ci", commit: "abc1234", freellmapiUrl: "http://free:3001", freellmapiKey: "k", tdaiUrl: "http://tdai", tdaiUserKey: "u" }, { exists: (f) => f === "/data/ci/result.json" });
  assert.ok(s.every((x) => x.done));
});
