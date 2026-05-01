import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const patches = [
  {
    file: join("node_modules", "@openai", "codex-sdk", "dist", "index.js"),
    targets: [
      {
        before:
          "const child = spawn(this.executablePath, commandArgs, {\n      env,\n      signal: args.signal\n    });",
        after:
          "const child = spawn(this.executablePath, commandArgs, {\n      env,\n      signal: args.signal,\n      windowsHide: true\n    });",
      },
      {
        before:
          "const child = spawn(this.executablePath, commandArgs, {\r\n      env,\r\n      signal: args.signal\r\n    });",
        after:
          "const child = spawn(this.executablePath, commandArgs, {\r\n      env,\r\n      signal: args.signal,\r\n      windowsHide: true\r\n    });",
      },
    ],
  },
];

for (const patch of patches) {
  if (!existsSync(patch.file)) {
    continue;
  }

  let source = readFileSync(patch.file, "utf8");
  if (source.includes("windowsHide: true")) {
    continue;
  }

  let patched = false;
  for (const target of patch.targets) {
    if (source.includes(target.before)) {
      source = source.replace(target.before, target.after);
      patched = true;
      break;
    }
  }

  if (!patched) {
    throw new Error(`Unable to patch ${patch.file}`);
  }

  writeFileSync(patch.file, source);
  console.log(`Patched ${patch.file}`);
}
