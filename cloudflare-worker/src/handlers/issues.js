import {
  PROJECTS_REPO_FULL_NAME,
  RESERVED_PROJECT_ISSUE_TYPE,
  ORGANIZATION,
  ISSUE_TYPE_CHANGE_ACTIONS
} from "../config.js";
import {
  extractSections,
  replaceSections,
  detectScopeFromBody
} from "../utils/text.js";
import {
  parseChecklist,
  healChecklist,
  cleanChecklistOnCreation,
  getRequiresLabelsForChecklist
} from "../utils/checklist.js";
import {
  buildIssueBranchName,
  ensureAutomationState,
  parseAutomationState,
  replaceAutomationState,
} from "../utils/automation-state.js";

/**
 * Enforces organizational policies on GitHub Issues when they are opened, edited, or reopened.
 * Handles issue type and scope field syncing, checklist validation, and label sync.
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
 * @param {object} params.priorityField - Single-select Priority issue field metadata
 * @param {object} params.effortField - Single-select Effort issue field metadata
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
  priorityField,
  effortField,
}) {
  const isProjectsRepo = repoFullName === PROJECTS_REPO_FULL_NAME;
  const isProjectType = currentType === RESERVED_PROJECT_ISSUE_TYPE;
  const isTypeChange = hasIssueTypeChange(action, changes);

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
      typeMap,
    });
  }

  let issueBody = currentIssue.body || "";
  let updatedBody = issueBody;
  let hasBodyChanges = false;
  let titleUpdate;
  let resolvedType = currentType;
  let issueTitleForAutomation = currentIssue.title;
  const creationTemplate = action === "opened" || action === "reopened"
    ? detectTemplateFromIssue(issueBody, typeMap)
    : null;

  // 3. Codebase repositories: Prevent "Project" (Epic) types from being assigned.
  // On creation, a form template is the stronger signal because users can change
  // the Issue Type field before submit.
  if (isProjectType && !creationTemplate) {
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

  // Extract custom field values currently set in the sidebar
  const currentSidebarScope = getCurrentSingleSelectIssueFieldValue(currentIssue, "Scope");
  const currentSidebarPriority = getCurrentSingleSelectIssueFieldValue(currentIssue, "Priority");
  const currentSidebarEffort = getCurrentSingleSelectIssueFieldValue(currentIssue, "Effort");

  // Detect scope from raw body (form submission) or fall back to sidebar / title
  let scopeValue = normalizeOptionalIssueFieldValue(detectScopeFromBody(issueBody));

  if (action === "edited" && currentSidebarScope) {
    // During edits, the sidebar field value is the source of truth.
    scopeValue = currentSidebarScope;
  } else if (!scopeValue) {
    scopeValue = currentSidebarScope || null;
  }

  // Detect priority and effort from the raw body
  let priorityValue = normalizeOptionalIssueFieldValue(detectPriorityFromBody(issueBody));

  if (action === "edited" && currentSidebarPriority) {
    priorityValue = currentSidebarPriority;
  } else if (!priorityValue) {
    priorityValue = currentSidebarPriority;
  }

  let effortValue = normalizeOptionalIssueFieldValue(detectEffortFromBody(issueBody));

  if (action === "edited" && currentSidebarEffort) {
    effortValue = currentSidebarEffort;
  } else if (!effortValue) {
    effortValue = currentSidebarEffort;
  }

  const titleChanged = action === "edited" && typeof changes?.title?.from === "string" && changes.title.from !== currentIssue.title;
  if (titleChanged) {
    const state = parseAutomationState(issueBody);
    const issueType = state?.original_issue_type || resolvedType;
    if (await branchStateBlocksTitleChange(gh, owner, repo, state, issueType, issueNumber, currentIssue.title)) {
      titleUpdate = changes.title.from;
      issueTitleForAutomation = changes.title.from;
      await gh.createComment(
        owner,
        repo,
        issueNumber,
        [
          "The issue title cannot be changed while a managed branch exists.",
          "",
          state?.allowed_branch_name ? `Managed branch: \`${state.allowed_branch_name}\`` : null,
          state?.allowed_branch_name ? "" : null,
          "Delete the existing branch with `/branch delete` before changing the title.",
          "",
          "Deleting a branch cannot be undone by automation.",
        ].filter((line) => line !== null).join("\n")
      );
    }
  }

  // 5. Handling issue creation: Extract configuration fields and clean templates.
  if (action === "opened" || action === "reopened") {
    // Correct issue type if it doesn't match the form template used.
    const template = creationTemplate;
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

    // Sanitize body: remove helper blocks (Issue Type, Scope, Priority, Effort) and clean checklist.
    let cleaned = cleanChecklistOnCreation(issueBody);
    cleaned = removeIssueTypeSection(cleaned);
    cleaned = removeScopeSection(cleaned);
    cleaned = removePrioritySection(cleaned);
    cleaned = removeEffortSection(cleaned);

    // Inject protected/editable HTML comments programmatically.
    cleaned = injectZoningComments(cleaned);
    cleaned = ensureAutomationState(cleaned, resolvedType, {
      issueNumber,
      title: issueTitleForAutomation,
    });

    if (cleaned !== issueBody) {
      updatedBody = cleaned;
      hasBodyChanges = true;
    }
  }

  // 6. Handling body edits: Prevent re-injecting helper blocks and enforce protected zones.
  if (action === "edited" && changes?.body) {
    const oldProtectedSections = extractSections(changes.body.from, "protected");
    const newProtectedSections = extractSections(issueBody, "protected");

    let finalBody = issueBody;
    // Revert edits inside <!-- protected:start/end --> blocks or full body if tags were deleted.
    if (oldProtectedSections.length) {
      if (oldProtectedSections.length !== newProtectedSections.length) {
        // If protected tags were removed, revert the entire body to the previous state.
        finalBody = changes.body.from;
      } else if (oldProtectedSections.some((section, index) => section !== newProtectedSections[index])) {
        finalBody = replaceSections(finalBody, "protected", oldProtectedSections);
      }
    }

    let healed = healChecklist(finalBody, changes.body.from);
    healed = removeIssueTypeSection(healed);
    healed = removeScopeSection(healed);
    healed = removePrioritySection(healed);
    healed = removeEffortSection(healed);
    healed = ensureAutomationState(healed, resolvedType, {
      issueNumber,
      title: issueTitleForAutomation,
    });

    if (healed !== issueBody) {
      updatedBody = healed;
      hasBodyChanges = true;
    }
  }

  if (titleChanged && titleUpdate === undefined) {
    const titleBody = updateAllowedBranchNameForIssueTitle({
      body: hasBodyChanges ? updatedBody : issueBody,
      issueType: parseAutomationState(hasBodyChanges ? updatedBody : issueBody)?.original_issue_type || resolvedType,
      issueNumber,
      title: currentIssue.title,
    });
    if (titleBody !== (hasBodyChanges ? updatedBody : issueBody)) {
      updatedBody = titleBody;
      hasBodyChanges = true;
    }
  }

  // 7. Update Issue body in GitHub if changes were made by enforcers (postponed to end).
  if (hasBodyChanges) {
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

  // 9. Sync single-select issue fields.
  const debug = {
    scope: {
      value: scopeValue,
      fieldFound: !!scopeField,
      availableOptions: scopeField?.options?.map(o => o.name) || [],
      optionFound: false,
      mutationCalled: false,
      mutationResult: null
    },
    priority: {
      value: priorityValue,
      fieldFound: !!priorityField,
      availableOptions: priorityField?.options?.map(o => o.name) || [],
      optionFound: false,
      mutationCalled: false,
      mutationResult: null
    },
    effort: {
      value: effortValue,
      fieldFound: !!effortField,
      availableOptions: effortField?.options?.map(o => o.name) || [],
      optionFound: false,
      mutationCalled: false,
      mutationResult: null
    }
  };

  await syncSingleSelectIssueField(gh, currentIssue.id, scopeField, scopeValue, debug.scope);
  await syncSingleSelectIssueField(gh, currentIssue.id, priorityField, priorityValue, debug.priority);
  await syncSingleSelectIssueField(gh, currentIssue.id, effortField, effortValue, debug.effort);

  // 10. Update body/title if changed by policy.
  if (hasBodyChanges || titleUpdate !== undefined) {
    await gh.updateIssueTitleAndBody(
      owner,
      repo,
      issueNumber,
      titleUpdate,
      hasBodyChanges ? issueBody : undefined
    );
    console.log(`Updated issue body/title policy state`);
  }

  return {
    enforced: false,
    reason: "issue processed, scope and requires checklist synced",
    action,
    repo: repoFullName,
    issue: issueNumber,
    currentType: resolvedType,
    scope: scopeValue,
    title: titleUpdate ?? currentIssue.title,
    debug,
  };
}

async function branchStateBlocksTitleChange(gh, owner, repo, state, issueType, issueNumber, currentTitle) {
  const branch = state?.branch;
  const branchExists = branch?.exists === true || branch?.linked === true || branch?.pr != null;
  const currentAllowedBranch = buildIssueBranchName({ issueType, issueNumber, title: currentTitle });
  const titleChangedFromAllowedBranch = !state?.allowed_branch_name || state.allowed_branch_name !== currentAllowedBranch;
  if (!titleChangedFromAllowedBranch) return false;
  if (branchExists) return true;
  return state?.allowed_branch_name
    ? await gitRefExists(gh, owner, repo, state.allowed_branch_name)
    : false;
}

function updateAllowedBranchNameForIssueTitle({ body, issueType, issueNumber, title }) {
  const ensuredBody = ensureAutomationState(body, issueType, { issueNumber, title });
  const state = parseAutomationState(ensuredBody);
  const allowedBranchName = buildIssueBranchName({ issueType, issueNumber, title });
  if (state?.allowed_branch_name === allowedBranchName) return ensuredBody;
  return replaceAutomationState(ensuredBody, {
    ...state,
    allowed_branch_name: allowedBranchName,
  });
}

function hasIssueTypeChange(action, changes) {
  if (!ISSUE_TYPE_CHANGE_ACTIONS.has(action)) return false;
  if (action !== "edited") return true;

  return Boolean(
    changes?.type != null ||
    changes?.issue_type != null ||
    changes?.issueType != null
  );
}

async function gitRefExists(gh, owner, repo, branchName) {
  if (typeof gh.getReference !== "function") return false;
  try {
    await gh.getReference(owner, repo, `heads/${branchName}`);
    return true;
  } catch (err) {
    if (String(err?.message || "").includes("HTTP 404")) return false;
    throw err;
  }
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
 * Removes temporary issue-type metadata from the markdown body.
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

function getCurrentSingleSelectIssueFieldValue(issue, fieldName) {
  const fieldValueNode = issue.issueFieldValues?.nodes?.find(
    (fv) => fv.field?.name === fieldName
  );
  return fieldValueNode?.name;
}

function normalizeOptionalIssueFieldValue(value) {
  if (!value) return null;

  const cleanValue = value.trim();
  const normalized = cleanValue.toLowerCase();
  if (normalized === "_no response_" || normalized === "none" || normalized === "not set" || normalized === "not_set") {
    return null;
  }

  return cleanValue;
}

async function syncSingleSelectIssueField(gh, issueId, field, value, debugState) {
  if (!value || !field) return;

  const option = field.options?.find(
    (opt) => opt.name.toLowerCase() === value.toLowerCase()
  );
  if (!option) return;

  debugState.optionFound = true;
  debugState.optionId = option.id;
  debugState.mutationCalled = true;

  try {
    const res = await gh.updateIssueFieldValue(issueId, field.id, {
      singleSelectOptionId: option.id,
    });
    debugState.mutationResult = res;
    console.log(`Updated ${field.name} Issue Field to: ${option.name}`);
  } catch (err) {
    debugState.mutationError = err.message;
    throw err;
  }
}

/**
 * Detects Priority value from the temporary "### Priority" section in the markdown body.
 */
function detectPriorityFromBody(body) {
  if (!body) return null;
  const match = body.match(/^### Priority\r?\n\r?\n([^\r\n]+)/m);
  return match ? match[1].trim() : null;
}

/**
 * Detects Effort value from the temporary "### Effort" section in the markdown body.
 */
function detectEffortFromBody(body) {
  if (!body) return null;
  const match = body.match(/^### Effort\r?\n\r?\n([^\r\n]+)/m);
  return match ? match[1].trim() : null;
}

/**
 * Removes the temporary "### Priority" section from the markdown body.
 */
function removePrioritySection(body) {
  if (!body) return "";
  return body.replace(/^### Priority\r?\n\r?\n[^\r\n]+(\r?\n)*/m, "");
}

/**
 * Removes the temporary "### Effort" section from the markdown body.
 */
function removeEffortSection(body) {
  if (!body) return "";
  return body.replace(/^### Effort\r?\n\r?\n[^\r\n]+(\r?\n)*/m, "");
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
  typeMap,
}) {
  const recordedOriginalType = parseAutomationState(currentIssue.body || "")?.original_issue_type;
  if (recordedOriginalType) {
    if (currentType === recordedOriginalType) {
      return {
        enforced: false,
        operation: "already_original_type",
        reason: "issue type already matches recorded original type",
        action,
        repo: repoFullName,
        issue: issueNumber,
        currentType,
      };
    }

    const recordedOriginalTypeId = typeMap.get(recordedOriginalType);
    if (!recordedOriginalTypeId) {
      throw new Error(`Recorded original issue type '${recordedOriginalType}' not found in organization types.`);
    }

    await gh.updateIssueType(currentIssue.id, recordedOriginalTypeId);

    const comment = [
      `The issue type was automatically reverted to \`${recordedOriginalType}\`.`,
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
      revertedTo: recordedOriginalType,
      source: "automation-state",
    };
  }

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

/**
 * Programmatically injects HTML comments to divide the issue body into protected,
 * editable, and managed zones. This is required because GitHub Form Templates (YAML)
 * discard markdown-type fields from the final issue body description.
 *
 * @param {string} body - The sanitized Markdown issue description.
 * @returns {string} The zoned issue description containing comments tags.
 */
function injectZoningComments(body) {
  if (!body) return "";

  // If the body is already zoned, do not modify it.
  if (body.includes("<!-- protected:start -->")) {
    return body;
  }

  const result = body.trim();

  // Common headers that mark the start of the editable/unprotected section
  const editableHeaders = [
    /### Logs \/ Error Output/i,
    /### Attachments/i,
    /### Workaround/i,
    /### Additional Context/i,
    /### Required updates/i,
    /<!-- managed:start -->/i
  ];

  let firstIndex = -1;

  for (const pattern of editableHeaders) {
    const match = result.match(pattern);
    if (match && match.index !== undefined) {
      if (firstIndex === -1 || match.index < firstIndex) {
        firstIndex = match.index;
      }
    }
  }

  if (firstIndex !== -1) {
    const protectedPart = result.slice(0, firstIndex).trim();
    const restPart = result.slice(firstIndex).trim();

    let editablePart = restPart;
    let managedPart = "";

    // Identify if there is a managed/checklist section at the end of the restPart
    const managedMatch = restPart.match(/<!-- managed:start -->|### Required updates/i);
    if (managedMatch && managedMatch.index !== undefined && managedMatch.index > 0) {
      editablePart = restPart.slice(0, managedMatch.index).trim();
      managedPart = restPart.slice(managedMatch.index).trim();
    }

    let zoned = "<!-- protected:start -->\n" + protectedPart + "\n<!-- protected:end -->\n\n";
    if (editablePart) {
      zoned += "<!-- editable:start -->\n" + editablePart + "\n<!-- editable:end -->\n\n";
    }
    if (managedPart) {
      zoned += managedPart;
    }

    return zoned.trim();
  }

  // If no editable or managed headers are found, protect the entire body.
  return "<!-- protected:start -->\n" + result + "\n<!-- protected:end -->";
}
