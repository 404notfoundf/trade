import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(projectRoot, "src");

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:test|check)\.ts$/i.test(entry.name)) files.push(path);
  }
  return files.sort();
}

const files = await sourceFiles(sourceRoot);
const tests = files.filter((path) => path.endsWith(".test.ts"));
const checks = files.filter((path) => path.endsWith(".check.ts"));
if (files.length === 0) {
  console.error("No offline test or check files were found under src/");
  process.exit(1);
}

const env = { ...process.env, DOTENV_CONFIG_PATH: join(tmpdir(), `trade-observer-${randomUUID()}.env`) };
for (const name of Object.keys(env)) {
  if (/^(?:OKX_|XLAYER_|SOLANA_|MYSQL_|RPC_|DATABASE_URL$)/i.test(name)) delete env[name];
}

function run(label, args) {
  console.log(`\n[offline] ${label}`);
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, env, stdio: "inherit" });
  if (result.error) {
    console.error(result.error);
    process.exit(result.status ?? 1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (tests.length > 0) run("node:test", ["--import", "tsx", "--test", ...tests]);
for (const file of checks) run(file.slice(projectRoot.length + 1), ["--import", "tsx", file]);
