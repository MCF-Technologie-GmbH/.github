import {
  PROJECTS_REPO_FULL_NAME,
  RESERVED_PROJECT_ISSUE_TYPE,
  ORGANIZATION,
  ISSUE_TYPE_CHANGE_ACTIONS
} from "../config.js";
import {
  extractSection,
  replaceSection,
  extractScopeFromTitle,
  detectScopeFromBody,
  formatTitle
} from "../utils/text.js";
import {
  parseChecklist,
  healChecklist,
  cleanChecklistOnCreation,
  getRequiresLabelsForChecklist
} from "../utils/checklist.js";

export async function enforceIssueTypePolicy({
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
  return body.replace(/^### Issue Type\r?\n\r?\n[^\r\n]+(\r?\n)*/m, "");
}

function removeScopeSection(body) {
  if (!body) return "";
  return body.replace(/^### Scope\r?\n\r?\n[^\r\n]+(\r?\n)*/m, "");
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
