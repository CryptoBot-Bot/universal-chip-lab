import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceLayout {
  root: string;
  jobsDir: string;
  dumpsDir: string;
  logsDir: string;
  reportsDir: string;
  photosDir: string;
  chipDbDir: string;
}

const SUBDIRS = ["jobs", "dumps", "logs", "reports", "photos", "chip-db"] as const;

/**
 * Resolves the workspace root from (in order of precedence):
 *   1. explicit `rootOverride`
 *   2. `ECL_WORKSPACE_ROOT` env var
 *   3. `<projectRoot>/.runtime`
 */
export function resolveWorkspaceRoot(
  projectRoot: string,
  rootOverride?: string,
): string {
  if (rootOverride && rootOverride.trim().length > 0) {
    return path.resolve(rootOverride);
  }
  const fromEnv = process.env.ECL_WORKSPACE_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv);
  }
  return path.resolve(projectRoot, ".runtime");
}

export async function ensureWorkspaceLayout(root: string): Promise<WorkspaceLayout> {
  await mkdir(root, { recursive: true });
  for (const sub of SUBDIRS) {
    await mkdir(path.join(root, sub), { recursive: true });
  }
  return {
    root,
    jobsDir: path.join(root, "jobs"),
    dumpsDir: path.join(root, "dumps"),
    logsDir: path.join(root, "logs"),
    reportsDir: path.join(root, "reports"),
    photosDir: path.join(root, "photos"),
    chipDbDir: path.join(root, "chip-db"),
  };
}

export class WorkspaceManager {
  private layout: WorkspaceLayout | null = null;

  constructor(private readonly projectRoot: string) {}

  async init(rootOverride?: string): Promise<WorkspaceLayout> {
    const root = resolveWorkspaceRoot(this.projectRoot, rootOverride);
    this.layout = await ensureWorkspaceLayout(root);
    return this.layout;
  }

  getLayout(): WorkspaceLayout {
    if (!this.layout) {
      throw new Error("Workspace has not been initialised. Call init() first.");
    }
    return this.layout;
  }
}
