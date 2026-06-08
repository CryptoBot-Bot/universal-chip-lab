# ECU Clone Lab / Universal Chip Lab

A local, offline desktop application that guides the operator through identifying, reading, verifying and backing up memory chips used in automotive modules (ECU, TCU, BCM, instrument clusters) and training boards.

> **Scope.** Lawful repair, recovery, backup, education and work on **owned or authorised modules** only. The application does **not** implement immobiliser bypass, key-cloning bypass, theft-related workflows or unauthorised security circumvention. MVP-1 is **read-only by default**; write paths exist as disabled UI with a safety warning and will not be enabled until verified-backup gates and consent confirmation are wired through the Safety Engine.

---

## MVP-1 — Guided EEPROM Lab

* Electron desktop shell, React + Vite + TypeScript frontend.
* `Mock Adapter` simulates 24LC256 / 25LC256 / 93C86 chips end-to-end — the full workflow runs without any hardware.
* Guided wizard: target → known facts → chip profile → adapter → wiring → safety check → operation.
* Read-twice → SHA-256 compare → verified-backup status.
* All-FF / all-00 / low-entropy dump detection.
* `report.json` generated per job, hex preview, full operation log.

## Tech stack

| Layer            | Choice                                                 |
| ---------------- | ------------------------------------------------------ |
| Desktop shell    | Electron                                               |
| Frontend         | React + Vite + TypeScript                              |
| Backend (in-app) | Node.js service layer via Electron main + preload IPC  |
| Storage          | Local filesystem workspace (`.runtime/`), JSON records |
| Hardware layer   | `ProgrammerAdapter` abstraction + Mock adapter         |
| Future adapters  | FT232H, Bus Pirate, CH341A, Pi Pico, flashrom, OpenOCD |

Node.js 24 LTS is the target runtime (Node 26 Current is intentionally avoided for stability).

## Project layout

```
ecu-clone-lab/
  apps/
    desktop/                 Electron + React app (UI + IPC entry points)
  packages/
    core/                    Job, Safety, Protocol, Verification, Report engines
    chip-db/                 Chip profile schema, registry, seeded JSON profiles
    adapters/                ProgrammerAdapter interface, MockAdapter, stubs
    dump-tools/              hash / entropy / compare / hex preview / patterns
    workspace/               Workspace + per-job filesystem manager
  workspace/                 (runtime, gitignored) jobs/ dumps/ logs/ reports/
```

## Setup

```powershell
# Prerequisites: Node.js 24 LTS, pnpm >= 9
node --version    # v24.x
pnpm --version    # >= 9

# Install workspace dependencies
pnpm install

# Type-check everything
pnpm typecheck

# Start the desktop app in dev mode (Vite + Electron)
pnpm dev
```

The first launch creates `.runtime/` (or `$ECL_WORKSPACE_ROOT`) and writes per-job folders under `.runtime/jobs/<jobId>/`. Runtime files are gitignored.

## Safety rules (enforced by the Safety Engine)

1. Read-only by default; write disabled in MVP-1.
2. Always read twice and compare before marking a backup verified.
3. Never overwrite an original dump.
4. Warn on all-FF or all-00 dumps.
5. Warn if chip voltage is unknown or out of range for the adapter.
6. Warn if the selected adapter does not support the chip protocol.
7. Persist a full operation log for every job.
8. Generate a `report.json` for every job.

## Roadmap

* **Milestone 1 (this repo, MVP-1):** Mock-adapter workflow, guided wiring, verified backup, hex preview, report. ✅
* **Milestone 2:** Real adapter integration — start with FT232H or Bus Pirate against a 25LC256 training chip.
* **Milestone 3:** flashrom wrapper for SPI NOR Flash.
* **Milestone 4:** OpenOCD wrapper for JTAG/SWD targets.
* **Milestone 5:** Photo capture for chip identification, manually curated chip database expansion.
* **Milestone 6:** Write workflow behind a verified-backup gate + explicit confirmation flow.

See `TODO.md` for the detailed adapter integration checklist.

## Licence / legal

Intended for personal use, training and authorised repair. The author makes no warranty; the operator is responsible for ensuring all work is lawful in their jurisdiction and authorised by the module owner.
