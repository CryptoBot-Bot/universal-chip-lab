import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

import { Api } from "./api";
import { Pico } from "./picoforge";

type Status = "idle" | "connecting" | "connected" | "error";

interface PicoConnection {
  port: string | null;
  status: Status;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const Ctx = createContext<PicoConnection | null>(null);

/** One shared PicoForge connection for the whole app (Read + Write share it). */
export function PicoProvider({ children }: { children: ReactNode }) {
  const [port, setPort] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

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

  return <Ctx.Provider value={{ port, status, error, connect, disconnect }}>{children}</Ctx.Provider>;
}

export function usePico(): PicoConnection {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePico must be used within <PicoProvider>");
  return ctx;
}
