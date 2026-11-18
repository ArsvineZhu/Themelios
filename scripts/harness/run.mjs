import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const python = process.platform === "win32" ? "python" : "python3";
const result = spawnSync(
  python,
  ["-B", join(scriptDir, "manage.py"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
