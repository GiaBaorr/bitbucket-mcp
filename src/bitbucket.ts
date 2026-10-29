import type { Config, WatchEntry } from "./config.js";

// Minimal shapes of the Bitbucket Data Center REST API objects we use.

export interface BbUser {
  name: string;
  displayName: string;
  emailAddress?: string;
  slug?: string;
}

export interface BbRepo {
  id?: number;
  slug: string;
  name: string;
  project: { key: string; name: string };
  archived?: boolean;
}

export interface BbParticipant {
  user: BbUser;
  role: "AUTHOR" | "REVIEWER" | "PARTICIPANT";
  approved: boolean;
  status: "UNAPPROVED" | "NEEDS_WORK" | "APPROVED";
}

export interface BbRef {
  displayId: string;
  latestCommit: string;
  repository: BbRepo;
}

export interface BbPullRequest {
  id: number;
  version: number;
  title: string;
  description?: string;
  state: "OPEN" | "MERGED" | "DECLINED";
  draft?: boolean;
  createdDate: number;
  updatedDate: number;
  fromRef: BbRef;
  toRef: BbRef;
  author: BbParticipant;
  reviewers: BbParticipant[];
  participants: BbParticipant[];
  properties?: { commentCount?: number; openTaskCount?: number; resolvedTaskCount?: number };
  links?: { self?: { href: string }[] };
}

export interface BbComment {
  id: number;
  text: string;
  author: BbUser;
  createdDate: number;
  updatedDate: number;
  state?: "OPEN" | "RESOLVED";
  severity?: "NORMAL" | "BLOCKER";
  threadResolved?: boolean;
  comments?: BbComment[];
}

export interface BbCommentAnchor {
  path?: string;
  line?: number;
  lineType?: string;
  fileType?: string;
}

export interface BbActivity {
  id: number;
  createdDate: number;
  user: BbUser;
  action: string;
  commentAction?: string;
  comment?: BbComment;
  commentAnchor?: BbCommentAnchor;
}

interface Page<T> {
  values: T[];
  isLastPage: boolean;
  nextPageStart?: number;
}

export class BitbucketError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class BitbucketClient {
  constructor(private readonly config: Config) {}

  private async request(
    path: string,
    query: Record<string, string | number | undefined> = {},
    accept = "application/json",
    init: { method?: string; body?: unknown } = {},
  ) {
    const url = new URL(this.config.baseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.token}`, Accept: accept };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) {
      let detail = await res.text();
      try {
        const body = JSON.parse(detail) as { errors?: { message: string }[] };
        detail = body.errors?.map((e) => e.message).join("; ") ?? detail;
      } catch {
        // non-JSON error body, keep the raw text
      }
      throw new BitbucketError(res.status, `Bitbucket ${res.status} on ${url.pathname}: ${detail.slice(0, 500)}`);
    }
    return res;
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    return (await (await this.request(path, query)).json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await (await this.request(path, {}, "application/json", { method: "POST", body })).json()) as T;
  }

  async getText(path: string, query: Record<string, string | number | undefined> = {}): Promise<string> {
    return (await this.request(path, query, "text/plain")).text();
  }

  /** Follows Bitbucket's start/limit paging until `max` items are collected or the last page is reached. */
  async getPaged<T>(path: string, query: Record<string, string | number | undefined> = {}, max = 1000): Promise<T[]> {
    const out: T[] = [];
    let start = 0;
    while (out.length < max) {
      const page = await this.get<Page<T>>(path, { ...query, start, limit: Math.min(100, max - out.length) });
      out.push(...page.values);
      if (page.isLastPage || page.nextPageStart === undefined) break;
      start = page.nextPageStart;
    }
    return out;
  }

  /** Username of the token's owner, from the X-AUSERNAME header Bitbucket sets on authenticated responses. */
  async whoami(): Promise<string | undefined> {
    const res = await this.request("/rest/api/latest/application-properties");
    return res.headers.get("x-ausername") ?? undefined;
  }

  repoPath(project: string, repo: string) {
    return `/rest/api/latest/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}`;
  }

  listProjectRepos(project: string) {
    return this.getPaged<BbRepo>(`/rest/api/latest/projects/${encodeURIComponent(project)}/repos`);
  }

  /** Expands watch entries into concrete repositories (whole projects become all their non-archived repos). */
  async resolveWatched(watch: WatchEntry[]): Promise<{ project: string; repo: string }[]> {
    const lists = await Promise.all(
      watch.map(async (w) =>
        w.repo
          ? [{ project: w.project, repo: w.repo }]
          : (await this.listProjectRepos(w.project)).filter((r) => !r.archived).map((r) => ({ project: w.project, repo: r.slug })),
      ),
    );
    const seen = new Set<string>();
    return lists.flat().filter((r) => {
      const key = `${r.project}/${r.repo}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  listPullRequests(project: string, repo: string, state: string, max: number) {
    return this.getPaged<BbPullRequest>(`${this.repoPath(project, repo)}/pull-requests`, { state, order: "NEWEST" }, max);
  }

  getPullRequest(project: string, repo: string, id: number) {
    return this.get<BbPullRequest>(`${this.repoPath(project, repo)}/pull-requests/${id}`);
  }

  getActivities(project: string, repo: string, id: number, max = 1000) {
    return this.getPaged<BbActivity>(`${this.repoPath(project, repo)}/pull-requests/${id}/activities`, {}, max);
  }

  getMergeStatus(project: string, repo: string, id: number) {
    return this.get<{ canMerge: boolean; conflicted: boolean; outcome?: string; vetoes: { summaryMessage: string }[] }>(
      `${this.repoPath(project, repo)}/pull-requests/${id}/merge`,
    );
  }

  getBuildStatuses(commit: string) {
    return this.getPaged<{ state: string; key: string; name?: string; url: string; dateAdded: number }>(
      `/rest/build-status/latest/commits/${commit}`,
      {},
      50,
    );
  }

  /** Raw unified diff of the PR (git-style), as shown in the Bitbucket UI. */
  getRawDiff(project: string, repo: string, id: number, contextLines = 3) {
    return this.getText(`${this.repoPath(project, repo)}/pull-requests/${id}.diff`, { contextLines });
  }

  /**
   * Adds a comment to a PR. `parentId` makes it a reply; `anchor` places it on a file (and optionally a line) in the diff;
   * severity BLOCKER turns it into a task.
   */
  addComment(
    project: string,
    repo: string,
    id: number,
    comment: {
      text: string;
      parentId?: number;
      anchor?: { path: string; line?: number; lineType?: "ADDED" | "REMOVED" | "CONTEXT"; fileType?: "FROM" | "TO" };
      severity?: "NORMAL" | "BLOCKER";
    },
  ) {
    const body: Record<string, unknown> = { text: comment.text };
    if (comment.parentId !== undefined) body.parent = { id: comment.parentId };
    if (comment.severity) body.severity = comment.severity;
    if (comment.anchor) body.anchor = { diffType: "EFFECTIVE", ...comment.anchor };
    return this.post<BbComment>(`${this.repoPath(project, repo)}/pull-requests/${id}/comments`, body);
  }

  getRepo(project: string, repo: string) {
    return this.get<BbRepo & { id: number }>(this.repoPath(project, repo));
  }

  /** The repo's default branch, e.g. { id: "refs/heads/main", displayId: "main" }. */
  async getDefaultBranch(project: string, repo: string) {
    try {
      return await this.get<{ id: string; displayId: string }>(`${this.repoPath(project, repo)}/default-branch`);
    } catch (e) {
      // Older Bitbucket versions only have the (now deprecated) branches/default endpoint
      if (e instanceof BitbucketError && e.status === 404) {
        return this.get<{ id: string; displayId: string }>(`${this.repoPath(project, repo)}/branches/default`);
      }
      throw e;
    }
  }

  findUsers(filter: string) {
    return this.getPaged<BbUser>("/rest/api/latest/users", { filter }, 25);
  }

  /** Reviewers that the repo's default-reviewer conditions would add for this source/target pair. */
  getDefaultReviewers(project: string, repo: string, repoId: number, fromRefId: string, toRefId: string) {
    return this.get<BbUser[]>(
      `/rest/default-reviewers/latest/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/reviewers`,
      { sourceRepoId: repoId, targetRepoId: repoId, sourceRefId: fromRefId, targetRefId: toRefId },
    );
  }

  createPullRequest(
    project: string,
    repo: string,
    pr: { title: string; description?: string; fromRefId: string; toRefId: string; reviewers: string[]; draft?: boolean },
  ) {
    const repository = { slug: repo, project: { key: project } };
    return this.post<BbPullRequest>(`${this.repoPath(project, repo)}/pull-requests`, {
      title: pr.title,
      description: pr.description,
      fromRef: { id: pr.fromRefId, repository },
      toRef: { id: pr.toRefId, repository },
      reviewers: pr.reviewers.map((name) => ({ user: { name } })),
      ...(pr.draft ? { draft: true } : {}),
    });
  }

  getChanges(project: string, repo: string, id: number) {
    return this.getPaged<{ path: { toString: string }; type: string; srcPath?: { toString: string } }>(
      `${this.repoPath(project, repo)}/pull-requests/${id}/changes`,
      {},
      1000,
    );
  }

  dashboardPullRequests(role: string | undefined, state: string, max: number) {
    return this.getPaged<BbPullRequest>("/rest/api/latest/dashboard/pull-requests", { role, state, order: "NEWEST" }, max);
  }
}

/** Runs `fn` over `items` with at most `limit` in flight, to avoid hammering the server. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
