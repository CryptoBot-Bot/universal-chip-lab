/**
 * Persistent serial session to PicoForge.
 *
 * The per-command approach (picoSerial.ts) spawns a fresh PowerShell — and pays
 * its ~0.3 s open/close overhead — on EVERY command, which makes MB-scale reads
 * crawl. This keeps ONE long-running PowerShell relay that holds the port open
 * (DTR+RTS) and relays commands over stdin/stdout, so each command is just a
 * fast in-process round-trip. Replies are framed with a marker and matched FIFO
 * (one command in flight at a time).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "<<<PFR>>>";
const SAFE_COMMAND = /^[A-Za-z0-9 ]+$/;
const PORT_RE = /^COM\d+$/;

// Relay script: opens the port, soft-reboots main.py once, then loops reading
// commands from stdin and emitting marker-framed replies on stdout.
const RELAY_SCRIPT = `param([string]$Port)
$ErrorActionPreference='Stop'
$p = New-Object System.IO.Ports.SerialPort($Port,115200)
$p.ReadBufferSize=1048576
$p.DtrEnable=$true; $p.RtsEnable=$true; $p.ReadTimeout=200
$p.Open()
$p.Write([char]3); Start-Sleep -Milliseconds 150; $p.Write([char]4); Start-Sleep -Milliseconds 1600
$p.DiscardInBuffer()
[Console]::Out.WriteLine('${MARKER}OK session-ready')
[Console]::Out.Flush()
while($true){
  $cmd = [Console]::In.ReadLine()
  if($null -eq $cmd){ break }
  if($cmd -eq '__QUIT__'){ break }
  $to = 5000
  if($cmd -like 'READ*' -or $cmd -like 'WRITE*'){ $to = 20000 }
  if($cmd -like 'ERASE*'){ $to = 130000 }
  $p.DiscardInBuffer()
  $p.WriteLine($cmd)
  $d=(Get-Date).AddMilliseconds($to); $b=''
  while((Get-Date) -lt $d){
    Start-Sleep -Milliseconds 6
    $b += $p.ReadExisting()
    if($b -match '(?m)^[ \\t]*(OK|ERR).*\\n'){ break }
  }
  $line = ([regex]::Split($b, '\\n') | ForEach-Object { $_.Trim() } | Where-Object { $_ -like 'OK*' -or $_ -like 'ERR*' } | Select-Object -First 1)
  if($null -eq $line){ $line = 'ERR no-reply' }
  [Console]::Out.WriteLine('${MARKER}' + $line)
  [Console]::Out.Flush()
}
try { $p.Close() } catch {}
`;

let relayScriptPath: string | null = null;
function ensureRelayScript(): string {
  if (!relayScriptPath) {
    relayScriptPath = path.join(os.tmpdir(), "picoforge-relay.ps1");
    writeFileSync(relayScriptPath, RELAY_SCRIPT, "utf8");
  }
  return relayScriptPath;
}

interface Pending {
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class PicoSession {
  private child: ChildProcess | null = null;
  private outBuf = "";
  private pending: Pending | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private ready = false;
  private readyResolve: (() => void) | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  onClosed: (() => void) | null = null;

  constructor(private readonly port: string) {}

  async start(): Promise<void> {
    const scriptPath = ensureRelayScript();
    this.child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, this.port],
      { windowsHide: true },
    );
    this.child.stdout?.on("data", (d) => this.onStdout(d.toString()));
    this.child.stderr?.on("data", () => undefined);
    this.child.on("exit", () => this.handleExit());

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("PicoForge session failed to start (no ready signal).")), 14000);
      this.readyResolve = () => { clearTimeout(t); resolve(); };
    });
    this.bumpIdle();
  }

  private onStdout(chunk: string) {
    this.outBuf += chunk;
    let idx: number;
    while ((idx = this.outBuf.indexOf("\n")) >= 0) {
      const line = this.outBuf.slice(0, idx).replace(/\r$/, "");
      this.outBuf = this.outBuf.slice(idx + 1);
      if (!line.startsWith(MARKER)) continue;
      const reply = line.slice(MARKER.length).trim();
      if (!this.ready) {
        this.ready = true;
        this.readyResolve?.();
        continue;
      }
      const p = this.pending;
      this.pending = null;
      if (p) {
        clearTimeout(p.timer);
        p.resolve(reply);
      }
    }
  }

  /** Queues a command (one in flight at a time) and resolves with the reply. */
  command(cmd: string, timeoutMs = 24000): Promise<string> {
    const run = () =>
      new Promise<string>((resolve, reject) => {
        if (!this.child) {
          reject(new Error("PicoForge session is not running."));
          return;
        }
        const timer = setTimeout(() => {
          if (this.pending) {
            this.pending = null;
            reject(new Error(`PicoForge timed out on "${cmd}".`));
          }
        }, timeoutMs);
        this.pending = { resolve, reject, timer };
        this.child.stdin?.write(cmd + "\n");
        this.bumpIdle();
      });
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), 180_000); // auto-free the port after 3 min idle
  }

  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.child) {
      try { this.child.stdin?.write("__QUIT__\n"); } catch { /* ignore */ }
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
  }

  private handleExit() {
    this.child = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("PicoForge session ended unexpectedly."));
      this.pending = null;
    }
    this.onClosed?.();
  }
}

const sessions = new Map<string, PicoSession>();

/** Runs a command via a persistent session (reboot=true restarts it cleanly). */
export async function picoSessionCommand(
  port: string,
  command: string,
  reboot: boolean,
  timeoutMs = 24000,
): Promise<string> {
  if (!PORT_RE.test(port)) throw new Error(`Invalid port "${port}".`);
  if (!SAFE_COMMAND.test(command)) throw new Error(`Refusing unsafe command "${command}".`);

  if (reboot) {
    sessions.get(port)?.stop();
    sessions.delete(port);
  }
  let session = sessions.get(port);
  if (!session) {
    const s = new PicoSession(port);
    s.onClosed = () => { if (sessions.get(port) === s) sessions.delete(port); };
    sessions.set(port, s);
    await s.start();
    session = s;
  }
  return session.command(command, timeoutMs);
}

export function stopPicoSession(port: string): void {
  sessions.get(port)?.stop();
  sessions.delete(port);
}

export function stopAllPicoSessions(): void {
  for (const s of sessions.values()) s.stop();
  sessions.clear();
}
