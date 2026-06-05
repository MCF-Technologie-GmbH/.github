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

/**
 * Enforces organizational policies on GitHub Issues when they are opened, edited, or reopened.
 * Handles issue type and scope immutability, title formatting, checklist validation, and label sync.
 *
 * @param {object} params
 * @param {GitHubClient} params.gh - API client wrapper
 * @param {string} params.owner - Repo owner
 * @param {string} params.repo - Repo name
 * @param {string} params.repoFullName - Normalized repository full name (owner/repo)
 * @param {number} params.issueNumber - GitHub Issue number
 * @param {string} params.action - The webhook action (e.g. opened, edited)
 * @param {object} params.currentIssue - GraphQL issue object representation
 * @param {string} params.currentType - Current GraphQL issue type name
 * @param {object} params.changes - Description of modified fields from webhook
 * @param {Map} params.typeMap - Map of issue type names to GraphQL Node IDs
 * @param {object} params.scopeField - Single-select Scope issue field metadata
 */
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

  // 1. Projects repository: Only "Project" (Epics) issues are permitted.
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

  // 2. Codebase repositories: Revert manual type changes using timeline history.
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

  // 3. Codebase repositories: Prevent "Project" (Epic) types from being assigned.
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

  // 4. Scope Immutability: Revert edits that change the scope tag in the title.
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

  // 5. Handling issue creation: Extract configuration fields and clean templates.
  if (action === "opened" || action === "reopened") {
    // Correct issue type if it doesn't match the form template used.
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

    // Sanitize body: remove helper blocks (Issue Type, Scope) and clean checklist.
    let cleaned = cleanChecklistOnCreation(issueBody);
    cleaned = removeIssueTypeSection(cleaned);
    cleaned = removeScopeSection(cleaned);
    if (cleaned !== issueBody) {
      updatedBody = cleaned;
      hasBodyChanges = true;
    }
  }

  // 6. Handling body edits: Prevent re-injecting helper blocks and enforce protected zones.
  if (action === "edited" && changes?.body) {
    const oldProtected = extractSection(changes.body.from, "protected");
    const newProtected = extractSection(issueBody, "protected");

    let finalBody = issueBody;
    // Revert edits inside <!-- protected:start/end --> blocks
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

  // 7. Update Issue body in GitHub if changes were made by enforcers.
  if (hasBodyChanges) {
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, updatedBody);
    issueBody = updatedBody;
  }

  // 8. Synchronize requirement checkbox labels (requires/*).
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

  // 9. Sync Scope single-select sidebar field (fallback to Title scope).
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

  // 10. Format Issue Title to conventional format type(scope): description.
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

/**
 * Enforces policy for the centralized Projects Epic repository.
 * Only the "Project" issue type is allowed.
 */
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

/**
 * Closes Project (Epic) type issues if created in standard codebase repositories.
 */
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

/**
 * Helper to identify the issue type requested by the YAML form template.
 */
function detectTemplateFromIssue(body, typeMap) {
  if (!body) return null;
  const match = body.match(/^### Issue Type\r?\n\r?\n([^\r\n]+)/m);
  if (!match) return null;
  const expectedType = match[1].trim();
  const expectedTypeId = typeMap.get(expectedType);
  if (!expectedTypeId) return null;
  return { expectedType, expectedTypeId };
}

/**
 * Removes the temporary "### Issue Type" section from the markdown body.
 */
function removeIssueTypeSection(body) {
  if (!body) return "";
  return body.replace(/^### Issue Type\r?\n\r?\n[^\r\n]+(\r?\n)*/m, "");
}

/**
 * Removes the temporary "### Scope" section from the markdown body.
 */
function removeScopeSection(body) {
  if (!body) return "";
  return body.replace(/^### Scope\r?\n\r?\n[^\r\n]+(\r?\n)*/m, "");
}

/**
 * Reverts manual changes to the Issue Type back to the original creation type.
 */
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

