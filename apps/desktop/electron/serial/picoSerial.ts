/**
 * Main-process serial bridge to the physical PicoForge device.
 *
 * Electron's renderer-side Web Serial silently fails to assert DTR/RTS, which
 * MicroPython requires before it will transmit — so we drive the port from the
 * main process via .NET's System.IO.Ports (through PowerShell), the exact path
 * proven to work on this machine. One PowerShell invocation per command: open
 * (DTR+RTS) → optional soft-reboot → write line → read until OK/ERR → close.
 * main.py keeps running across opens, so MODE state persists between commands.
 */
import { spawn } from "node:child_process";

// Allow '.'/'-' too so float args (e.g. "CAL 9.135") pass — serial, not shell.
const SAFE_COMMAND = /^[A-Za-z0-9 .\-]+$/;
const PORT_RE = /^COM\d+$/;

/** Finds the Pico's COM port by USB vendor id 2E8A (RP2040). */
export async function findPicoPort(): Promise<string | null> {
  const script =
    "Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.InstanceId -match 'VID_2E8A' } | " +
    "ForEach-Object { if ($_.FriendlyName -match '(COM\\d+)') { $matches[1] } }";
  const out = await runPowerShell(script, 8000);
  const m = out.match(/COM\d+/);
  return m ? m[0] : null;
}

/** Sends one command and returns the OK/ERR reply line. */
export async function picoCommand(
  port: string,
  command: string,
  reboot: boolean,
  timeoutMs = 8000,
): Promise<string> {
  if (!PORT_RE.test(port)) throw new Error(`Invalid port "${port}".`);
  if (!SAFE_COMMAND.test(command)) throw new Error(`Refusing unsafe command "${command}".`);

  const rebootBlock = reboot
    ? "$p.Write([char]3); Start-Sleep -Milliseconds 150; $p.Write([char]4); Start-Sleep -Milliseconds 1600; $p.ReadExisting() | Out-Null;"
    : "";

  const script = `
$ErrorActionPreference='Stop';
$p = New-Object System.IO.Ports.SerialPort('${port}',115200);
$p.ReadBufferSize=1048576; $p.DtrEnable=$true; $p.RtsEnable=$true; $p.ReadTimeout=200;
$p.Open();
${rebootBlock}
$p.DiscardInBuffer();
$p.WriteLine('${command}');
$d=(Get-Date).AddMilliseconds(${timeoutMs}); $b='';
while((Get-Date) -lt $d){ Start-Sleep -Milliseconds 8; $b += $p.ReadExisting(); if($b -match '(?m)^[ \\t]*(OK|ERR).*\\n'){ break } }
Write-Output $b;
$p.Close();
`;

  const out = await runPowerShell(script, timeoutMs + 4000);
  const line = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("OK") || l.startsWith("ERR"));
  if (!line) {
    throw new Error(`No reply from PicoForge on ${port} (is the firmware running / port free?).`);
  }
  return line;
}

function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Serial helper timed out."));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        reject(new Error(err.trim() || `Serial helper exited with code ${code}.`));
      } else {
        resolve(out);
      }
    });
  });
}
