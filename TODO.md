# Roadmap — Hardware adapter integration

MVP-1 ships only the `MockAdapter`. The following stubs already implement the `ProgrammerAdapter` interface but throw `NotImplementedError`. Promote them to real implementations in this order.

## Milestone 2 — First real adapter (target chip: 25LC256 training board)

* [ ] **FT232H adapter** (`packages/adapters/src/FtdiAdapter.ts`)
  * Use `node-ftdi` or shell out to `libftdi`/`pyftdi` until a native binding is chosen.
  * Implement `setVoltage`, `powerOn`, SPI `readMemory` for 25xxx EEPROM.
  * Pinout: ADBUS0=SCK, ADBUS1=MOSI, ADBUS2=MISO, ADBUS3=CS.
* [ ] **Bus Pirate adapter** (`BusPirateAdapter.ts`)
  * Serial protocol; menu mode then binary SPI mode.
  * Validate firmware version on `connect()`.

## Milestone 3 — flashrom wrapper

* [ ] `FlashromAdapter.ts` — spawn `flashrom` with the right `-p` programmer string per backing adapter.
* [ ] Parse identify / read / verify output.
* [ ] Surface erase as a write-class operation behind the Safety Engine gate.

## Milestone 4 — JTAG/SWD via OpenOCD

* [ ] `OpenOcdAdapter.ts` — spawn OpenOCD with a per-target config; talk to it over telnet/tcl.
* [ ] Add `jtag` and `swd` to the Protocol enum and the chip profile schema (TC1796, MPC555, SPC564, …).

## Milestone 5 — CH341A & Pi Pico

* [ ] `Ch341aAdapter.ts` — USB control transfers; flashrom can be the underlying backend on Windows.
* [ ] `PicoAdapter.ts` — custom firmware over USB-CDC; useful as a level-shifted, voltage-controlled programmer.

## Write workflow (gated)

* [ ] Implement `verifyMemory` in `MockAdapter` (round-trip checksum vs in-memory buffer).
* [ ] Wire the “Enable Write” unlock gate in `SafetyEngine` (requires verified backup + explicit confirmation + legal-use ack).
* [ ] UI: `OperationConsole` write panel currently disabled — enable only when `safety.canWrite === true`.

## Chip database

* [ ] Add curated profiles for 24C01–24C512, 25xx family (8K..1Mbit), 93Cxx family.
* [ ] Add SPI NOR Flash profiles (W25Q64, MX25L, etc.).
* [ ] Add automotive MCU profiles (TC1796, MPC555, SPC564, MAC7242) — JTAG/SWD only.

## Photo / OCR identification (Milestone 5)

* [ ] Photo capture panel — webcam or file drop.
* [ ] OCR pass to suggest a chip marking from the photo (no auto-fetch from the internet).
