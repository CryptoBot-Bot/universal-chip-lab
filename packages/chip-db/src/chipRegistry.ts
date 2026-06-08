import { CATALOG_PROFILES } from "./catalog.js";
import { ChipProfile, ChipProfileMap, validateChipProfile } from "./chipProfile.schema.js";

import profile24lc256 from "./seedProfiles/24lc256.json";
import profile25lc256 from "./seedProfiles/25lc256.json";
import profile93c86 from "./seedProfiles/93c86.json";

const SEED_PROFILES: ChipProfile[] = [
  profile24lc256 as ChipProfile,
  profile25lc256 as ChipProfile,
  profile93c86 as ChipProfile,
  ...CATALOG_PROFILES,
];

for (const profile of SEED_PROFILES) {
  validateChipProfile(profile);
}

// Build map; later profiles override earlier ones (so factory-generated
// duplicates can be replaced by an explicit seed JSON if needed).
const profilesById: ChipProfileMap = {};
for (const p of SEED_PROFILES) {
  profilesById[p.chipProfileId] = p;
}

export interface ChipRegistry {
  list(): ChipProfile[];
  get(id: string): ChipProfile | undefined;
  search(query: string): ChipProfile[];
  register(profile: ChipProfile): void;
  unregister(id: string): boolean;
  byFamily(family: ChipProfile["family"]): ChipProfile[];
  families(): ChipProfile["family"][];
}

class InMemoryChipRegistry implements ChipRegistry {
  private readonly profiles: ChipProfileMap = { ...profilesById };

  list(): ChipProfile[] {
    return Object.values(this.profiles).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }

  get(id: string): ChipProfile | undefined {
    return this.profiles[id];
  }

  search(query: string): ChipProfile[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter((p) => {
      const haystack = [
        p.chipProfileId,
        p.displayName,
        p.manufacturer ?? "",
        p.family,
        p.protocol,
        p.package,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  register(profile: ChipProfile): void {
    validateChipProfile(profile);
    this.profiles[profile.chipProfileId] = profile;
  }

  unregister(id: string): boolean {
    if (!(id in this.profiles)) return false;
    delete this.profiles[id];
    return true;
  }

  byFamily(family: ChipProfile["family"]): ChipProfile[] {
    return this.list().filter((p) => p.family === family);
  }

  families(): ChipProfile["family"][] {
    const set = new Set<ChipProfile["family"]>();
    for (const p of this.list()) set.add(p.family);
    return Array.from(set).sort();
  }
}

export function createChipRegistry(): ChipRegistry {
  return new InMemoryChipRegistry();
}

export const seedChipProfiles: ReadonlyArray<ChipProfile> = SEED_PROFILES;
