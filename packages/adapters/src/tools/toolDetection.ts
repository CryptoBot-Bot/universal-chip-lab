import { spawn } from "node:child_process";

export type ExternalTool = "flashrom" | "openocd" | "ch341eepromtool" | "pyftdi";

export interface ToolStatus {
  tool: ExternalTool;
  installed: boolean;
  version?: string;
  /** Path/error/help text for the user. */
  detail: string;
}

const VERSION_FLAGS: Record<ExternalTool, string[]> = {
  flashrom: ["--version"],
  openocd: ["--version"],
  ch341eepromtool: ["-h"],          // no --version, help text exists
  pyftdi: ["-m", "pyftdi.bin.pyterm", "--help"], // crude but works
};

const INSTALL_HINTS: Record<ExternalTool, string> = {
  flashrom:
    "Install flashrom. Windows: download official build from flashrom.org or use Chocolatey (`choco install flashrom`). Linux: `sudo apt install flashrom` / `sudo pacman -S flashrom`. macOS: `brew install flashrom`.",
  openocd:
    "Install OpenOCD. Windows: download from https://gnutoolchains.com/arm-eabi/openocd/ or `choco install openocd`. Linux: `sudo apt install openocd`. macOS: `brew install openocd`.",
  ch341eepromtool:
    "Install ch341eepromtool (Linux/macOS). Source: https://github.com/commandtab/ch341eeprom — `git clone && make`. Required only for I2C EEPROM reads via the CH341A.",
  pyftdi:
    "Install Python + pyftdi: `pip install pyftdi`. Required only for I2C / advanced FT232H workflows when flashrom alone is insufficient.",
};

export async function detectTool(tool: ExternalTool): Promise<ToolStatus> {
  const args = VERSION_FLAGS[tool];
  return new Promise((resolve) => {
    const child = spawn(tool === "pyftdi" ? "python" : tool, tool === "pyftdi" ? args : args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let resolved = false;
    const finalise = (installed: boolean, detail: string) => {
      if (resolved) return;
      resolved = true;
      resolve({ tool, installed, ...(installed ? { version: extractVersion(stdout + stderr) } : {}), detail });
    };

    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", () => finalise(false, INSTALL_HINTS[tool]));
    child.on("close", (code) => {
      if (code === 0 || code === 1) finalise(true, `Detected. ${INSTALL_HINTS[tool]}`);
      else finalise(false, INSTALL_HINTS[tool]);
    });

    // Hard timeout — some installers leave broken shims that hang forever.
    setTimeout(() => {
      child.kill();
      finalise(false, INSTALL_HINTS[tool]);
    }, 5000);
  });
}

export async function detectAll(): Promise<ToolStatus[]> {
  const tools: ExternalTool[] = ["flashrom", "openocd", "ch341eepromtool", "pyftdi"];
  return Promise.all(tools.map(detectTool));
}

function extractVersion(text: string): string | undefined {
  const m = text.match(/(\d+\.\d+(?:\.\d+)?(?:[-\w.]+)?)/);
  return m ? m[1] : undefined;
}
