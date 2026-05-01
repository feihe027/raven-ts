import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const sourceRoot = join(repoRoot, "skills");

const targets = [
  {
    label: "Claude",
    root: join(process.env.CLAUDE_HOME || join(homedir(), ".claude"), "skills"),
  },
  {
    label: "Codex",
    root: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills"),
  },
];

if (!existsSync(sourceRoot)) {
  process.exit(0);
}

const skillNames = readdirSync(sourceRoot).filter((name) => {
  const path = join(sourceRoot, name);
  return statSync(path).isDirectory() && existsSync(join(path, "SKILL.md"));
});

for (const target of targets) {
  mkdirSync(target.root, { recursive: true });

  for (const skillName of skillNames) {
    const source = join(sourceRoot, skillName);
    const destination = join(target.root, skillName);
    cpSync(source, destination, { recursive: true, force: true });
    console.log(`Installed raven-ts skill for ${target.label}: ${destination}`);
  }
}
