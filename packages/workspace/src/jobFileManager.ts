import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceLayout } from "./workspaceManager.js";

export interface JobPaths {
  root: string;
  dumpsDir: string;
  logsDir: string;
  reportsDir: string;
  photosDir: string;
  jobFile: string;
  logFile: string;
  reportFile: string;
}

export class JobFileManager {
  constructor(private readonly layout: WorkspaceLayout) {}

  paths(jobId: string): JobPaths {
    const root = path.join(this.layout.jobsDir, jobId);
    return {
      root,
      dumpsDir: path.join(root, "dumps"),
      logsDir: path.join(root, "logs"),
      reportsDir: path.join(root, "reports"),
      photosDir: path.join(root, "photos"),
      jobFile: path.join(root, "job.json"),
      logFile: path.join(root, "logs", "operation.log"),
      reportFile: path.join(root, "reports", "report.json"),
    };
  }

  async ensureLayout(jobId: string): Promise<JobPaths> {
    const p = this.paths(jobId);
    for (const dir of [p.root, p.dumpsDir, p.logsDir, p.reportsDir, p.photosDir]) {
      await mkdir(dir, { recursive: true });
    }
    return p;
  }

  async writeJobRecord<T>(jobId: string, record: T): Promise<void> {
    const p = this.paths(jobId);
    await mkdir(p.root, { recursive: true });
    await writeFile(p.jobFile, JSON.stringify(record, null, 2), "utf8");
  }

  async readJobRecord<T>(jobId: string): Promise<T> {
    const p = this.paths(jobId);
    const raw = await readFile(p.jobFile, "utf8");
    return JSON.parse(raw) as T;
  }

  async listJobIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.layout.jobsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => b.localeCompare(a));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async writeDump(
    jobId: string,
    fileName: string,
    data: Buffer,
    { overwrite = false }: { overwrite?: boolean } = {},
  ): Promise<string> {
    const p = await this.ensureLayout(jobId);
    const target = path.join(p.dumpsDir, fileName);
    if (!overwrite) {
      try {
        await stat(target);
        throw new Error(
          `Dump file already exists and overwrite was not requested: ${target}`,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }
    await writeFile(target, data);
    return target;
  }

  async readDump(jobId: string, fileName: string): Promise<Buffer> {
    const p = this.paths(jobId);
    return readFile(path.join(p.dumpsDir, fileName));
  }

  async appendLog(jobId: string, line: string): Promise<void> {
    const p = await this.ensureLayout(jobId);
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    await appendFile(p.logFile, stamped, "utf8");
  }

  async writeReport(jobId: string, report: unknown): Promise<string> {
    const p = await this.ensureLayout(jobId);
    await writeFile(p.reportFile, JSON.stringify(report, null, 2), "utf8");
    return p.reportFile;
  }

  async writeNamedReport(
    jobId: string,
    fileName: string,
    report: unknown,
  ): Promise<string> {
    const p = await this.ensureLayout(jobId);
    const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const target = path.join(p.reportsDir, safe);
    await writeFile(target, JSON.stringify(report, null, 2), "utf8");
    return target;
  }
}
