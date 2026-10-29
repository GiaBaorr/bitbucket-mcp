# bitbucket-mcp

MCP server that lets a Claude agent read pull requests and PR comments from **Bitbucket Data Center / Server**, and post comments, replies and new pull requests.

## Tools

| Tool | What it does |
|---|---|
| `list_watched_repositories` | Lists the repos in your watch list. |
| `list_pull_requests` | Lists PRs in the watch list or a given project/repo, with filters for author, reviewer, `updatedSince` and state (default: open). |
| `my_pull_requests` | PRs you authored, are reviewing or participate in, across all of Bitbucket. |
| `get_pull_request` | Description, reviewer statuses, merge readiness/vetoes, CI builds and changed files. |
| `get_pull_request_comments` | Comment threads with nested replies, file:line anchors, tasks, resolved state and review events. |
| `recent_comments` | Comments made since a given time across all open PRs you watch. |
| `get_pull_request_diff` | Unified diff, optionally limited to one file. |
| `add_pull_request_comment` | Post a comment: general, on a file, or on a specific diff line. Can also create a task. |
| `reply_to_pull_request_comment` | Reply to an existing comment by its id (shown as `[#123]` in comment output). |
| `create_pull_request` | Open a PR from a branch already pushed to Bitbucket. The target defaults to the repo's default branch, the repo's default reviewers are added, and extra reviewers can be given by username, name or email. Draft PRs need Bitbucket 8.18+. |

PR tools accept either a PR `url` pasted from the browser, or `project` + `repo` + `id`.
Times accept ISO (`2026-10-28T09:00`) or relative (`30m`, `24h`, `3d`, `1w`).

Comments, replies and PRs are created **as you**, the owner of the token. Claude Code asks for your approval before each of these calls unless you allow the tool in `/permissions`.

## Setup

### Prerequisites

- Node.js 20 or newer (`node --version`)
- [Claude Code](https://claude.com/claude-code) (`claude --version`)

### 1. Create a Bitbucket HTTP access token

In Bitbucket, open your avatar → **Manage account** → **HTTP access tokens** → **Create token**.

- Permissions: **Project read** and **Repository write**. Read is enough for viewing PRs; write is needed to comment and create PRs.
- Copy the token right away. Bitbucket shows it only once.

SSH and GPG keys are not used. They are for git and commit signing, not the REST API.

### 2. Install and build

```sh
git clone <this repo>
cd bitbucket-mcp
npm ci
npm run build
```

`npm ci` installs the exact versions from `package-lock.json`.

### 3. Configure

Create the config file outside the repo so the token is never committed:

```sh
mkdir -p ~/.config/bitbucket-mcp
cp config.example.json ~/.config/bitbucket-mcp/config.json
chmod 600 ~/.config/bitbucket-mcp/config.json
```

Edit `~/.config/bitbucket-mcp/config.json`:

```json
{
  "baseUrl": "https://bitbucket.example.com",
  "token": "<your HTTP access token>",
  "watch": ["PROJ", "OTHER/some-repo"],
  "readOnly": false
}
```

| Field | Meaning |
|---|---|
| `baseUrl` | The Bitbucket server root only: no `/projects/...` path and no trailing slash. |
| `token` | The HTTP access token from step 1. |
| `watch` | Projects and repos to follow. `"PROJ"` means every non-archived repo in project PROJ; `"PROJ/my-repo"` means just that repo. Project keys are the short codes in Bitbucket URLs (`/projects/PROJ/...`). |
| `readOnly` | `true` turns off the comment, reply and create-PR tools. |

Environment variables override the file: `BITBUCKET_URL`, `BITBUCKET_TOKEN`, `BITBUCKET_WATCH` (`PROJ,OTHER/repo`), `BITBUCKET_READ_ONLY`, and `BITBUCKET_MCP_CONFIG` (path to a different config file).

### 4. Register with Claude Code

Run this from the repo folder. `$(pwd)` fills in the absolute path:

```sh
claude mcp add bitbucket --scope user -- node "$(pwd)/dist/index.js"
claude mcp list
```

`bitbucket` should show **✔ Connected**. `--scope user` makes it available in every folder.

If your Bitbucket uses an internal certificate authority and you get TLS errors, add `-e NODE_EXTRA_CA_CERTS=/path/to/ca.pem` before the `--`.

### 5. Use it

Open a **new** Claude Code session and ask about your PRs, for example "which PRs are open in PROJ?". Run `/mcp` to check that `bitbucket` is connected.

## Starting and stopping

You don't run the server yourself. Claude Code starts it when a session opens and stops it when the session ends. Running `npm start` by hand just waits for input.

| To… | Do this |
|---|---|
| Check it's running | `/mcp` in a Claude Code session |
| Turn it off temporarily | `/mcp` → `bitbucket` → **Disable** (later **Enable**) |
| Apply config or code changes | `npm run build` if you changed code, then `/mcp` → `bitbucket` → **Reconnect**, or open a new session |
| Remove it | `claude mcp remove bitbucket --scope user` |

## Troubleshooting

| Problem | Fix |
|---|---|
| `bitbucket` shows **Failed** in `claude mcp list` | Usually a missing or invalid config. Run `node dist/index.js` in the repo; a config error is printed immediately. If nothing prints, the config is fine; press Ctrl+C. |
| `Bitbucket 401` | The token is wrong, expired or revoked. Create a new one. |
| `Bitbucket 403` / 401 when commenting or creating a PR | The token lacks **Repository write**. |
| `Bitbucket 404` on a project | Wrong project key in `watch`, or `baseUrl` includes a path. |
| `npm ci` fails with **403 Forbidden** | Your npm registry mirror may block very new package versions. Use `npm ci` (it installs the pinned versions from `package-lock.json`), not `npm install`. If you must reinstall, use `npm install --before=<date about 2 months ago>`. |
| Changes to the config don't show up | The config is read at startup. Reconnect via `/mcp` or open a new session. |
