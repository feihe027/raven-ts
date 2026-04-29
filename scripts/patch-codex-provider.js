import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const files = [
  join("node_modules", "ai-sdk-provider-codex-app-server", "dist", "index.js"),
  join("node_modules", "ai-sdk-provider-codex-app-server", "dist", "index.cjs"),
];

const targets = [
  {
    before:
      'stdio: ["pipe", "pipe", "pipe"],\n      env: { ...process.env, ...this.settings.env },\n      cwd: this.settings.cwd\n    });',
    after:
      'stdio: ["pipe", "pipe", "pipe"],\n      env: { ...process.env, ...this.settings.env },\n      cwd: this.settings.cwd,\n      windowsHide: true\n    });',
  },
  {
    before:
      'stdio: ["pipe", "pipe", "pipe"],\r\n      env: { ...process.env, ...this.settings.env },\r\n      cwd: this.settings.cwd\r\n    });',
    after:
      'stdio: ["pipe", "pipe", "pipe"],\r\n      env: { ...process.env, ...this.settings.env },\r\n      cwd: this.settings.cwd,\r\n      windowsHide: true\r\n    });',
  },
];

for (const file of files) {
  if (!existsSync(file)) {
    continue;
  }

  let source = readFileSync(file, "utf8");
  if (source.includes("windowsHide: true")) {
    continue;
  }

  let patched = false;
  for (const target of targets) {
    if (source.includes(target.before)) {
      source = source.replace(target.before, target.after);
      patched = true;
      break;
    }
  }

  if (!patched) {
    throw new Error(`Unable to patch ${file}`);
  }

  writeFileSync(file, source);
  console.log(`Patched ${file}`);
}
