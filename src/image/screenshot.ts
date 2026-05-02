import { execFile } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ScreenshotResult {
  bytes: Buffer;
  width?: number;
  height?: number;
}

export async function captureDesktopScreenshot(
  options: { timeoutMs?: number } = {}
): Promise<ScreenshotResult> {
  if (process.platform !== "win32") {
    throw new Error("Screenshot capture is currently implemented for Windows only.");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "raven-ts-screenshot-"));
  const outputPath = join(tempDir, "screenshot.png");

  try {
    const script = buildScreenshotScript();
    const { stdout } = await execFileAsync(
      getPowerShellPath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: {
          ...process.env,
          RAVEN_TS_SCREENSHOT_PATH: outputPath,
        },
        timeout: options.timeoutMs ?? 15000,
        windowsHide: true,
      }
    );

    const bytes = await readFile(outputPath);
    const dimensions = parseDimensions(stdout);
    return { bytes, ...dimensions };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildScreenshotScript(): string {
  return `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$path = $env:RAVEN_TS_SCREENSHOT_PATH
if ([string]::IsNullOrWhiteSpace($path)) {
  throw "RAVEN_TS_SCREENSHOT_PATH is not set"
}

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
  throw "No screen bounds available"
}

$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("{0}x{1}" -f $bounds.Width, $bounds.Height)
}
finally {
  if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }
}
`;
}

function getPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function parseDimensions(stdout: string): { width?: number; height?: number } {
  const match = /(\d+)x(\d+)/.exec(stdout);
  if (!match) {
    return {};
  }
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

