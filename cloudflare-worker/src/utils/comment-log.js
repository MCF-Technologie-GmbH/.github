import { GITHUB_APP_BOT_LOGIN } from "../config.js";

const META_START = "<!-- command-log:meta";
const META_END = "command-log:end -->";

/**
 * Wraps GitHub comment creation so each new bot response carries prior bot
 * responses in a collapsed command log.
 *
 * @param {object} gh - GitHub client.
 * @returns {object} GitHub client proxy.
 */
export function withCommandLog(gh) {
  const cleanedIssues = new Set();
  const metadata = new Map();

  return new Proxy(gh, {
    get(target, prop, receiver) {
      if (prop === "setCommandLogMetadata") {
        return (owner, repo, issueNumber, meta) => {
          metadata.set(issueKey(owner, repo, issueNumber), normalizeMetadata(meta));
        };
      }

      if (prop === "createCommentRaw") {
        return async (owner, repo, issueNumber, body) => target.createComment(owner, repo, issueNumber, body);
      }

      if (prop !== "createComment") {
        return Reflect.get(target, prop, receiver);
      }

      return async (owner, repo, issueNumber, body) => {
        const key = issueKey(owner, repo, issueNumber);
        const commandLog = cleanedIssues.has(key)
          ? []
          : await cleanupPreviousBotComments(target, owner, repo, issueNumber);
        cleanedIssues.add(key);
        return target.createComment(owner, repo, issueNumber, appendCommandLog(body, commandLog, metadata.get(key)));
      };
    },
  });
}

async function cleanupPreviousBotComments(gh, owner, repo, issueNumber) {
  try {
    const comments = await gh.listIssueComments(owner, repo, issueNumber);
    const botComments = comments.filter((comment) => comment.user?.login === GITHUB_APP_BOT_LOGIN);
    for (const comment of botComments) {
      await gh.deleteComment(owner, repo, comment.id);
    }
    return botComments.flatMap((comment) => {
      const body = String(comment.body || "");
      const metadata = extractCommandMetadata(body);
      const currentEntry = {
        actor: metadata?.actor || null,
        command: metadata?.command || null,
        createdAt: comment.created_at,
        body: stripCommandLog(body).trim(),
      };
      return [
        ...(metadata?.history || []),
        currentEntry,
      ];
    }).filter((entry) => entry.body);
  } catch (err) {
    console.error(`Failed to delete previous bot comments: ${err.message}`);
    return [];
  }
}

function appendCommandLog(body, commandLog, metadata) {
  const history = commandLog;
  const bodyWithLog = commandLog.length ? [
    body,
    "",
    "<details><summary>Command log</summary>",
    "",
    ...[...history].reverse().flatMap((entry, index) => {
      const fence = markdownFenceFor(entry.body);
      return [
        index > 0 ? "---" : "",
        `#### ${formatTimestamp(entry.createdAt)}`,
        `Command: ${formatCommand(entry.command)}`,
        `Executed by: ${formatActor(entry.actor)}`,
        "",
        "Output:",
        `${fence}text`,
        entry.body,
        fence,
        "",
      ].filter(Boolean);
    }),
    "</details>",
  ].join("\n") : body;

  return [
    bodyWithLog,
    metadata ? formatMetadataBlock({ ...metadata, history }) : "",
  ].filter(Boolean).join("\n");
}

function stripCommandLog(body) {
  return stripCommandMetadata(String(body || ""))
    .replace(/\n*<details><summary>Command log<\/summary>[\s\S]*?<\/details>\s*$/i, "");
}

function extractCommandMetadata(body) {
  const match = String(body || "").match(metadataRegex());
  if (match) {
    try {
      return normalizeMetadata(JSON.parse(match[1].trim()));
    } catch {
      return {};
    }
  }

  const legacyActor = String(body || "").match(/\n*<!-- command-log:actor=([^>]+) -->\s*$/);
  return legacyActor ? { actor: sanitizeActor(legacyActor[1]), command: null } : {};
}

function stripCommandMetadata(body) {
  return String(body || "")
    .replace(metadataRegex(), "")
    .replace(/\n*<!-- command-log:actor=([^>]+) -->\s*$/, "");
}

function sanitizeActor(actor) {
  const value = String(actor || "").trim().replace(/^@/, "");
  return /^[A-Za-z0-9-]+$/.test(value) ? value : null;
}

function sanitizeCommand(command) {
  const value = String(command || "").trim();
  return value.startsWith("/") ? value.slice(0, 200) : null;
}

function normalizeMetadata(meta) {
  if (!meta || typeof meta !== "object") return null;
  const normalized = {
    actor: sanitizeActor(meta.actor),
    command: sanitizeCommand(meta.command),
    history: normalizeHistory(meta.history),
  };
  return normalized.actor || normalized.command || normalized.history.length ? normalized : null;
}

function formatMetadataBlock(meta) {
  return `${META_START}\n${JSON.stringify(meta)}\n${META_END}`;
}

function metadataRegex() {
  return new RegExp(`\\n*${escapeRegex(META_START)}\\s*([\\s\\S]*?)\\s*${escapeRegex(META_END)}\\s*$`);
}

function formatTimestamp(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function formatCommand(command) {
  return command ? `\`${command}\`` : "`unknown`";
}

function formatActor(actor) {
  return actor ? `@${actor}` : "unknown";
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map((entry) => ({
    actor: sanitizeActor(entry?.actor),
    command: sanitizeCommand(entry?.command),
    createdAt: sanitizeTimestamp(entry?.createdAt),
    body: sanitizeBody(entry?.body),
  })).filter((entry) => entry.body);
}

function sanitizeTimestamp(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 80) : null;
}

function sanitizeBody(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 4000) : null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markdownFenceFor(value) {
  const longestRun = Math.max(0, ...String(value || "").match(/`+/g)?.map((match) => match.length) || []);
  return "`".repeat(Math.max(3, longestRun + 1));
}

function issueKey(owner, repo, issueNumber) {
  return `${owner}/${repo}#${issueNumber}`;
}
