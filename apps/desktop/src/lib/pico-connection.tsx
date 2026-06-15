import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

import { DEFAULT_SPI_CLOCK_HZ } from "@ecu/chip-db";

import { Api } from "./api";
import { Pico } from "./picoforge";

type Status = "idle" | "connecting" | "connected" | "error";

const CLOCK_KEY = "pf.spiClockHz";

interface PicoConnection {
  port: string | null;
  status: Status;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  /**
   * Operator SPI-clock override (Hz), shared by Read + Write and persisted.
   * `null` means "use the chip's rated default". Applies to SPI modes only.
   */
  spiClockHz: number | null;
  setSpiClockHz: (hz: number | null) => void;
}

const Ctx = createContext<PicoConnection | null>(null);

function loadClock(): number | null {
  try {
    const raw = localStorage.getItem(CLOCK_KEY);
    if (raw === null) return DEFAULT_SPI_CLOCK_HZ; // sensible no-regression default
    if (raw === "auto") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_SPI_CLOCK_HZ;
  } catch {
    return DEFAULT_SPI_CLOCK_HZ;
  }
}

/** One shared PicoForge connection for the whole app (Read + Write share it). */
export function PicoProvider({ children }: { children: ReactNode }) {
  const [port, setPort] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [spiClockHz, setSpiClockHzState] = useState<number | null>(loadClock);

  const setSpiClockHz = useCallback((hz: number | null) => {
    setSpiClockHzState(hz);
    try {
      localStorage.setItem(CLOCK_KEY, hz === null ? "auto" : String(Math.round(hz)));
    } catch {
      /* ignore quota/availability */
    }
  }, []);

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    try {
      const found = await Pico.findPort();
      if (!found) {
        throw new Error("No PicoForge found. Plug it in, close Thonny, and check Device Manager.");
      }
      await Pico.command(found, "PING", true); // starts the session + reboots main.py
      setPort(found);
      setStatus("connected");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }, []);

  const disconnect = useCallback(() => {
    if (port) Api.pico.disconnect(port).catch(() => undefined);
    setPort(null);
    setStatus("idle");
  }, [port]);

  return (
    <Ctx.Provider value={{ port, status, error, connect, disconnect, spiClockHz, setSpiClockHz }}>
      {children}
    </Ctx.Provider>
  );
}

export function usePico(): PicoConnection {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePico must be used within <PicoProvider>");
  return ctx;
}
