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
  const tempDir = await mkdtemp(join(tmpdir(), "raven-ts-screenshot-"));
  const outputPath = join(tempDir, "screenshot.png");

  try {
    await captureToFile(outputPath, options.timeoutMs ?? 15000);
    const bytes = await readFile(outputPath);
    const dimensions = readPngDimensions(bytes);
    return { bytes, ...dimensions };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function captureToFile(outputPath: string, timeoutMs: number): Promise<void> {
  if (process.platform === "win32") {
    await captureWindows(outputPath, timeoutMs);
    return;
  }

  if (process.platform === "darwin") {
    await captureMacOS(outputPath, timeoutMs);
    return;
  }

  if (process.platform === "linux") {
    await captureLinux(outputPath, timeoutMs);
    return;
  }

  throw new Error(`Screenshot capture is not supported on ${process.platform}.`);
}

async function captureWindows(outputPath: string, timeoutMs: number): Promise<void> {
  const script = buildScreenshotScript();
  await execFileAsync(
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
      timeout: timeoutMs,
      windowsHide: true,
    }
  );
}

async function captureMacOS(outputPath: string, timeoutMs: number): Promise<void> {
  try {
    await execFileAsync("/usr/sbin/screencapture", ["-x", outputPath], {
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch (err) {
    throw new Error(
      `macOS screenshot failed. Grant Screen Recording permission to the terminal/service user if needed. ${formatExecError(
        err
      )}`
    );
  }
}

async function captureLinux(outputPath: string, timeoutMs: number): Promise<void> {
  const attempts: Array<{ command: string; args: string[]; hint: string }> = [
    { command: "grim", args: [outputPath], hint: "Wayland grim" },
    { command: "gnome-screenshot", args: ["-f", outputPath], hint: "GNOME Screenshot" },
    { command: "scrot", args: [outputPath], hint: "scrot" },
    { command: "import", args: ["-window", "root", outputPath], hint: "ImageMagick import" },
  ];
  const errors: string[] = [];

  for (const attempt of attempts) {
    try {
      await execFileAsync(attempt.command, attempt.args, {
        timeout: timeoutMs,
        windowsHide: true,
      });
      return;
    } catch (err) {
      errors.push(`${attempt.hint}: ${formatExecError(err)}`);
    }
  }

  throw new Error(
    [
      "Linux screenshot failed. Install one of: grim, gnome-screenshot, scrot, or ImageMagick.",
      "A graphical session is required; headless services usually cannot capture a desktop.",
      ...errors.map((error) => `- ${error}`),
    ].join("\n")
  );
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

function readPngDimensions(bytes: Buffer): { width?: number; height?: number } {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !pngSignature.every((byte, index) => bytes[index] === byte)) {
    return {};
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function formatExecError(err: unknown): string {
  if (!err || typeof err !== "object") {
    return String(err);
  }

  const record = err as {
    code?: unknown;
    signal?: unknown;
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  const parts = [
    typeof record.code === "string" || typeof record.code === "number" ? `code=${record.code}` : "",
    typeof record.signal === "string" ? `signal=${record.signal}` : "",
    typeof record.stderr === "string" && record.stderr.trim() ? record.stderr.trim() : "",
    typeof record.stdout === "string" && record.stdout.trim() ? record.stdout.trim() : "",
    typeof record.message === "string" ? record.message : "",
  ].filter(Boolean);

  return parts.join(" | ") || String(err);
}
