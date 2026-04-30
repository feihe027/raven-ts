import { closeSync, existsSync, openSync, readFileSync, statSync, watch } from "fs";
import chalk from "chalk";
import { ensureRuntimeDir, getErrorLogPath, getLogPath } from "../daemon/paths.js";

export async function logsCommand(options: { follow: boolean }): Promise<void> {
  const logFile = getLogPath();
  const errorLogFile = getErrorLogPath();

  if (options.follow) {
    console.log(chalk.cyan("Following logs (Ctrl+C to stop)...\n"));
    followFile(logFile);
    followFile(errorLogFile);
    await new Promise(() => {});
  } else {
    // Show last 100 lines
    console.log(chalk.cyan("Recent logs:\n"));
    console.log(readLastLines(logFile, 100));
    console.log();
    console.log(chalk.dim(`Log file: ${logFile}`));
    console.log(chalk.dim(`Error log: ${errorLogFile}`));
  }
}

function readLastLines(filePath: string, lineCount: number): string {
  if (!existsSync(filePath)) {
    return chalk.dim(`Log file does not exist yet: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");
  return content.split(/\r?\n/).slice(-lineCount).join("\n");
}

function followFile(filePath: string): void {
  if (!existsSync(filePath)) {
    ensureRuntimeDir();
    closeSync(openSync(filePath, "a"));
  }

  let position = statSync(filePath).size;
  const watcher = watch(filePath, () => {
    const content = readFileSync(filePath, "utf-8");
    if (content.length <= position) {
      position = content.length;
      return;
    }

    process.stdout.write(content.slice(position));
    position = content.length;
  });

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}
