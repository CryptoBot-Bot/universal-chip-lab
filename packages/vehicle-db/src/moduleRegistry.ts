import {
  ModuleProfile,
  ModuleProfileMap,
  VehicleBrand,
  validateModuleProfile,
} from "./moduleProfile.schema.js";
import { SEED_MODULES } from "./seedModules.js";

for (const m of SEED_MODULES) validateModuleProfile(m);

const profilesById: ModuleProfileMap = Object.fromEntries(
  SEED_MODULES.map((m) => [m.moduleProfileId, m]),
);

export interface ModuleRegistry {
  list(): ModuleProfile[];
  get(id: string): ModuleProfile | undefined;
  search(q: string): ModuleProfile[];
  byBrand(brand: VehicleBrand): ModuleProfile[];
  brands(): VehicleBrand[];
  register(profile: ModuleProfile): void;
}

class InMemoryModuleRegistry implements ModuleRegistry {
  private readonly profiles: ModuleProfileMap = { ...profilesById };

  list(): ModuleProfile[] {
    return Object.values(this.profiles).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }

  get(id: string): ModuleProfile | undefined {
    return this.profiles[id];
  }

  search(q: string): ModuleProfile[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return this.list();
    return this.list().filter((m) => {
      const haystack = [
        m.moduleProfileId,
        m.displayName,
        m.brand,
        m.manufacturer,
        m.ecuCode ?? "",
        m.partNumberPattern ?? "",
        m.mcu.family,
        ...(m.mcu.variants ?? []),
        ...m.applications,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }

  byBrand(brand: VehicleBrand): ModuleProfile[] {
    return this.list().filter((m) => m.brand === brand);
  }

  brands(): VehicleBrand[] {
    const set = new Set<VehicleBrand>();
    for (const m of this.list()) set.add(m.brand);
    return Array.from(set).sort();
  }

  register(profile: ModuleProfile): void {
    validateModuleProfile(profile);
    this.profiles[profile.moduleProfileId] = profile;
  }
}

export function createModuleRegistry(): ModuleRegistry {
  return new InMemoryModuleRegistry();
}

export { SEED_MODULES };
