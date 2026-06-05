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
  priorityField,
  effortField,
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

  // Extract custom field values currently set in the sidebar
  const scopeFieldValueNode = currentIssue.issueFieldValues?.nodes?.find(
    (fv) => fv.field?.name === "Scope"
  );
  const currentSidebarScope = scopeFieldValueNode?.name;

  // Detect scope from raw body (form submission) or fall back to sidebar / title
  let scopeValue = detectScopeFromBody(issueBody);
  if (scopeValue) {
    const cleanScope = scopeValue.trim().toLowerCase();
    if (cleanScope === "_no response_" || cleanScope === "none" || cleanScope === "not set" || cleanScope === "not_set") {
      scopeValue = "Not Set";
    }
  }

  if (action === "edited" && currentSidebarScope) {
    // During edits, the sidebar field value is the source of truth for the title prefix
    scopeValue = currentSidebarScope;
  } else if (!scopeValue || scopeValue === "Not Set") {
    scopeValue = scopeValue || currentSidebarScope || extractScopeFromTitle(currentIssue.title);
  }

  // Default scope to "Not Set" on creation if not specified
  if (action === "opened" || action === "reopened") {
    if (!scopeValue) scopeValue = "Not Set";
  }

  // Detect priority and effort from the raw body
  let priorityValue = detectPriorityFromBody(issueBody);
  if (priorityValue) {
    const cleanPriority = priorityValue.trim().toLowerCase();
    if (cleanPriority === "_no response_" || cleanPriority === "none" || cleanPriority === "not set" || cleanPriority === "not_set") {
      priorityValue = "Not Set";
    }
  }

  let effortValue = detectEffortFromBody(issueBody);
  if (effortValue) {
    const cleanEffort = effortValue.trim().toLowerCase();
    if (cleanEffort === "_no response_" || cleanEffort === "none" || cleanEffort === "not set" || cleanEffort === "not_set") {
      effortValue = "Not Set";
    }
  }

  // Default priority and effort to "Not Set" on creation if not specified
  if (action === "opened" || action === "reopened") {
    if (!priorityValue) priorityValue = "Not Set";
    if (!effortValue) effortValue = "Not Set";
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

    // Sanitize body: remove helper blocks (Issue Type, Scope, Priority, Effort) and clean checklist.
    let cleaned = cleanChecklistOnCreation(issueBody);
    cleaned = removeIssueTypeSection(cleaned);
    cleaned = removeScopeSection(cleaned);
    cleaned = removePrioritySection(cleaned);
    cleaned = removeEffortSection(cleaned);

    // Inject protected/editable HTML comments programmatically.
    cleaned = injectZoningComments(cleaned);

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
    // Revert edits inside <!-- protected:start/end --> blocks or full body if tags were deleted.
    if (oldProtected) {
      if (!newProtected) {
        // If protected tags were removed, revert the entire body to the previous state.
        finalBody = changes.body.from;
      } else if (oldProtected !== newProtected) {
        finalBody = replaceSection(finalBody, "protected", oldProtected);
      }
    }

    let healed = healChecklist(finalBody, changes.body.from);
    healed = removeIssueTypeSection(healed);
    healed = removeScopeSection(healed);
    healed = removePrioritySection(healed);
    healed = removeEffortSection(healed);

    if (healed !== issueBody) {
      updatedBody = healed;
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

  // 9. Sync Scope single-select sidebar field.
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

  if (scopeValue && scopeField) {
    const scopeOption = scopeField.options?.find(
      (opt) => opt.name.toLowerCase() === scopeValue.toLowerCase()
    );
    if (scopeOption) {
      debug.scope.optionFound = true;
      debug.scope.optionId = scopeOption.id;
      debug.scope.mutationCalled = true;
      try {
        const res = await gh.updateIssueFieldValue(currentIssue.id, scopeField.id, {
          singleSelectOptionId: scopeOption.id,
        });
        debug.scope.mutationResult = res;
        console.log(`Updated Scope Issue Field to: ${scopeOption.name}`);
      } catch (err) {
        debug.scope.mutationError = err.message;
        throw err;
      }
    }
  }

  // Sync Priority single-select sidebar field.
  if (priorityValue && priorityField) {
    const priorityOption = priorityField.options?.find(
      (opt) => opt.name.toLowerCase() === priorityValue.toLowerCase()
    );
    if (priorityOption) {
      debug.priority.optionFound = true;
      debug.priority.optionId = priorityOption.id;
      debug.priority.mutationCalled = true;
      try {
        const res = await gh.updateIssueFieldValue(currentIssue.id, priorityField.id, {
          singleSelectOptionId: priorityOption.id,
        });
        debug.priority.mutationResult = res;
        console.log(`Updated Priority Issue Field to: ${priorityOption.name}`);
      } catch (err) {
        debug.priority.mutationError = err.message;
        throw err;
      }
    }
  }

  // Sync Effort single-select sidebar field.
  if (effortValue && effortField) {
    const effortOption = effortField.options?.find(
      (opt) => opt.name.toLowerCase() === effortValue.toLowerCase()
    );
    if (effortOption) {
      debug.effort.optionFound = true;
      debug.effort.optionId = effortOption.id;
      debug.effort.mutationCalled = true;
      try {
        const res = await gh.updateIssueFieldValue(currentIssue.id, effortField.id, {
          singleSelectOptionId: effortOption.id,
        });
        debug.effort.mutationResult = res;
        console.log(`Updated Effort Issue Field to: ${effortOption.name}`);
      } catch (err) {
        debug.effort.mutationError = err.message;
        throw err;
      }
    }
  }

  // 10. Format Issue Title to conventional format type(scope): description, and update title and body in a single PATCH call.
  const formattedTitle = formatTitle(currentIssue.title, resolvedType, scopeValue);
  const hasTitleChanges = formattedTitle !== currentIssue.title;

  if (hasBodyChanges || hasTitleChanges) {
    await gh.updateIssueTitleAndBody(
      owner,
      repo,
      issueNumber,
      hasTitleChanges ? formattedTitle : undefined,
      hasBodyChanges ? issueBody : undefined
    );
    if (hasTitleChanges) console.log(`Re-formatted issue title to: ${formattedTitle}`);
    if (hasBodyChanges) console.log(`Sanitized issue body and injected zoning comments`);
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
    debug,
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

