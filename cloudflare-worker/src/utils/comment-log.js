import { GITHUB_APP_BOT_LOGIN } from "../config.js";

/**
 * Wraps GitHub comment creation so each new bot response carries prior bot
 * responses in a collapsed command log.
 *
 * @param {object} gh - GitHub client.
 * @returns {object} GitHub client proxy.
 */
export function withCommandLog(gh) {
  const cleanedIssues = new Set();

  return new Proxy(gh, {
    get(target, prop, receiver) {
      if (prop !== "createComment") {
        return Reflect.get(target, prop, receiver);
      }

      return async (owner, repo, issueNumber, body) => {
        const key = `${owner}/${repo}#${issueNumber}`;
        const commandLog = cleanedIssues.has(key)
          ? []
          : await cleanupPreviousBotComments(target, owner, repo, issueNumber);
        cleanedIssues.add(key);
        return target.createComment(owner, repo, issueNumber, appendCommandLog(body, commandLog));
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
    return botComments.map((comment) => ({
      createdAt: comment.created_at,
      body: stripCommandLog(comment.body || "").trim(),
    })).filter((comment) => comment.body);
  } catch (err) {
    console.error(`Failed to delete previous bot comments: ${err.message}`);
    return [];
  }
}

function appendCommandLog(body, commandLog) {
  if (!commandLog.length) return body;

  return [
    body,
    "",
    "<details><summary>Command log</summary>",
    "<p>",
    "",
    ...commandLog.flatMap((entry, index) => {
      const header = entry.createdAt ? `Previous response from ${entry.createdAt}:` : "Previous response:";
      return [
        index > 0 ? "---" : "",
        header,
        "",
        entry.body,
        "",
      ].filter(Boolean);
    }),
    "</p>",
    "</details>",
  ].join("\n");
}

function stripCommandLog(body) {
  return String(body || "").replace(/\n*<details><summary>Command log<\/summary>[\s\S]*?<\/details>\s*$/i, "");
}
