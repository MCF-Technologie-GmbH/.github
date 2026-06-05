/**
 * Cloudflare Worker - MCF GitHub Issue Type Enforcement
 *
 * This Worker is triggered by the GitHub App webhook and enforces these rules:
 *
 * 1. Repository: MCF-Technologie-GmbH/projects
 *    - Only Issue Type `Project` is allowed. Any other type is corrected automatically.
 *
 * 2. Every other repository:
 *    - Issue Type `Project` is reserved and not allowed.
 *    - If an issue is created as `Project`, it is closed automatically.
 *    - On creation, the issue type is validated against the template detected from
 *      the Issue Type dropdown field embedded in each template (not changeable during
 *      form filling — the dropdown has a single option). If wrong, it is corrected.
 *    - If the Issue Type is changed after creation, the Worker queries the
 *      IssueTypeChangedEvent timeline to restore the original type.
 *
 * Required Cloudflare secrets / variables:
 *   GITHUB_WEBHOOK_SECRET  Same value configured as the GitHub App webhook secret
 *   GITHUB_APP_ID          Numeric GitHub App ID
 *   GITHUB_PRIVATE_KEY     GitHub App private key PEM
 *
 * Required GitHub App repository permissions:
 *   Metadata: read
 *   Issues: write
 *
 * Required GitHub App webhook event:
 *   Issues
 */

const ORGANIZATION = "MCF-Technologie-GmbH";
const PROJECTS_REPO_FULL_NAME = `${ORGANIZATION}/projects`.toLowerCase();
const RESERVED_PROJECT_ISSUE_TYPE = "Project";

// GitHub App bot login. Update this if the app slug changes.
const GITHUB_APP_BOT_LOGIN = "mcf-automation-bot[bot]";

const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_GRAPHQL_FEATURES = "issue_types, issue_fields";

const ISSUE_ACTIONS_TO_VALIDATE = new Set(["opened", "reopened", "edited", "typed", "untyped"]);
const ISSUE_TYPE_CHANGE_ACTIONS = new Set(["typed", "untyped", "edited"]);

const REQUIRES_WHITELIST = {
  "Documentation": "requires/docs",
  "Tests": "requires/tests",
  "Release notes": "requires/release-note",
  "Security review": "requires/security-review",
  "Migration": "requires/migration",
  "CI": "requires/ci",
  "Config": "requires/config"
};

export default {
  async fetch(request, env) {
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

      // Fetch organization issue types and fields dynamically
      const orgIssueTypes = await gh.getOrgIssueTypes(ORGANIZATION);
      const typeMap = new Map(orgIssueTypes.map((t) => [t.name, t.id]));

      const orgIssueFields = await gh.getOrgIssueFields(ORGANIZATION);
      const scopeField = orgIssueFields.find((f) => f.name === "Scope");

      // Handle Comment Command Event
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

      // Handle Issues Event
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

      // "edited" without changes in type, body, or title — skip it.
      if (
        action === "edited" &&
        !payload.changes?.type &&
        !payload.changes?.body &&
        !payload.changes?.title
      ) {
        return json(
          {
            ok: true,
            skipped: true,
            reason: "edited event without type/body/title change",
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

async function handleIssueCommentEvent({
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

async function enforceIssueTypePolicy({
  gh,
  owner,
  repo,
  repoFullName,
  issueNumber,
  action,
  currentIssue,
  currentType,
  changes,
  typeMap,
  scopeField,
}) {
  const isProjectsRepo = repoFullName === PROJECTS_REPO_FULL_NAME;
  const isProjectType = currentType === RESERVED_PROJECT_ISSUE_TYPE;
  const isTypeChange = ISSUE_TYPE_CHANGE_ACTIONS.has(action) &&
    (action !== "edited" || changes?.type != null);

  if (isProjectsRepo) {
    return enforceProjectsRepositoryPolicy({
      gh,
      owner,
      repo,
      repoFullName,
      issueNumber,
      currentIssue,
      currentType,
      isProjectType,
      typeMap,
    });
  }

  if (isTypeChange) {
    return revertIssueTypeChangeInImplementationRepo({
      gh,
      owner,
      repo,
      repoFullName,
      issueNumber,
      action,
      currentIssue,
      currentType,
      isProjectType,
    });
  }

  if (isProjectType) {
    return closeReservedProjectTypeInImplementationRepo({
      gh,
      owner,
      repo,
      repoFullName,
      issueNumber,
      action,
      currentType,
    });
  }

  let issueBody = currentIssue.body || "";
  let updatedBody = issueBody;
  let hasBodyChanges = false;
  let resolvedType = currentType;

  // 1. Revert scope changes in the title if edited
  if (action === "edited" && changes?.title) {
    const oldScope = extractScopeFromTitle(changes.title.from);
    const newScope = extractScopeFromTitle(currentIssue.title);
    if (oldScope && newScope && oldScope !== newScope) {
      const correctedTitle = formatTitle(currentIssue.title, resolvedType, oldScope);
      if (correctedTitle !== currentIssue.title) {
        await gh.updateIssueTitleAndBody(owner, repo, issueNumber, correctedTitle, undefined);
        console.log(`Reverted scope change in title from "${newScope}" back to "${oldScope}"`);
        currentIssue.title = correctedTitle;
      }
    }
  }

  if (action === "opened" || action === "reopened") {
    const template = detectTemplateFromIssue(issueBody, typeMap);
    if (template && currentType !== template.expectedType) {
      await gh.updateIssueType(currentIssue.id, template.expectedTypeId);
      resolvedType = template.expectedType;

      const comment = [
        `The issue type was automatically corrected to \`${template.expectedType}\`.`,
        "",
        `This issue was created using the **${template.expectedType}** template.`,
        "",
        "Issue types are determined by the template and cannot be changed.",
      ].join("\n");

      await gh.createComment(owner, repo, issueNumber, comment);
    }

    let cleaned = cleanChecklistOnCreation(issueBody);
    cleaned = removeIssueTypeSection(cleaned);
    cleaned = removeScopeSection(cleaned);
    if (cleaned !== issueBody) {
      updatedBody = cleaned;
      hasBodyChanges = true;
    }
  }

  if (action === "edited" && changes?.body) {
    const oldProtected = extractSection(changes.body.from, "protected");
    const newProtected = extractSection(issueBody, "protected");

    let finalBody = issueBody;
    if (oldProtected && newProtected && oldProtected !== newProtected) {
      finalBody = replaceSection(finalBody, "protected", oldProtected);
    }

    let healed = healChecklist(finalBody, changes.body.from);
    healed = removeIssueTypeSection(healed);
    healed = removeScopeSection(healed);

    if (healed !== issueBody) {
      updatedBody = healed;
      hasBodyChanges = true;
    }
  }

  if (hasBodyChanges) {
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, updatedBody);
    issueBody = updatedBody;
  }

  const { checklist } = parseChecklist(issueBody);
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

  let scopeValue = detectScopeFromBody(issueBody);
  if (!scopeValue) {
    scopeValue = extractScopeFromTitle(currentIssue.title);
  }

  if (scopeValue && scopeField) {
    const scopeOption = scopeField.options?.find(
      (opt) => opt.name.toLowerCase() === scopeValue.toLowerCase()
    );
    if (scopeOption) {
      await gh.updateIssueFieldValue(currentIssue.id, scopeField.id, {
        singleSelectOptionId: scopeOption.id,
      });
      console.log(`Updated Scope Issue Field to: ${scopeOption.name}`);
    }
  }

  const formattedTitle = formatTitle(currentIssue.title, resolvedType, scopeValue);
  if (formattedTitle !== currentIssue.title) {
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, formattedTitle, undefined);
    console.log(`Re-formatted issue title to: ${formattedTitle}`);
  }

  return {
    enforced: false,
    reason: "issue processed, scope and requires checklist synced",
    action,
    repo: repoFullName,
    issue: issueNumber,
    currentType: resolvedType,
    scope: scopeValue,
    title: formattedTitle,
  };
}

async function enforceProjectsRepositoryPolicy({
  gh,
  owner,
  repo,
  repoFullName,
  issueNumber,
  currentIssue,
  currentType,
  isProjectType,
  typeMap,
}) {
  if (isProjectType) {
    return {
      enforced: false,
      reason: "projects repo issue type is valid",
      repo: repoFullName,
      issue: issueNumber,
      currentType,
    };
  }

  const projectTypeId = typeMap.get(RESERVED_PROJECT_ISSUE_TYPE);
  if (!projectTypeId) {
    throw new Error(`Reserved issue type '${RESERVED_PROJECT_ISSUE_TYPE}' not found in organization types.`);
  }

  await gh.updateIssueType(currentIssue.id, projectTypeId);

  const comment = [
    `The issue type was automatically set to \`${RESERVED_PROJECT_ISSUE_TYPE}\`.`,
    "",
    `This repository only accepts issues with the \`${RESERVED_PROJECT_ISSUE_TYPE}\` issue type.`,
  ].join("\n");

  await gh.createComment(owner, repo, issueNumber, comment);

  return {
    enforced: true,
    operation: "corrected",
    repo: repoFullName,
    issue: issueNumber,
    currentType,
    correctedTo: RESERVED_PROJECT_ISSUE_TYPE,
  };
}

async function closeReservedProjectTypeInImplementationRepo({
  gh,
  owner,
  repo,
  repoFullName,
  issueNumber,
  action,
  currentType,
}) {
  const comment = [
    `This issue was automatically closed because the \`${RESERVED_PROJECT_ISSUE_TYPE}\` issue type is reserved for \`${ORGANIZATION}/projects\`.`,
    "",
    `Current issue type: \`${currentType}\``,
    "",
    "Use a repository-specific issue type such as Bug, Feature, Refactor, Test, Documentation, Chore, or Spike.",
  ].join("\n");

  await gh.createComment(owner, repo, issueNumber, comment);
  await gh.closeIssue(owner, repo, issueNumber, "not_planned");

  return {
    enforced: true,
    operation: "closed",
    reason: "Project issue type is reserved for projects repository",
    action,
    repo: repoFullName,
    issue: issueNumber,
    currentType,
  };
}

function detectTemplateFromIssue(body, typeMap) {
  if (!body) return null;
  const match = body.match(/^### Issue Type\r?\n\r?\n([^\r\n]+)/m);
  if (!match) return null;
  const expectedType = match[1].trim();
  const expectedTypeId = typeMap.get(expectedType);
  if (!expectedTypeId) return null;
  return { expectedType, expectedTypeId };
}

function removeIssueTypeSection(body) {
  if (!body) return "";
  // Match "### Issue Type", its value, and any trailing whitespace/newlines
  return body.replace(/^### Issue Type\r?\n\r?\n[^\r\n]+(\r?\n)*/m, "");
}

function removeScopeSection(body) {
  if (!body) return "";
  // Match "### Scope", its value, and any trailing whitespace/newlines
  return body.replace(/^### Scope\r?\n\r?\n[^\r\n]+(\r?\n)*/m, "");
}

function detectScopeFromBody(body) {
  if (!body) return null;
  const match = body.match(/^### Scope\r?\n\r?\n([^\r\n]+)/m);
  if (!match) return null;
  return match[1].trim().toLowerCase();
}

function extractScopeFromTitle(title) {
  if (!title) return null;
  const match = title.match(/^[a-zA-Z0-9_-]+\(([^)]+)\)\s*:\s*/);
  return match ? match[1].trim().toLowerCase() : null;
}

function formatTitle(currentTitle, issueType, scope) {
  const typePrefixMap = {
    "Bug": "fix",
    "Feature": "feat",
    "Refactor": "refactor",
    "Test": "test",
    "Documentation": "docs",
    "Chore": "chore",
    "Spike": "spike",
  };

  const commitType = typePrefixMap[issueType];
  if (!commitType) return currentTitle;

  const resolvedScope = scope || extractScopeFromTitle(currentTitle);
  const targetPrefix = resolvedScope ? `${commitType}(${resolvedScope}): ` : `${commitType}: `;

  const cleanTitle = currentTitle
    .replace(/^[a-zA-Z0-9_-]+(?:\([^)]*\))?\s*:\s*/, "")
    .replace(/^\[[a-zA-Z0-9_-]+\]\s*:\s*/, "")
    .trim();

  return targetPrefix + cleanTitle;
}

function extractSection(body, name) {
  if (!body) return null;
  const regex = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`);
  const match = body.match(regex);
  return match ? match[1] : null;
}

function replaceSection(body, name, newContent) {
  if (!body) return "";
  const regex = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`);
  return body.replace(regex, `<!-- ${name}:start -->${newContent}<!-- ${name}:end -->`);
}

function parseChecklist(body) {
  if (!body) return { checklist: [], startIndex: -1, endIndex: -1 };

  // First try to parse inside the <!-- managed:start --> and <!-- managed:end --> block
  const regex = /<!-- managed:start -->([\s\S]*?)<!-- managed:end -->/;
  const match = body.match(regex);
  
  if (match) {
    const checklistText = match[1];
    const startIndex = match.index + "<!-- managed:start -->".length;
    const endIndex = match.index + match[0].length - "<!-- managed:end -->".length;

    const checklist = [];
    const itemRegex = /-\s*\[([ xX])\]\s*([^\r\n]+)/g;
    let itemMatch;
    while ((itemMatch = itemRegex.exec(checklistText)) !== null) {
      const checked = itemMatch[1].toLowerCase() === "x";
      const name = itemMatch[2].trim();
      checklist.push({ checked, name, rawLine: itemMatch[0] });
    }

    return { checklist, startIndex, endIndex, heading: "## Required updates" };
  }

  // Fallback to old heading-based parsing for backward compatibility
  const headingMatch = body.match(/(?:\r?\n|^)(#+\s*Required updates)\r?\n/i);
  if (!headingMatch) return { checklist: [], startIndex: -1, endIndex: -1 };

  const heading = headingMatch[1];
  const headingIndex = body.indexOf(heading);
  const startIndex = headingIndex + heading.length;

  const remainingText = body.slice(startIndex);
  const nextSectionMatch = remainingText.match(/(?:\r?\n|^)(#+\s+[^\r\n]+)/);
  const checklistSectionLength = nextSectionMatch ? nextSectionMatch.index : remainingText.length;
  const checklistText = remainingText.slice(0, checklistSectionLength);

  const checklist = [];
  const itemRegex = /-\s*\[([ xX])\]\s*([^\r\n]+)/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(checklistText)) !== null) {
    const checked = itemMatch[1].toLowerCase() === "x";
    const name = itemMatch[2].trim();
    checklist.push({ checked, name, rawLine: itemMatch[0] });
  }

  const endIndex = startIndex + checklistSectionLength;
  return { checklist, startIndex, endIndex, heading };
}

function healChecklist(newBody, oldBody) {
  const { checklist: newChecklist, startIndex, endIndex } = parseChecklist(newBody);
  if (startIndex === -1) return newBody;

  const { checklist: oldChecklist } = parseChecklist(oldBody);
  const validNames = Object.keys(REQUIRES_WHITELIST);

  const healedChecklist = [];
  const processedNames = new Set();

  for (const item of newChecklist) {
    const matchedName = validNames.find((v) => v.toLowerCase() === item.name.toLowerCase());
    if (matchedName) {
      if (!processedNames.has(matchedName)) {
        healedChecklist.push({ name: matchedName, checked: item.checked });
        processedNames.add(matchedName);
      }
    }
  }

  for (const item of oldChecklist) {
    const matchedName = validNames.find((v) => v.toLowerCase() === item.name.toLowerCase());
    if (matchedName && !processedNames.has(matchedName)) {
      healedChecklist.push({ name: matchedName, checked: item.checked });
      processedNames.add(matchedName);
    }
  }

  let checklistText = "\n";
  for (const item of healedChecklist) {
    checklistText += `- [${item.checked ? "x" : " "}] ${item.name}\n`;
  }

  return newBody.slice(0, startIndex) + checklistText + newBody.slice(endIndex);
}

function cleanChecklistOnCreation(body) {
  const { checklist, startIndex, endIndex } = parseChecklist(body);
  if (startIndex === -1) return body;

  const validNames = Object.keys(REQUIRES_WHITELIST);
  const healedChecklist = [];
  const processedNames = new Set();

  for (const item of checklist) {
    const matchedName = validNames.find((v) => v.toLowerCase() === item.name.toLowerCase());
    // Only include items that were checked in the template form (which GitHub outputs as checked / 'x' / true)
    if (matchedName && item.checked && !processedNames.has(matchedName)) {
      // These become pending requirements (checked: false / [ ]) in the final issue body
      healedChecklist.push({ name: matchedName, checked: false });
      processedNames.add(matchedName);
    }
  }

  let checklistText = "\n";
  for (const item of healedChecklist) {
    checklistText += `- [${item.checked ? "x" : " "}] ${item.name}\n`;
  }

  return body.slice(0, startIndex) + checklistText + body.slice(endIndex);
}

function getRequiresLabelsForChecklist(checklist) {
  const desiredLabels = [];
  for (const item of checklist) {
    if (!item.checked) {
      const label = REQUIRES_WHITELIST[item.name];
      if (label) desiredLabels.push(label);
    }
  }
  return desiredLabels;
}

async function revertIssueTypeChangeInImplementationRepo({
  gh,
  owner,
  repo,
  repoFullName,
  issueNumber,
  action,
  currentIssue,
  currentType,
  isProjectType,
}) {
  const originalType = await gh.getOriginalIssueType(owner, repo, issueNumber);

  if (!originalType) {
    if (isProjectType) {
      const comment = [
        `This issue was automatically closed because the \`${RESERVED_PROJECT_ISSUE_TYPE}\` issue type is reserved for \`${ORGANIZATION}/projects\`.`,
        "",
        `Current issue type: \`${currentType}\``,
        "",
        "Use a repository-specific issue type such as Bug, Feature, Refactor, Test, Documentation, Chore, or Spike.",
      ].join("\n");

      await gh.createComment(owner, repo, issueNumber, comment);
      await gh.closeIssue(owner, repo, issueNumber, "not_planned");

      return {
        enforced: true,
        operation: "closed",
        reason: "Project issue type is reserved (no prior type change history)",
        action,
        repo: repoFullName,
        issue: issueNumber,
        currentType,
      };
    }

    return {
      enforced: false,
      reason: "no prior type change history — treating current type as original",
      action,
      repo: repoFullName,
      issue: issueNumber,
      currentType,
    };
  }

  if (currentType === originalType.name) {
    return {
      enforced: false,
      operation: "already_original_type",
      reason: "issue type already matches original type",
      action,
      repo: repoFullName,
      issue: issueNumber,
      currentType,
    };
  }

  await gh.updateIssueType(currentIssue.id, originalType.id);

  const comment = [
    `The issue type was automatically reverted to \`${originalType.name}\`.`,
    "",
    "Issue types cannot be changed after issue creation.",
  ].join("\n");

  await gh.createComment(owner, repo, issueNumber, comment);

  return {
    enforced: true,
    operation: "reverted",
    reason: "issue type changes are not allowed after creation",
    action,
    repo: repoFullName,
    issue: issueNumber,
    currentType,
    revertedTo: originalType.name,
  };
}

class GitHubClient {
  constructor(token) {
    this.token = token;
    this.baseUrl = "https://api.github.com";
    this.graphqlUrl = "https://api.github.com/graphql";
  }

  async graphql(query, variables = {}) {
    const res = await fetch(this.graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "mcf-github-automation-bot",
        "GraphQL-Features": GITHUB_GRAPHQL_FEATURES,
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
    }

    const body = JSON.parse(text);

    if (body.errors?.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
    }

    return body.data;
  }

  async rest(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "mcf-github-automation-bot",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`REST ${method} ${path} -> HTTP ${res.status}: ${text}`);
    }

    return text ? JSON.parse(text) : null;
  }

  async getIssue(owner, repo, issueNumber) {
    const data = await this.graphql(
      `query($owner: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issueNumber) {
            id
            number
            title
            body
            state
            issueType {
              id
              name
            }
            labels(first: 20) {
              nodes {
                name
              }
            }
          }
        }
      }`,
      { owner, repo, issueNumber }
    );

    if (!data.repository?.issue) {
      throw new Error(`Issue not found: ${owner}/${repo}#${issueNumber}`);
    }

    return data.repository.issue;
  }

  async updateIssueType(issueId, issueTypeId) {
    return this.graphql(
      `mutation($issueId: ID!, $issueTypeId: ID!) {
        updateIssueIssueType(input: {
          issueId: $issueId
          issueTypeId: $issueTypeId
        }) {
          issue {
            id
            issueType {
              id
              name
            }
          }
        }
      }`,
      { issueId, issueTypeId }
    );
  }

  async getOriginalIssueType(owner, repo, issueNumber) {
    const data = await this.graphql(
      `query($owner: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issueNumber) {
            timelineItems(first: 1, itemTypes: [ISSUE_TYPE_CHANGED_EVENT]) {
              nodes {
                ... on IssueTypeChangedEvent {
                  prevIssueType {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }`,
      { owner, repo, issueNumber }
    );

    const nodes = data.repository?.issue?.timelineItems?.nodes ?? [];
    return nodes[0]?.prevIssueType ?? null;
  }

  async createComment(owner, repo, issueNumber, body) {
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      { body }
    );
  }

  async closeIssue(owner, repo, issueNumber, stateReason = "not_planned") {
    return this.rest(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      {
        state: "closed",
        state_reason: stateReason,
      }
    );
  }

  async getOrgIssueTypes(orgName) {
    const data = await this.graphql(
      `query($orgName: String!) {
        organization(login: $orgName) {
          issueTypes(first: 50) {
            nodes {
              id
              name
            }
          }
        }
      }`,
      { orgName }
    );
    return data.organization?.issueTypes?.nodes ?? [];
  }

  async getOrgIssueFields(orgName) {
    const data = await this.graphql(
      `query($orgName: String!) {
        organization(login: $orgName) {
          issueFields(first: 50) {
            nodes {
              ... on IssueFieldSingleSelect {
                id
                name
                options {
                  id
                  name
                }
              }
              ... on IssueFieldText { id name }
              ... on IssueFieldNumber { id name }
              ... on IssueFieldDate { id name }
            }
          }
        }
      }`,
      { orgName }
    );
    return data.organization?.issueFields?.nodes ?? [];
  }

  async updateIssueFieldValue(issueId, fieldId, valueInput) {
    return this.graphql(
      `mutation($issueId: ID!, $issueField: IssueFieldCreateOrUpdateInput!) {
        updateIssueFieldValue(input: {
          issueId: $issueId
          issueField: $issueField
        }) {
          issue {
            id
          }
        }
      }`,
      {
        issueId,
        issueField: {
          fieldId,
          ...valueInput,
        },
      }
    );
  }

  async updateIssueTitleAndBody(owner, repo, issueNumber, title, body) {
    const update = {};
    if (title !== undefined) update.title = title;
    if (body !== undefined) update.body = body;
    return this.rest(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      update
    );
  }

  async deleteComment(owner, repo, commentId) {
    return this.rest(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`
    );
  }

  async createCommentReaction(owner, repo, commentId, content) {
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/reactions`,
      { content }
    );
  }

  async addLabels(owner, repo, issueNumber, labels) {
    if (!labels.length) return;
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`,
      { labels }
    );
  }

  async removeLabel(owner, repo, issueNumber, labelName) {
    return this.rest(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`
    );
  }
}

async function createInstallationAccessToken(env, installationId) {
  if (!env.GITHUB_APP_ID) {
    throw new Error("Missing Cloudflare variable: GITHUB_APP_ID");
  }

  if (!env.GITHUB_PRIVATE_KEY) {
    throw new Error("Missing Cloudflare secret: GITHUB_PRIVATE_KEY");
  }

  const jwt = await createGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "mcf-github-automation-bot",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    }
  );

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Failed to create installation token: HTTP ${res.status}: ${text}`);
  }

  const body = JSON.parse(text);

  if (!body.token) {
    throw new Error("GitHub installation token response did not include token");
  }

  return body.token;
}

async function createGitHubAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: String(appId),
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const cryptoKey = await importPrivateKey(privateKeyPem);

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function importPrivateKey(privateKeyPem) {
  const der = pemToDer(privateKeyPem);

  const pkcs8Der = privateKeyPem.includes("BEGIN RSA PRIVATE KEY")
    ? wrapPkcs1RsaPrivateKeyAsPkcs8(der)
    : der;

  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8Der,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );
}

function pemToDer(pem) {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s/g, "");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function wrapPkcs1RsaPrivateKeyAsPkcs8(pkcs1DerBuffer) {
  const pkcs1 = new Uint8Array(pkcs1DerBuffer);

  const version = new Uint8Array([0x02, 0x01, 0x00]);

  const rsaAlgorithmIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);

  const privateKeyOctetString = concatBytes(
    new Uint8Array([0x04]),
    derLength(pkcs1.length),
    pkcs1
  );

  const privateKeyInfoBody = concatBytes(
    version,
    rsaAlgorithmIdentifier,
    privateKeyOctetString
  );

  return concatBytes(
    new Uint8Array([0x30]),
    derLength(privateKeyInfoBody.length),
    privateKeyInfoBody
  ).buffer;
}

function derLength(length) {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }

  const bytes = [];
  let value = length;

  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }

  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...arrays) {
  const length = arrays.reduce((total, item) => total + item.length, 0);
  const output = new Uint8Array(length);

  let offset = 0;

  for (const item of arrays) {
    output.set(item, offset);
    offset += item.length;
  }

  return output;
}

async function verifyGitHubSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const receivedHex = signatureHeader.slice("sha256=".length);

  if (receivedHex.length !== 64) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const expectedBuffer = await crypto.subtle.sign("HMAC", key, rawBody);
  const expected = new Uint8Array(expectedBuffer);
  const received = hexToUint8Array(receivedHex);

  return timingSafeEqual(expected, received);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}

function hexToUint8Array(hex) {
  const bytes = new Uint8Array(hex.length / 2);

  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function normalizeRepo(repoFullName) {
  return String(repoFullName || "").trim().toLowerCase();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}