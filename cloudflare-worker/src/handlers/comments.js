import { REQUIRES_WHITELIST } from "../config.js";
import { parseChecklist, getRequiresLabelsForChecklist } from "../utils/checklist.js";
import { handleBranchCommand } from "./branches.js";

/**
 * Parses and executes slash commands (/require, /unrequire, /resolve, etc.) found in comments.
 * Sychronizes checklist states and updates issue labels.
 * Deletes the command comment afterwards to keep the timeline clean.
 *
 * @param {object} params
 * @param {GitHubClient} params.gh - API client wrapper
 * @param {string} params.owner - Repo owner
 * @param {string} params.repo - Repo name
 * @param {string} params.repoFullName - Normalized repository full name (owner/repo)
 * @param {number} params.issueNumber - GitHub Issue number
 * @param {object} params.comment - Comment payload from webhook
 * @param {object} params.scopeField - Single-select Scope issue field metadata
 */
export async function handleIssueCommentEvent({
  gh,
  owner,
  repo,
  repoFullName,
  issueNumber,
  comment,
  scopeField,
}) {
  const commentBody = comment.body || "";
  const lines = commentBody.split(/\r?\n/);
  const hasBranchCommand = lines.some((line) => line.trim().toLowerCase() === "/branch create");

  if (hasBranchCommand) {
    const result = await handleBranchCommand({ gh, owner, repo, issueNumber, comment });
    await cleanupCommandComment(gh, owner, repo, comment);
    return result;
  }

  const commands = [];
  const validNames = Object.keys(REQUIRES_WHITELIST);

  // 1. Parse lines to look for commands (e.g. "/require Documentation")
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) continue;

    const match = trimmed.match(/^\/(require|unrequire|resolve|unresolve|check|uncheck)\s+(.+)$/i);
    if (!match) continue;

    const commandName = match[1].toLowerCase();
    const itemNameRaw = match[2].trim();

    // Check if the parameter matches a valid checklist item (case-insensitive)
    const matchedName = validNames.find((v) => v.toLowerCase() === itemNameRaw.toLowerCase());

    if (matchedName) {
      commands.push({ command: commandName, item: matchedName, line: trimmed });
    } else {
      console.log(`Command ignored — invalid item: ${itemNameRaw}`);
    }
  }

  if (commands.length === 0) {
    return { processed: false, reason: "no valid commands found" };
  }

  const currentIssue = await gh.getIssue(owner, repo, issueNumber);
  let issueBody = currentIssue.body || "";

  // 2. Parse the active checklist block from the body
  let { checklist, startIndex, endIndex } = parseChecklist(issueBody);

  // If the issue doesn't have a checklist block, initialize one
  if (startIndex === -1) {
    issueBody += "\n\n<!-- managed:start -->\n### Required updates\n<!-- managed:end -->\n";
    const reParsed = parseChecklist(issueBody);
    checklist = reParsed.checklist;
    startIndex = reParsed.startIndex;
    endIndex = reParsed.endIndex;
  }

  // 3. Process each parsed command sequentially and update the checklist model
  for (const cmd of commands) {
    const itemIdx = checklist.findIndex((item) => item.name === cmd.item);

    if (cmd.command === "require") {
      if (itemIdx === -1) {
        checklist.push({ name: cmd.item, checked: false });
      }
    } else if (cmd.command === "unrequire") {
      if (itemIdx !== -1) {
        checklist.splice(itemIdx, 1);
      }
    } else if (cmd.command === "resolve" || cmd.command === "check") {
      if (itemIdx !== -1) {
        checklist[itemIdx].checked = true;
      } else {
        checklist.push({ name: cmd.item, checked: true });
      }
    } else if (cmd.command === "unresolve" || cmd.command === "uncheck") {
      if (itemIdx !== -1) {
        checklist[itemIdx].checked = false;
      } else {
        checklist.push({ name: cmd.item, checked: false });
      }
    }
  }

  // 4. Format the updated checklist text block
  let checklistText = "\n";
  for (const item of checklist) {
    checklistText += `- [${item.checked ? "x" : " "}] ${item.name}\n`;
  }

  const updatedBody = issueBody.slice(0, startIndex) + checklistText + issueBody.slice(endIndex);

  // 5. Update issue body in GitHub
  await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, updatedBody);

  // 6. Update labels (add requires/* for unchecked, remove for checked)
  const currentLabels = currentIssue.labels?.nodes?.map((l) => l.name) ?? [];
  const currentRequiresLabels = currentLabels.filter((name) => name.startsWith("requires/"));
  const desiredRequiresLabels = getRequiresLabelsForChecklist(checklist);

  const labelsToAdd = desiredRequiresLabels.filter((l) => !currentRequiresLabels.includes(l));
  const labelsToRemove = currentRequiresLabels.filter((l) => !desiredRequiresLabels.includes(l));

  if (labelsToAdd.length > 0) {
    await gh.addLabels(owner, repo, issueNumber, labelsToAdd);
  }

  for (const l of labelsToRemove) {
    await gh.removeLabel(owner, repo, issueNumber, l);
  }

  // 7. Cleanup: delete the command comment to keep the timeline content clean.
  await cleanupCommandComment(gh, owner, repo, comment);

  return {
    processed: true,
    commandsProcessed: commands.length,
  };
}

async function cleanupCommandComment(gh, owner, repo, comment) {
  try {
    await gh.deleteComment(owner, repo, comment.id);
  } catch (err) {
    console.error(`Failed to delete command comment: ${err.message}`);
  }
}
