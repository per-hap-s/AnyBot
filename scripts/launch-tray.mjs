import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forwardedArgs = process.argv.slice(2);

const child = spawn(electronPath, [appRoot, ...forwardedArgs], {
  cwd: appRoot,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});

child.unref();
