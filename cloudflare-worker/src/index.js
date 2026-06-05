import {
  ORGANIZATION,
  ISSUE_ACTIONS_TO_VALIDATE,
  GITHUB_APP_BOT_LOGIN
} from "./config.js";
import { verifyGitHubSignature } from "./utils/crypto.js";
import { normalizeRepo } from "./utils/text.js";
import { GitHubClient, createInstallationAccessToken } from "./services/github.js";
import { handleIssueCommentEvent } from "./handlers/comments.js";
import { enforceIssueTypePolicy } from "./handlers/issues.js";

export default {
  /**
   * Main entrypoint for Cloudflare Worker.
   * Receives and routes incoming GitHub webhooks (issues & issue_comments).
   */
  async fetch(request, env) {
    // 1. Health check endpoint (for verifying Worker is active)
    if (request.method === "GET") {
      return json({ ok: true, service: "github-automation-bot" }, 200);
    }

    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    const rawBody = await request.arrayBuffer();
    const signatureHeader = request.headers.get("X-Hub-Signature-256");
    const event = request.headers.get("X-GitHub-Event") || "unknown";
    const delivery = request.headers.get("X-GitHub-Delivery") || "unknown";

    if (!signatureHeader) {
      return json({ error: "Missing X-Hub-Signature-256 header" }, 401);
    }

    if (!env.GITHUB_WEBHOOK_SECRET) {
      console.error("Missing Cloudflare secret: GITHUB_WEBHOOK_SECRET");
      return json({ error: "Server misconfiguration: missing webhook secret" }, 500);
    }

    // 2. Validate HMAC Webhook Signature (verifies payload came from GitHub)
    const isValid = await verifyGitHubSignature(
      rawBody,
      signatureHeader,
      env.GITHUB_WEBHOOK_SECRET
    );

    if (!isValid) {
      return json({ error: "Invalid signature" }, 401);
    }

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    console.log("Webhook received", {
      event,
      delivery,
      action: payload.action,
      repository: payload.repository?.full_name,
      sender: payload.sender?.login,
    });

    // 3. Handle GitHub Ping Event (initial webhook connection verification)
    if (event === "ping") {
      return json({ ok: true, pong: true }, 200);
    }

    if (event !== "issues" && event !== "issue_comment") {
      return json({ ok: true, skipped: true, reason: `event=${event}` }, 200);
    }

    // Prevent feedback loops caused by our own bot.
    if (payload.sender?.login === GITHUB_APP_BOT_LOGIN) {
      return json(
        {
          ok: true,
          skipped: true,
          reason: "event sent by automation bot",
        },
        200
      );
    }

    const repository = payload.repository;
    const installationId = payload.installation?.id;

    if (!repository || !installationId) {
      return json({ error: "Invalid payload: missing repository or installation id" }, 400);
    }

    const owner = repository.owner?.login;
    const repo = repository.name;
    const repoFullName = normalizeRepo(repository.full_name || `${owner}/${repo}`);
    const issue = payload.issue;

    if (!owner || !repo || !issue) {
      return json({ error: "Invalid payload: missing owner, repo, or issue details" }, 400);
    }

    const issueNumber = issue.number;

    try {
      const token = await createInstallationAccessToken(env, installationId);
      const gh = new GitHubClient(token);

      // 4. Resolve metadata (Issue Types and Fields) dynamically via GitHub GraphQL API.
      // This prevents relying on hardcoded Node IDs.
      const orgIssueTypes = await gh.getOrgIssueTypes(ORGANIZATION);
      const typeMap = new Map(orgIssueTypes.map((t) => [t.name, t.id]));

      const orgIssueFields = await gh.getOrgIssueFields(ORGANIZATION);
      const scopeField = orgIssueFields.find((f) => f.name === "Scope");
      const priorityField = orgIssueFields.find((f) => f.name === "Priority");
      const effortField = orgIssueFields.find((f) => f.name === "Effort");

      // 5. Handle Comment Slash Command Webhook Event
      if (event === "issue_comment") {
        if (payload.action !== "created") {
          return json(
            {
              ok: true,
              skipped: true,
              reason: `comment action=${payload.action}`,
            },
            200
          );
        }

        const result = await handleIssueCommentEvent({
          gh,
          owner,
          repo,
          repoFullName,
          issueNumber,
          comment: payload.comment,
          scopeField,
        });

        return json({ ok: true, ...result }, 200);
      }

      // 6. Handle Issue State Policy Webhook Event
      const action = payload.action;

      if (!ISSUE_ACTIONS_TO_VALIDATE.has(action)) {
        return json(
          {
            ok: true,
            skipped: true,
            reason: `issue action=${action}`,
          },
          200
        );
      }



      const currentIssue = await gh.getIssue(owner, repo, issueNumber);
      const currentType = currentIssue.issueType?.name || "none";

      const result = await enforceIssueTypePolicy({
        gh,
        owner,
        repo,
        repoFullName,
        issueNumber,
        action,
        currentIssue,
        currentType,
        changes: payload.changes,
        typeMap,
        scopeField,
        priorityField,
        effortField,
      });

      return json(
        {
          ok: true,
          ...result,
        },
        200
      );
    } catch (err) {
      console.error(`Processing failed for ${repository.full_name}#${issueNumber}`, err);
      return json({ error: "Processing failed", detail: err.message }, 500);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
