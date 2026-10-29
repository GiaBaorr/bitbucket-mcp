#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { BitbucketClient, mapLimit, type BbActivity, type BbComment, type BbPullRequest } from "./bitbucket.js";

const config = loadConfig();
const bb = new BitbucketClient(config);

const server = new McpServer({ name: "bitbucket", version: "0.1.0" });

// ---------- helpers ----------

const fmtDate = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";

/** Accepts an ISO date/time or a relative duration like "30m", "24h", "3d", "2w". Returns epoch ms. */
function parseSince(since: string): number {
  const rel = /^(\d+)\s*([mhdw])$/i.exec(since.trim());
  if (rel) {
    const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[rel[2].toLowerCase() as "m" | "h" | "d" | "w"];
    return Date.now() - Number(rel[1]) * unit;
  }
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error(`Cannot parse time "${since}". Use ISO (2026-10-28T09:00) or relative (24h, 3d).`);
  return t;
}

function prUrl(pr: BbPullRequest) {
  return (
    pr.links?.self?.[0]?.href ??
    `${config.baseUrl}/projects/${pr.toRef.repository.project.key}/repos/${pr.toRef.repository.slug}/pull-requests/${pr.id}`
  );
}

function summarizePr(pr: BbPullRequest) {
  return {
    project: pr.toRef.repository.project.key,
    repo: pr.toRef.repository.slug,
    id: pr.id,
    title: pr.title,
    state: pr.state,
    draft: pr.draft || undefined,
    author: pr.author.user.displayName,
    branch: `${pr.fromRef.displayId} -> ${pr.toRef.displayId}`,
    created: fmtDate(pr.createdDate),
    updated: fmtDate(pr.updatedDate),
    reviewers: pr.reviewers.map((r) => `${r.user.displayName}: ${r.status}`),
    comments: pr.properties?.commentCount ?? 0,
    openTasks: pr.properties?.openTaskCount ?? 0,
    url: prUrl(pr),
  };
}

const matchesUser = (u: { name: string; displayName: string; emailAddress?: string }, q: string) => {
  const s = q.toLowerCase();
  return [u.name, u.displayName, u.emailAddress].some((v) => v?.toLowerCase().includes(s));
};

/** Repos to look at: an explicit project/repo if given, otherwise the configured watch list. */
async function scopeRepos(project?: string, repo?: string) {
  if (project && repo) return [{ project: project.toUpperCase(), repo }];
  if (project) return bb.resolveWatched([{ project: project.toUpperCase() }]);
  if (repo) {
    const repos = await bb.resolveWatched(config.watch);
    const hits = repos.filter((r) => r.repo === repo);
    if (!hits.length) throw new Error(`Repo "${repo}" is not in the watch list; pass project as well.`);
    return hits;
  }
  if (!config.watch.length) throw new Error("No watch list configured; pass project (and optionally repo).");
  return bb.resolveWatched(config.watch);
}

const PR_URL_RE = /\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/;

const prRefShape = {
  url: z.string().optional().describe("Pull request URL from the Bitbucket UI. Alternative to project/repo/id."),
  project: z.string().optional().describe("Project key, e.g. PROJ"),
  repo: z.string().optional().describe("Repository slug"),
  id: z.number().int().optional().describe("Pull request id"),
};

function resolvePrRef(a: { url?: string; project?: string; repo?: string; id?: number }) {
  if (a.url) {
    const m = PR_URL_RE.exec(a.url);
    if (!m) throw new Error(`Not a Bitbucket pull request URL: ${a.url}`);
    return { project: decodeURIComponent(m[1]).toUpperCase(), repo: decodeURIComponent(m[2]), id: Number(m[3]) };
  }
  if (!a.project || !a.repo || a.id === undefined) throw new Error("Provide either url, or project + repo + id.");
  return { project: a.project.toUpperCase(), repo: a.repo, id: a.id };
}

/** Builds top-level comment threads from PR activities (replies are nested inside their root comment). */
function commentThreads(activities: BbActivity[]) {
  const roots = activities.filter((a) => a.action === "COMMENTED" && a.commentAction === "ADDED" && a.comment);
  const nested = new Set<number>();
  const collect = (c: BbComment) => c.comments?.forEach((r) => (nested.add(r.id), collect(r)));
  roots.forEach((a) => collect(a.comment!));
  return roots
    .filter((a) => !nested.has(a.comment!.id))
    .map((a) => ({ comment: a.comment!, anchor: a.commentAnchor }))
    .sort((x, y) => x.comment.createdDate - y.comment.createdDate);
}

const latestIn = (c: BbComment): number => Math.max(c.createdDate, ...(c.comments ?? []).map(latestIn));

function renderComment(c: BbComment, depth: number, sinceMs: number | undefined, lines: string[]) {
  const pad = "  ".repeat(depth);
  const tags = [
    c.severity === "BLOCKER" ? `TASK:${c.state ?? "OPEN"}` : undefined,
    sinceMs !== undefined && c.createdDate >= sinceMs ? "NEW" : undefined,
  ].filter(Boolean);
  lines.push(`${pad}${depth ? "↳ " : ""}[#${c.id}] ${c.author.displayName} (${fmtDate(c.createdDate)})${tags.length ? " [" + tags.join(", ") + "]" : ""}:`);
  for (const l of c.text.split("\n")) lines.push(`${pad}    ${l}`);
  for (const r of c.comments ?? []) renderComment(r, depth + 1, sinceMs, lines);
}

function renderThreads(threads: ReturnType<typeof commentThreads>, sinceMs?: number) {
  const lines: string[] = [];
  for (const { comment, anchor } of threads) {
    const where = anchor?.path ? `${anchor.path}${anchor.line ? ":" + anchor.line : ""}` : "general";
    const resolved = comment.threadResolved || comment.state === "RESOLVED" ? " (resolved)" : "";
    lines.push(`--- thread on ${where}${resolved}`);
    renderComment(comment, 0, sinceMs, lines);
  }
  return lines.join("\n");
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

/** Wraps a tool handler so Bitbucket/config errors come back as tool errors rather than crashing. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return { ...text(e instanceof Error ? e.message : String(e)), isError: true };
    }
  };
}

const readOnly = { readOnlyHint: true, openWorldHint: true };

// ---------- tools ----------

server.registerTool(
  "list_watched_repositories",
  {
    description: "List the Bitbucket repositories in the configured watch list (projects are expanded to their repos).",
    inputSchema: {},
    annotations: readOnly,
  },
  safe(async () => {
    const repos = await bb.resolveWatched(config.watch);
    return json({ watch: config.watch.map((w) => (w.repo ? `${w.project}/${w.repo}` : w.project)), repositories: repos.map((r) => `${r.project}/${r.repo}`) });
  }),
);

server.registerTool(
  "list_pull_requests",
  {
    description:
      "List pull requests across the watched repositories (or a given project/repo). Defaults to OPEN PRs. " +
      "Returns title, author, branches, reviewer statuses, comment/task counts and URL.",
    inputSchema: {
      project: z.string().optional().describe("Limit to this project key (need not be in the watch list)"),
      repo: z.string().optional().describe("Limit to this repository slug"),
      state: z.enum(["OPEN", "MERGED", "DECLINED", "ALL"]).default("OPEN"),
      author: z.string().optional().describe("Filter by author (username, display name or email, substring match)"),
      reviewer: z.string().optional().describe("Filter by reviewer (username, display name or email, substring match)"),
      updatedSince: z.string().optional().describe('Only PRs updated since this time: ISO date or relative ("24h", "3d")'),
      limitPerRepo: z.number().int().min(1).max(200).default(25),
    },
    annotations: readOnly,
  },
  safe(async (a) => {
    const repos = await scopeRepos(a.project, a.repo);
    const sinceMs = a.updatedSince ? parseSince(a.updatedSince) : undefined;
    const failures: string[] = [];
    const prs = (
      await mapLimit(repos, 6, (r) =>
        bb.listPullRequests(r.project, r.repo, a.state, a.limitPerRepo).catch((e: Error) => {
          failures.push(`${r.project}/${r.repo}: ${e.message}`);
          return [] as BbPullRequest[];
        }),
      )
    )
      .flat()
      .filter((pr) => !a.author || matchesUser(pr.author.user, a.author))
      .filter((pr) => !a.reviewer || pr.reviewers.some((r) => matchesUser(r.user, a.reviewer!)))
      .filter((pr) => sinceMs === undefined || pr.updatedDate >= sinceMs)
      .sort((x, y) => y.updatedDate - x.updatedDate);
    return json({ repositoriesChecked: repos.length, count: prs.length, pullRequests: prs.map(summarizePr), failures: failures.length ? failures : undefined });
  }),
);

server.registerTool(
  "my_pull_requests",
  {
    description:
      "Pull requests involving the token owner across all of Bitbucket (not limited to the watch list): " +
      "ones you authored, are reviewing, or participate in.",
    inputSchema: {
      role: z.enum(["AUTHOR", "REVIEWER", "PARTICIPANT"]).optional().describe("Omit for all roles"),
      state: z.enum(["OPEN", "MERGED", "DECLINED"]).default("OPEN"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: readOnly,
  },
  safe(async (a) => {
    const prs = await bb.dashboardPullRequests(a.role, a.state, a.limit);
    return json({ count: prs.length, pullRequests: prs.map(summarizePr) });
  }),
);

server.registerTool(
  "get_pull_request",
  {
    description:
      "Details of one pull request: description, reviewers and their approval status, merge readiness (conflicts, vetoes), " +
      "CI build statuses of the latest commit, and the list of changed files.",
    inputSchema: prRefShape,
    annotations: readOnly,
  },
  safe(async (a) => {
    const { project, repo, id } = resolvePrRef(a);
    const pr = await bb.getPullRequest(project, repo, id);
    const [merge, builds, changes] = await Promise.all([
      pr.state === "OPEN" ? bb.getMergeStatus(project, repo, id).catch(() => undefined) : undefined,
      bb.getBuildStatuses(pr.fromRef.latestCommit).catch(() => []),
      bb.getChanges(project, repo, id).catch(() => []),
    ]);
    return json({
      ...summarizePr(pr),
      description: pr.description ?? "",
      latestCommit: pr.fromRef.latestCommit,
      participants: pr.participants.map((p) => `${p.user.displayName}: ${p.status}`),
      merge: merge && {
        canMerge: merge.canMerge,
        conflicted: merge.conflicted,
        vetoes: merge.vetoes.map((v) => v.summaryMessage),
      },
      builds: builds.map((b) => ({ state: b.state, name: b.name ?? b.key, url: b.url, date: fmtDate(b.dateAdded) })),
      changedFiles: changes.map((c) => `${c.type} ${c.srcPath && c.type === "MOVE" ? c.srcPath.toString + " -> " : ""}${c.path.toString}`),
    });
  }),
);

server.registerTool(
  "get_pull_request_comments",
  {
    description:
      "All comment threads on a pull request, with replies nested, inline file/line anchors, tasks and resolved state. " +
      'Use "since" to mark and keep only threads with new activity.',
    inputSchema: {
      ...prRefShape,
      since: z.string().optional().describe('Only threads with comments since this time: ISO date or relative ("24h", "3d")'),
      includeResolved: z.boolean().default(true).describe("Include resolved threads"),
    },
    annotations: readOnly,
  },
  safe(async (a) => {
    const { project, repo, id } = resolvePrRef(a);
    const sinceMs = a.since ? parseSince(a.since) : undefined;
    const [pr, activities] = await Promise.all([bb.getPullRequest(project, repo, id), bb.getActivities(project, repo, id)]);
    const threads = commentThreads(activities)
      .filter((t) => a.includeResolved || !(t.comment.threadResolved || t.comment.state === "RESOLVED"))
      .filter((t) => sinceMs === undefined || latestIn(t.comment) >= sinceMs);
    const reviews = activities
      .filter((x) => ["APPROVED", "UNAPPROVED", "REVIEWED", "MERGED", "DECLINED", "RESCOPED"].includes(x.action))
      .filter((x) => sinceMs === undefined || x.createdDate >= sinceMs)
      .map((x) => `${fmtDate(x.createdDate)} ${x.user.displayName}: ${x.action}`)
      .reverse();
    const header = `${project}/${repo} #${id}: ${pr.title}\n${prUrl(pr)}\n${threads.length} thread(s)`;
    const body = threads.length ? renderThreads(threads, sinceMs) : "(no comments)";
    return text(`${header}\n\n${body}${reviews.length ? "\n\n--- review events\n" + reviews.join("\n") : ""}`);
  }),
);

server.registerTool(
  "recent_comments",
  {
    description:
      "What people said recently: comment threads with new activity since a given time across all open pull requests " +
      "in the watched repositories (or a given project/repo).",
    inputSchema: {
      since: z.string().default("24h").describe('ISO date or relative ("24h", "3d", "1w")'),
      project: z.string().optional(),
      repo: z.string().optional(),
      excludeAuthor: z.string().optional().describe("Hide comments only written by this user (e.g. yourself)"),
    },
    annotations: readOnly,
  },
  safe(async (a) => {
    const sinceMs = parseSince(a.since);
    const repos = await scopeRepos(a.project, a.repo);
    const prs = (await mapLimit(repos, 6, (r) => bb.listPullRequests(r.project, r.repo, "OPEN", 100).catch(() => [] as BbPullRequest[])))
      .flat()
      .filter((pr) => pr.updatedDate >= sinceMs);

    const isOthers = (c: BbComment): boolean =>
      (c.createdDate >= sinceMs && !(a.excludeAuthor && matchesUser(c.author, a.excludeAuthor))) || (c.comments ?? []).some(isOthers);

    const sections = await mapLimit(prs, 6, async (pr) => {
      const { project, repo } = { project: pr.toRef.repository.project.key, repo: pr.toRef.repository.slug };
      const threads = commentThreads(await bb.getActivities(project, repo, pr.id, 500)).filter((t) => isOthers(t.comment));
      if (!threads.length) return undefined;
      return `=== ${project}/${repo} #${pr.id}: ${pr.title} (by ${pr.author.user.displayName})\n${prUrl(pr)}\n${renderThreads(threads, sinceMs)}`;
    });
    const found = sections.filter(Boolean);
    return text(
      found.length
        ? `New comment activity since ${fmtDate(sinceMs)} on ${found.length} PR(s):\n\n${found.join("\n\n")}`
        : `No new comments since ${fmtDate(sinceMs)} on open PRs in ${repos.length} repositories.`,
    );
  }),
);

server.registerTool(
  "get_pull_request_diff",
  {
    description: "Unified diff of a pull request, optionally limited to one file. Large diffs are truncated.",
    inputSchema: {
      ...prRefShape,
      path: z.string().optional().describe("Only the diff for this file path"),
      contextLines: z.number().int().min(0).max(50).default(3),
      maxChars: z.number().int().min(1000).max(500000).default(60000),
    },
    annotations: readOnly,
  },
  safe(async (a) => {
    const { project, repo, id } = resolvePrRef(a);
    let diff = await bb.getRawDiff(project, repo, id, a.contextLines);
    if (a.path) {
      const files = diff.split(/^(?=diff --git )/m).filter((f) => f.split("\n", 1)[0].includes(a.path!));
      if (!files.length) return text(`No changes to "${a.path}" in this pull request.`);
      diff = files.join("");
    }
    return text(diff.length > a.maxChars ? diff.slice(0, a.maxChars) + `\n\n[truncated: ${diff.length} chars total; pass path or a larger maxChars]` : diff);
  }),
);

// ---------- write tools ----------

if (!config.readOnly) {
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  server.registerTool(
    "add_pull_request_comment",
    {
      description:
        "Post a new comment on a pull request, visible to everyone and authored as the token owner. " +
        "Without path it is a general comment; with path it is attached to that file, and with path + line to that line of the diff. " +
        "Set task=true to create a task (blocker comment). Use reply_to_pull_request_comment to answer an existing comment.",
      inputSchema: {
        ...prRefShape,
        text: z.string().min(1).describe("Comment text (Markdown supported)"),
        path: z.string().optional().describe("File path in the PR to attach the comment to"),
        line: z.number().int().min(1).optional().describe("Line number in the diff (requires path)"),
        lineType: z
          .enum(["ADDED", "REMOVED", "CONTEXT"])
          .default("ADDED")
          .describe("Kind of diff line: ADDED (new code, numbered in the new file), REMOVED (numbered in the old file), CONTEXT (unchanged)"),
        task: z.boolean().default(false).describe("Create as a task the author must resolve"),
      },
      annotations: write,
    },
    safe(async (a) => {
      const { project, repo, id } = resolvePrRef(a);
      if (a.line !== undefined && !a.path) throw new Error("line requires path.");
      const anchor = a.path
        ? a.line !== undefined
          ? { path: a.path, line: a.line, lineType: a.lineType, fileType: a.lineType === "REMOVED" ? ("FROM" as const) : ("TO" as const) }
          : { path: a.path }
        : undefined;
      const c = await bb.addComment(project, repo, id, { text: a.text, anchor, severity: a.task ? "BLOCKER" : undefined });
      const where = anchor ? `${anchor.path}${a.line !== undefined ? ":" + a.line : ""}` : "the PR";
      return text(`Posted ${a.task ? "task" : "comment"} #${c.id} on ${where} in ${project}/${repo} #${id}.`);
    }),
  );

  server.registerTool(
    "reply_to_pull_request_comment",
    {
      description:
        "Reply to an existing comment on a pull request, authored as the token owner. " +
        "Get comment ids (shown as [#123]) from get_pull_request_comments or recent_comments.",
      inputSchema: {
        ...prRefShape,
        commentId: z.number().int().describe("Id of the comment to reply to"),
        text: z.string().min(1).describe("Reply text (Markdown supported)"),
      },
      annotations: write,
    },
    safe(async (a) => {
      const { project, repo, id } = resolvePrRef(a);
      const c = await bb.addComment(project, repo, id, { text: a.text, parentId: a.commentId });
      return text(`Posted reply #${c.id} to comment #${a.commentId} in ${project}/${repo} #${id}.`);
    }),
  );

  /** Resolves a reviewer given as username, display name or email to a unique Bitbucket username. */
  async function resolveReviewer(q: string): Promise<string> {
    const users = await bb.findUsers(q);
    const s = q.toLowerCase();
    const exact = users.filter((u) => [u.name, u.displayName, u.emailAddress].some((v) => v?.toLowerCase() === s));
    const hits = exact.length ? exact : users;
    if (hits.length === 1) return hits[0].name;
    if (!hits.length) throw new Error(`No Bitbucket user matches reviewer "${q}".`);
    throw new Error(`Reviewer "${q}" is ambiguous: ${hits.map((u) => `${u.displayName} (${u.name})`).join(", ")}. Use the username.`);
  }

  const toRefId = (branch: string) => (branch.startsWith("refs/") ? branch : `refs/heads/${branch}`);

  server.registerTool(
    "create_pull_request",
    {
      description:
        "Create a pull request from a branch that already exists on the Bitbucket server (push it first). " +
        "Target defaults to the repo's default branch. The repo's default reviewers are added automatically, plus any extra reviewers given. " +
        "Authored as the token owner.",
      inputSchema: {
        project: z.string().describe("Project key, e.g. PROJ"),
        repo: z.string().describe("Repository slug"),
        fromBranch: z.string().describe("Source branch name, e.g. feature/login"),
        toBranch: z.string().optional().describe("Target branch; defaults to the repo's default branch"),
        title: z.string().min(1),
        description: z.string().optional().describe("PR description (Markdown supported)"),
        reviewers: z.array(z.string()).default([]).describe("Extra reviewers: username, display name or email"),
        addDefaultReviewers: z.boolean().default(true).describe("Add the repo's configured default reviewers"),
        draft: z.boolean().default(false).describe("Create as draft (Bitbucket 8.18+)"),
      },
      annotations: write,
    },
    safe(async (a) => {
      const project = a.project.toUpperCase();
      const fromRefId = toRefId(a.fromBranch);
      const target = a.toBranch ? toRefId(a.toBranch) : (await bb.getDefaultBranch(project, a.repo)).id;
      if (fromRefId === target) throw new Error(`Source and target are the same branch (${target}).`);

      const reviewers = new Set(await Promise.all(a.reviewers.map(resolveReviewer)));
      const notes: string[] = [];
      if (a.addDefaultReviewers) {
        try {
          const repoInfo = await bb.getRepo(project, a.repo);
          for (const u of await bb.getDefaultReviewers(project, a.repo, repoInfo.id, fromRefId, target)) reviewers.add(u.name);
        } catch (e) {
          notes.push(`Could not load default reviewers: ${e instanceof Error ? e.message : e}`);
        }
      }

      // Bitbucket rejects the PR author as a reviewer, e.g. when a default-reviewer rule includes yourself
      const me = await bb.whoami().catch(() => undefined);
      if (me) reviewers.delete(me);

      const pr = await bb.createPullRequest(project, a.repo, {
        title: a.title,
        description: a.description,
        fromRefId,
        toRefId: target,
        reviewers: [...reviewers],
        draft: a.draft,
      });
      return json({ created: summarizePr(pr), notes: notes.length ? notes : undefined });
    }),
  );
}

await server.connect(new StdioServerTransport());
