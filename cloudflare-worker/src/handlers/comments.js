import { REQUIRES_WHITELIST } from "../config.js";
import { parseChecklist, getRequiresLabelsForChecklist } from "../utils/checklist.js";

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
  const commands = [];
  const validNames = Object.keys(REQUIRES_WHITELIST);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) continue;

    const match = trimmed.match(/^\/(require|unrequire|resolve|unresolve|check|uncheck)\s+(.+)$/i);
    if (!match) continue;

    const commandName = match[1].toLowerCase();
    const itemNameRaw = match[2].trim();

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

  let { checklist, startIndex, endIndex } = parseChecklist(issueBody);

  if (startIndex === -1) {
    issueBody += "\n\n<!-- managed:start -->\n## Required updates\n<!-- managed:end -->\n";
    const reParsed = parseChecklist(issueBody);
    checklist = reParsed.checklist;
    startIndex = reParsed.startIndex;
    endIndex = reParsed.endIndex;
  }

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

  let checklistText = "\n";
  for (const item of checklist) {
    checklistText += `- [${item.checked ? "x" : " "}] ${item.name}\n`;
  }

  const updatedBody = issueBody.slice(0, startIndex) + checklistText + issueBody.slice(endIndex);

  await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, updatedBody);

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

  try {
    await gh.createCommentReaction(owner, repo, comment.id, "rocket");
    await gh.deleteComment(owner, repo, comment.id);
  } catch (err) {
    console.error(`Failed to manage comment/reaction: ${err.message}`);
  }

  return {
    processed: true,
    commandsProcessed: commands.length,
  };
}
