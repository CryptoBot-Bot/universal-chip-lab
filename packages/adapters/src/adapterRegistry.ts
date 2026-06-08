import { BusPirateAdapter } from "./BusPirateAdapter.js";
import { Ch341aAdapter } from "./Ch341aAdapter.js";
import { FlashromAdapter } from "./FlashromAdapter.js";
import { FtdiAdapter } from "./FtdiAdapter.js";
import { MockAdapter } from "./MockAdapter.js";
import { OpenOcdAdapter } from "./OpenOcdAdapter.stub.js";
import { PicoAdapter } from "./PicoAdapter.stub.js";
import type { ProgrammerAdapter } from "./ProgrammerAdapter.js";

export interface AdapterRegistry {
  list(): ProgrammerAdapter[];
  get(adapterId: string): ProgrammerAdapter | undefined;
}

class StatefulAdapterRegistry implements AdapterRegistry {
  private readonly adapters = new Map<string, ProgrammerAdapter>();

  constructor(adapters: ProgrammerAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.adapterId, adapter);
    }
  }

  list(): ProgrammerAdapter[] {
    return Array.from(this.adapters.values()).sort((a, b) => {
      if (a.adapterId === "mock_adapter") return -1;
      if (b.adapterId === "mock_adapter") return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  get(adapterId: string): ProgrammerAdapter | undefined {
    return this.adapters.get(adapterId);
  }
}

export function createAdapterRegistry(): AdapterRegistry {
  return new StatefulAdapterRegistry([
    new MockAdapter(),
    new Ch341aAdapter(),
    new FtdiAdapter(),
    new BusPirateAdapter(),
    new FlashromAdapter(),
    new PicoAdapter(),
    new OpenOcdAdapter(),
  ]);
}
