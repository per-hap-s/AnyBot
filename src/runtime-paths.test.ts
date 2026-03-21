import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";

import { getDataDir, getRuntimeRoot, isNodeTestProcess } from "./runtime-paths.js";

test("isNodeTestProcess recognizes node:test argv flags", () => {
  assert.equal(isNodeTestProcess(["--import=tsx"]), false);
  assert.equal(isNodeTestProcess(["--test"]), true);
  assert.equal(isNodeTestProcess(["--test-isolation=process"]), true);
});

test("getRuntimeRoot isolates node:test runs into a temp runtime root", () => {
  const runtimeRoot = getRuntimeRoot("D:\\CodexProjects\\AnyBot", {
    env: {},
    execArgv: ["--test-isolation=process"],
    pid: 1234,
  });

  assert.equal(
    runtimeRoot,
    path.resolve(path.join(tmpdir(), "anybot-node-test", "AnyBot", "pid-1234")),
  );
});

test("getDataDir still prefers explicit environment overrides", () => {
  const dataDir = getDataDir("D:\\CodexProjects\\AnyBot", {
    env: {
      DATA_DIR: "D:\\custom-data",
    },
    execArgv: ["--test-isolation=process"],
    pid: 1234,
  });

  assert.equal(dataDir, path.resolve("D:\\custom-data"));
});
