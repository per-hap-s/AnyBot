import { execFileSync } from "node:child_process";
import path from "node:path";

if (process.platform !== "win32") {
  console.log("Skipping electron-builder install-app-deps on non-Windows.");
  process.exit(0);
}

const binPath = path.join(process.cwd(), "node_modules", ".bin", "electron-builder.cmd");
execFileSync(binPath, ["install-app-deps"], {
  cwd: process.cwd(),
  stdio: "inherit",
});
