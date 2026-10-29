import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A watch entry: a whole project ("PROJ") or a single repository ("PROJ/repo"). */
export interface WatchEntry {
  project: string;
  repo?: string;
}

export interface Config {
  baseUrl: string;
  token: string;
  watch: WatchEntry[];
  /** When true, tools that post to Bitbucket (comments, replies) are not registered. */
  readOnly: boolean;
}

interface ConfigFile {
  baseUrl?: string;
  token?: string;
  watch?: string[];
  readOnly?: boolean;
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "bitbucket-mcp", "config.json");

export function parseWatchEntry(raw: string): WatchEntry {
  const [project, repo] = raw.trim().split("/", 2);
  if (!project) throw new Error(`Invalid watch entry: "${raw}"`);
  return repo ? { project: project.toUpperCase(), repo } : { project: project.toUpperCase() };
}

/**
 * Loads config from an optional JSON file, with environment variables taking precedence:
 *   BITBUCKET_URL, BITBUCKET_TOKEN, BITBUCKET_WATCH ("PROJ,PROJ2/repo"), BITBUCKET_READ_ONLY ("true"/"false"),
 *   BITBUCKET_MCP_CONFIG (file path).
 */
export function loadConfig(): Config {
  const path = process.env.BITBUCKET_MCP_CONFIG ?? DEFAULT_CONFIG_PATH;
  let file: ConfigFile = {};
  if (existsSync(path)) {
    file = JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
  } else if (process.env.BITBUCKET_MCP_CONFIG) {
    throw new Error(`Config file not found: ${path}`);
  }

  const baseUrl = (process.env.BITBUCKET_URL ?? file.baseUrl ?? "").replace(/\/+$/, "");
  const token = process.env.BITBUCKET_TOKEN ?? file.token ?? "";
  const watchRaw = process.env.BITBUCKET_WATCH
    ? process.env.BITBUCKET_WATCH.split(",").filter((s) => s.trim())
    : (file.watch ?? []);

  if (!baseUrl) throw new Error("Missing Bitbucket URL: set BITBUCKET_URL or baseUrl in " + path);
  if (!token) throw new Error("Missing HTTP access token: set BITBUCKET_TOKEN or token in " + path);

  const readOnly = process.env.BITBUCKET_READ_ONLY ? process.env.BITBUCKET_READ_ONLY === "true" : (file.readOnly ?? false);

  return { baseUrl, token, watch: watchRaw.map(parseWatchEntry), readOnly };
}
