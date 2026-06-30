import { GITHUB_APP_BOT_LOGIN } from "../config.js";
import {
  buildIssueBranchName,
  buildIssuePullRequestTitle,
  ensureAutomationState,
  extractIssueNumberFromBranch,
  parseAutomationState,
  removeManagedBranchBodyLink,
  replaceAutomationState,
  setManagedBranchBodyLink,
} from "../utils/automation-state.js";

const BASE_BRANCH = "dev";

/**
 * Handles the /branch create issue comment command.
 *
 * @param {object} params
 * @param {GitHubClient} params.gh
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.issueNumber
 * @param {object} params.comment
 * @returns {Promise<object>}
 */
export async function handleBranchCommand({ gh, owner, repo, issueNumber, comment }) {
  let currentIssue = await gh.getIssue(owner, repo, issueNumber);
  const issueType = currentIssue.issueType?.name || "issue";
  const branchName = buildIssueBranchName({
    issueType,
    issueNumber,
    title: currentIssue.title,
  });

  let issueBody = ensureAutomationState(currentIssue.body || "", issueType, {
    issueNumber,
    title: currentIssue.title,
  });
  let state = parseAutomationState(issueBody);

  if (issueBody !== (currentIssue.body || "")) {
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, issueBody);
  }

  currentIssue = (await cleanupStaleLinkedBranchRecords({ gh, owner, repo, issueNumber, issue: currentIssue })).issue;
  ({ issue: currentIssue, issueBody, state } = await syncIssueBranchMetadata({
    gh,
    owner,
    repo,
    issueNumber,
    issue: currentIssue,
    issueBody,
    state,
    expectedBranchName: branchName,
    checkExpectedRefOnly: true,
  }));

  const branchStatus = await inspectIssueBranchState({
    gh,
    owner,
    repo,
    issue: currentIssue,
    issueNumber,
    expectedBranchName: branchName,
    state,
    checkExpectedRefOnly: true,
  });
  const blockingMessage = branchStateBlockingMessage(branchStatus);
  if (blockingMessage) {
    await gh.createComment(owner, repo, issueNumber, blockingMessage);
    return { processed: true, command: "branch", created: false, reason: branchStatus.reason };
  }

  const allowedBranchName = state?.allowed_branch_name;

  if (allowedBranchName && allowedBranchName !== branchName) {
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "This issue already has an assigned branch:",
        "",
        `\`${allowedBranchName}\``,
        "",
        "A second branch cannot be created for the same issue.",
      ].join("\n")
    );
    return { processed: true, command: "branch", created: false, reason: "issue already has another branch" };
  }

  const canRecreateRecordedBranch =
    allowedBranchName === branchName &&
    isStaleBranchState(currentIssue, allowedBranchName) &&
    branchStatus.metadataRef.exists === false;

  if (allowedBranchName && state?.branch?.exists === true && isStaleBranchState(currentIssue, allowedBranchName) && !canRecreateRecordedBranch) {
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "The expected branch exists, but GitHub no longer reports it as linked to this issue.",
        "",
        "Expected branch:",
        "",
        `\`${allowedBranchName}\``,
        "",
        "Run `/branch repair` to relink it.",
        "Run `/branch delete` only if you want to permanently delete it. This cannot be undone.",
      ].join("\n")
    );
    return { processed: true, command: "branch", created: false, reason: "branch metadata needs repair" };
  }

  if (state?.branch?.exists === true && !canRecreateRecordedBranch) {
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "This issue already has an authorized branch:",
        "",
        `\`${allowedBranchName || branchName}\``,
      ].join("\n")
    );
    return { processed: true, command: "branch", created: false, reason: "branch already exists" };
  }

  const reservedState = {
    ...state,
    allowed_branch_name: branchName,
    branch: {
      exists: false,
      linked: false,
      error: null,
      pr: state?.branch?.pr ?? null,
    },
  };

  issueBody = replaceAutomationState(issueBody, reservedState);
  await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, issueBody);

  const reloadedIssue = await gh.getIssue(owner, repo, issueNumber);
  const reloadedState = parseAutomationState(reloadedIssue.body || "");
  if (reloadedState?.allowed_branch_name !== branchName || reloadedState.branch?.exists === true) {
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      "The branch reservation changed while processing `/branch create`. Please retry."
    );
    return { processed: true, command: "branch", created: false, reason: "reservation changed" };
  }

  try {
    const baseRef = await gh.getReference(owner, repo, `heads/${BASE_BRANCH}`);
    const baseOid = baseRef?.object?.sha;
    if (!baseOid) {
      throw new Error(`Base branch ${BASE_BRANCH} did not return a commit SHA.`);
    }

    await gh.createLinkedBranch({
      issueId: currentIssue.id,
      repositoryId: currentIssue.repository?.id,
      branchName,
      baseOid,
    });

    const linkedState = {
      ...reservedState,
      branch: {
        ...reservedState.branch,
        exists: true,
        linked: true,
        error: null,
      },
    };
    const linkedIssueBody = replaceAutomationState(reloadedIssue.body || issueBody, linkedState);
    await gh.updateIssueTitleAndBody(
      owner,
      repo,
      issueNumber,
      undefined,
      linkedIssueBody
    );

    const createdState = {
      ...linkedState,
      branch: {
        ...linkedState.branch,
        error: null,
        pr: linkedState.branch.pr,
      },
    };
    await gh.updateIssueTitleAndBody(
      owner,
      repo,
      issueNumber,
      undefined,
      replaceAutomationState(linkedIssueBody, createdState)
    );

    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "Created linked branch:",
        "",
        `\`${branchName}\``,
        "",
        `Base: \`${BASE_BRANCH}\``,
        "",
        "A draft PR will be created automatically after the first push with commits.",
      ].join("\n")
    );

    return {
      processed: true,
      command: "branch",
      created: true,
      branch: branchName,
      prCreated: false,
      pr: linkedState.branch.pr,
    };
  } catch (err) {
    const failedState = {
      ...reservedState,
      branch: {
        ...reservedState.branch,
        exists: false,
        linked: false,
        error: summarizeError(err),
      },
    };

    const latestIssue = await gh.getIssue(owner, repo, issueNumber);
    await gh.updateIssueTitleAndBody(
      owner,
      repo,
      issueNumber,
      undefined,
      replaceAutomationState(latestIssue.body || issueBody, failedState)
    );

    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "I could not create the linked branch.",
        "",
        `Branch: \`${branchName}\``,
        `Base: \`${BASE_BRANCH}\``,
        "",
        "The same branch can be retried with `/branch create` after the error is fixed.",
        "",
        "```text",
        failedState.branch.error,
        "```",
      ].join("\n")
    );

    return {
      processed: true,
      command: "branch",
      created: false,
      branch: branchName,
      reason: "linked branch creation failed",
    };
  }
}

/**
 * Repairs branch metadata when the linked branch relationship was removed.
 *
 * @param {object} params
 * @param {GitHubClient} params.gh
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.issueNumber
 * @returns {Promise<object>}
 */
export async function handleBranchRepairCommand({ gh, owner, repo, issueNumber }) {
  let currentIssue = await gh.getIssue(owner, repo, issueNumber);
  const issueType = currentIssue.issueType?.name || "issue";
  let issueBody = ensureAutomationState(currentIssue.body || "", issueType, {
    issueNumber,
    title: currentIssue.title,
  });
  let state = parseAutomationState(issueBody);
  const branchName = state?.branch ? state.allowed_branch_name : null;
  const expectedBranchName = buildIssueBranchName({
    issueType,
    issueNumber,
    title: currentIssue.title,
  });

  if (issueBody !== (currentIssue.body || "")) {
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, issueBody);
  }

  const staleCleanup = await cleanupStaleLinkedBranchRecords({ gh, owner, repo, issueNumber, issue: currentIssue });
  currentIssue = staleCleanup.issue;
  ({ issue: currentIssue, issueBody, state } = await syncIssueBranchMetadata({
    gh,
    owner,
    repo,
    issueNumber,
    issue: currentIssue,
    issueBody,
    state,
    expectedBranchName: branchName || expectedBranchName,
  }));

  let branchStatus = await inspectIssueBranchState({
    gh,
    owner,
    repo,
    issue: currentIssue,
    issueNumber,
    expectedBranchName: branchName || expectedBranchName,
    state,
  });
  let blockingMessage = branchStateBlockingMessage(branchStatus);

  if (!branchName) {
    if (staleCleanup.deletedCount > 0) {
      await gh.createComment(
        owner,
        repo,
        issueNumber,
        [
          "Cleaned up stale linked branch records.",
          "",
          `Removed records: \`${staleCleanup.deletedCount}\``,
          "",
          "No allowed branch metadata remains for this issue. You can now create the branch again.",
        ].join("\n")
      );
      return {
        processed: true,
        command: "branch repair",
        repaired: true,
        cleaned: true,
        deletedLinkedBranches: staleCleanup.deletedCount,
      };
    }

    if (blockingMessage) {
      await gh.createComment(owner, repo, issueNumber, blockingMessage);
      return { processed: true, command: "branch repair", repaired: false, reason: branchStatus.reason };
    }

    await gh.createComment(owner, repo, issueNumber, "Nothing to repair: this issue does not have branch metadata.");
    return { processed: true, command: "branch repair", repaired: false, reason: "no branch metadata" };
  }

  branchStatus = await inspectIssueBranchState({
    gh,
    owner,
    repo,
    issue: currentIssue,
    issueNumber,
    expectedBranchName: branchName,
    state,
  });
  blockingMessage = branchStateBlockingMessage(branchStatus);
  if (blockingMessage) {
    const failedState = {
      ...state,
      branch: {
        ...state.branch,
        exists: branchStatus.metadataRef.exists,
        linked: branchStatus.metadataLinked,
        error: branchStatus.message,
      },
    };
    await gh.updateIssueTitleAndBody(
      owner,
      repo,
      issueNumber,
      undefined,
      replaceAutomationState(issueBody, failedState)
    );
    await gh.createComment(owner, repo, issueNumber, blockingMessage);
    return { processed: true, command: "branch repair", repaired: false, reason: branchStatus.reason };
  }

  if (branchStatus.metadataLinked && branchStatus.metadataRef.exists) {
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "No repair needed: the expected branch is already linked.",
        "",
        `Branch: \`${branchName}\``,
      ].join("\n")
    );
    return { processed: true, command: "branch repair", repaired: false, reason: "branch already linked" };
  }

  let branchRef;
  try {
    branchRef = await gh.getReference(owner, repo, `heads/${branchName}`);
  } catch (err) {
    if (!String(err?.message || "").includes("HTTP 404")) {
      throw err;
    }

    state = {
      ...state,
      branch: {
        exists: false,
        linked: false,
        error: null,
        pr: state?.branch?.pr ?? null,
      },
    };
    issueBody = replaceAutomationState(issueBody, state);
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, issueBody);
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "Nothing to repair: the expected branch does not exist.",
        "",
        "Marked the branch state as missing so `/branch create` can be used again.",
        "",
        `Expected branch: \`${branchName}\``,
      ].join("\n")
    );

    return {
      processed: true,
      command: "branch repair",
      repaired: false,
      reset: true,
      reason: "expected branch does not exist",
    };
  }

  const branchOid = branchRef?.object?.sha;
  if (!branchOid) {
    throw new Error(`Expected branch ${branchName} did not return a commit SHA.`);
  }

  const temporaryBranchName = buildTemporaryBranchName(branchName);

  try {
    await gh.createReference(owner, repo, `refs/heads/${temporaryBranchName}`, branchOid);
    await gh.deleteReference(owner, repo, `heads/${branchName}`);
    currentIssue = (await cleanupStaleLinkedBranchRecords({
      gh,
      owner,
      repo,
      issueNumber,
      issue: await gh.getIssue(owner, repo, issueNumber),
    })).issue;
    const linkedBranchResult = await gh.createLinkedBranch({
      issueId: currentIssue.id,
      repositoryId: currentIssue.repository?.id,
      branchName,
      baseOid: branchOid,
    });

    const linkedBranch = linkedBranchResult?.createLinkedBranch?.linkedBranch;
    const linkedBranchName = linkedBranch?.ref?.name;
    if (linkedBranchName && linkedBranchName !== branchName) {
      throw new Error("GitHub created the branch ref but did not report it as a linked branch for this issue.");
    }

    if (!linkedBranchName) {
      const repairedIssue = await waitForLinkedBranch(gh, owner, repo, issueNumber, branchName);
      if (!isIssueLinkedBranch(repairedIssue, branchName)) {
        throw new Error("GitHub created the branch ref but did not report it as a linked branch for this issue.");
      }
    }

    await deleteReferenceIfExists(gh, owner, repo, `heads/${temporaryBranchName}`);
  } catch (err) {
    const originalRefInfo = await getBranchRefInfo(gh, owner, repo, branchName);
    if (originalRefInfo.exists) {
      await deleteReferenceIfExists(gh, owner, repo, `heads/${temporaryBranchName}`);
    }

    const failedState = {
      ...state,
      branch: {
        ...state.branch,
        exists: originalRefInfo.exists,
        linked: false,
        error: summarizeError(err),
      },
    };
    await gh.updateIssueTitleAndBody(
      owner,
      repo,
      issueNumber,
      undefined,
      replaceAutomationState(issueBody, failedState)
    );
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "I could not repair the linked branch relationship.",
        "",
        `Branch: \`${branchName}\``,
        `Temporary branch: \`${temporaryBranchName}\``,
        "",
        originalRefInfo.exists
          ? "The original branch ref exists again, so the temporary backup branch was removed."
          : "The original branch ref was not recreated. If the temporary branch still exists, the previous branch contents were preserved there.",
        "",
        "```text",
        failedState.branch.error,
        "```",
      ].join("\n")
    );

    return {
      processed: true,
      command: "branch repair",
      repaired: false,
      reason: "linked branch repair failed",
      temporaryBranch: temporaryBranchName,
    };
  }

  const repairedState = {
    ...state,
    branch: {
      ...state.branch,
      exists: true,
      linked: true,
      error: null,
    },
  };
  await gh.updateIssueTitleAndBody(
    owner,
    repo,
    issueNumber,
    undefined,
    replaceAutomationState(issueBody, repairedState)
  );
  await gh.createComment(
    owner,
    repo,
    issueNumber,
    [
      "Relinked branch successfully.",
      "",
      `Branch: \`${branchName}\``,
    ].join("\n")
  );

  return {
    processed: true,
    command: "branch repair",
    repaired: true,
    branch: branchName,
    temporaryBranch: temporaryBranchName,
  };
}

/**
 * Deletes the branch managed for an issue and marks branch metadata as missing.
 *
 * @param {object} params
 * @param {GitHubClient} params.gh
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.issueNumber
 * @returns {Promise<object>}
 */
export async function handleBranchDeleteCommand({ gh, owner, repo, issueNumber }) {
  let currentIssue = await gh.getIssue(owner, repo, issueNumber);
  const issueType = currentIssue.issueType?.name || "issue";
  let issueBody = ensureAutomationState(currentIssue.body || "", issueType, {
    issueNumber,
    title: currentIssue.title,
  });
  let state = parseAutomationState(issueBody);
  const branchName = state?.allowed_branch_name || null;

  if (issueBody !== (currentIssue.body || "")) {
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, issueBody);
  }

  currentIssue = (await cleanupStaleLinkedBranchRecords({ gh, owner, repo, issueNumber, issue: currentIssue })).issue;
  ({ issue: currentIssue, issueBody, state } = await syncIssueBranchMetadata({
    gh,
    owner,
    repo,
    issueNumber,
    issue: currentIssue,
    issueBody,
    state,
    expectedBranchName: branchName,
  }));

  if (!branchName) {
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      "Nothing to delete: this issue does not have branch metadata."
    );
    return { processed: true, command: "branch delete", deleted: false, reason: "no branch metadata" };
  }

  const linkedBranchName = linkedBranchNames(currentIssue)[0] || null;
  const branchToDelete = linkedBranchName || branchName;
  const associatedPr = state?.branch?.pr ? await getOpenPullRequestOrNull(gh, owner, repo, state.branch.pr) : null;
  if (associatedPr) {
    state = {
      ...state,
      branch: {
        ...state.branch,
        error: null,
        pr: null,
      },
    };
    issueBody = replaceAutomationState(issueBody, state);
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, issueBody);
    await closePullRequestForBranchDeletion({ gh, owner, repo, issueNumber, prNumber: associatedPr.number, branchName: branchToDelete });
  }
  const refInfo = await getBranchRefInfo(gh, owner, repo, branchToDelete);
  if (refInfo.exists) {
    await gh.deleteReference(owner, repo, `heads/${branchToDelete}`);
  }

  const afterDeleteIssue = await gh.getIssue(owner, repo, issueNumber);
  const staleCleanup = await cleanupStaleLinkedBranchRecords({ gh, owner, repo, issueNumber, issue: afterDeleteIssue });

  state = {
    ...state,
    branch: {
      exists: false,
      linked: false,
      error: null,
      pr: null,
    },
  };
  issueBody = removeManagedBranchBodyLink(replaceAutomationState(afterDeleteIssue.body || issueBody, state));
  await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, issueBody);

  await gh.createComment(
    owner,
    repo,
    issueNumber,
    [
      refInfo.exists
        ? "Deleted the branch managed for this issue."
        : "The managed branch did not exist, so I only reset the branch metadata.",
      "",
      `Branch: \`${branchToDelete}\``,
      associatedPr ? "" : null,
      associatedPr ? `Closed associated PR: #${associatedPr.number}` : null,
      "",
      "This cannot be undone by automation.",
    ].filter((line) => line !== null).join("\n")
  );

  return {
    processed: true,
    command: "branch delete",
    deleted: refInfo.exists === true,
    branch: branchToDelete,
    prClosed: associatedPr?.number || null,
    cleanedLinkedBranches: staleCleanup.deletedCount,
  };
}

/**
 * Enforces that branches are created only by the automation bot through /branch create.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function handleCreateEvent({ gh, owner, repo, payload }) {
  if (payload.ref_type !== "branch") {
    return { processed: false, reason: `create ref_type=${payload.ref_type}` };
  }

  const branchName = payload.ref;
  const issueNumber = extractIssueNumberFromBranch(branchName);

  let state = null;
  let issue = null;
  if (issueNumber) {
    try {
      issue = await gh.getIssue(owner, repo, issueNumber);
      issue = (await cleanupStaleLinkedBranchRecords({ gh, owner, repo, issueNumber, issue })).issue;
      state = parseAutomationState(issue.body || "");
    } catch (err) {
      console.error(`Failed to read issue #${issueNumber} for branch authorization: ${err.message}`);
    }
  }

  const isReservedBranch = state?.allowed_branch_name === branchName;
  const isAutomationBot = payload.sender?.login === GITHUB_APP_BOT_LOGIN;

  if (isAutomationBot && isTemporaryRepairBranch(branchName)) {
    return { processed: true, allowed: true, reason: "temporary repair branch created by automation bot" };
  }

  if (isAutomationBot && isReservedBranch) {
    return { processed: true, allowed: true, reason: "branch created by automation bot with matching reservation" };
  }

  const restoreResult = issue
    ? await handleRestoredPullRequestBranch({ gh, owner, repo, payload, issue, issueNumber, branchName, state })
    : null;
  if (restoreResult) {
    return restoreResult;
  }

  if (issue && isIssueLinkedBranch(issue, branchName)) {
    const issueType = issue.issueType?.name || "issue";
    const expectedBranchName = buildIssueBranchName({
      issueType,
      issueNumber,
      title: issue.title,
    });
    const otherLinkedBranchNames = linkedBranchNames(issue).filter((name) => name !== branchName);
    if (branchName !== expectedBranchName) {
      await gh.deleteReference(owner, repo, `heads/${branchName}`);
      await createBranchEventComment(
        gh,
        owner,
        repo,
        issueNumber,
        payload,
        "/branch manual",
        otherLinkedBranchNames.length
          ? branchStateBlockingMessage({
            reason: "unexpected linked branch",
            unexpectedLinkedNames: otherLinkedBranchNames,
          })
          : invalidManualBranchNameMessage({ expectedBranchName, branchName })
      );

      return {
        processed: true,
        allowed: false,
        deleted: true,
        branch: branchName,
        issue: issueNumber,
        reason: otherLinkedBranchNames.length ? "unexpected linked branch" : "invalid manual branch name",
      };
    }

    const isFromDev = await branchMatchesBase(gh, owner, repo, branchName, BASE_BRANCH);
    const branchStatus = await inspectIssueBranchState({
      gh,
      owner,
      repo,
      issue,
      issueNumber,
      expectedBranchName,
      state,
      skipRefs: [branchName],
    });
    const blockingMessage = branchStateBlockingMessage(branchStatus, { allowCurrentCreatedBranch: branchName });
    if (blockingMessage) {
      await gh.deleteReference(owner, repo, `heads/${branchName}`);
      await createBranchEventComment(gh, owner, repo, issueNumber, payload, "/branch manual", blockingMessage);
      return {
        processed: true,
        allowed: false,
        deleted: true,
        branch: branchName,
        issue: issueNumber,
        reason: branchStatus.reason,
      };
    }

    if (isFromDev && branchName === expectedBranchName && state?.allowed_branch_name && state.allowed_branch_name !== branchName) {
      await gh.deleteReference(owner, repo, `heads/${branchName}`);
      await createBranchEventComment(
        gh,
        owner,
        repo,
        issueNumber,
        payload,
        "/branch manual",
        [
          `Deleted manually linked branch \`${branchName}\`.`,
          "",
          "This issue already has expected branch metadata:",
          "",
          `\`${state.allowed_branch_name}\``,
          "",
          "Run `/branch repair` before creating or linking a different branch manually.",
        ].join("\n")
      );

      return {
        processed: true,
        allowed: false,
        deleted: true,
        branch: branchName,
        issue: issueNumber,
        reason: "issue branch metadata points to another branch",
      };
    }

    if (isFromDev && branchName === expectedBranchName) {
      const body = ensureAutomationState(issue.body || "", issueType, {
        issueNumber,
        title: issue.title,
      });
      const linkedState = {
        ...state,
        allowed_branch_name: branchName,
        branch: {
          exists: true,
          linked: true,
          error: null,
          pr: state?.branch?.pr ?? null,
        },
      };
      const linkedBody = replaceAutomationState(body, linkedState);
      await gh.updateIssueTitleAndBody(
        owner,
        repo,
        issueNumber,
        undefined,
        linkedBody
      );

      const updatedState = {
        ...linkedState,
        branch: {
          ...linkedState.branch,
          error: null,
          pr: linkedState.branch.pr,
        },
      };

      await gh.updateIssueTitleAndBody(
        owner,
        repo,
        issueNumber,
        undefined,
        replaceAutomationState(linkedBody, updatedState)
      );

      await createBranchEventComment(
        gh,
        owner,
        repo,
        issueNumber,
        payload,
        "/branch manual",
        [
          state?.allowed_branch_name === branchName
            ? "Branch manually linked and metadata repaired successfully."
            : "Branch linked and recorded successfully.",
          "",
          `Branch: \`${branchName}\``,
          `Base: \`${BASE_BRANCH}\``,
          "A draft PR will be created automatically after the first push with commits.",
          "",
          "Created from GitHub's sidebar and accepted by automation.",
        ].join("\n")
      );

      return {
        processed: true,
        allowed: true,
        branch: branchName,
        issue: issueNumber,
        prCreated: false,
        pr: linkedState.branch.pr,
        reason: "branch is linked to issue and based on dev",
      };
    }
  }

  await gh.deleteReference(owner, repo, `heads/${branchName}`);

  if (issueNumber) {
    try {
      const expectedBranchName = issue
        ? buildIssueBranchName({
          issueType: issue.issueType?.name || "issue",
          issueNumber,
          title: issue.title,
        })
        : null;
      const invalidBranchNameMessage = expectedBranchName && branchName !== expectedBranchName
        ? invalidManualBranchNameMessage({ expectedBranchName, branchName })
        : null;
      await createBranchEventComment(
        gh,
        owner,
        repo,
        issueNumber,
        payload,
        "/branch manual",
        invalidBranchNameMessage || [
          `Deleted branch \`${branchName}\` because it was not accepted by automation.`,
          "",
          "Prefer `/branch create` for managed issue branches, or use the GitHub sidebar only when the generated branch name matches the issue convention and no branch is already managed.",
        ].join("\n")
      );
    } catch (err) {
      console.error(`Failed to comment after deleting unauthorized branch: ${err.message}`);
    }
  }

  return { processed: true, allowed: false, deleted: true, branch: branchName, issue: issueNumber };
}

async function handleRestoredPullRequestBranch({ gh, owner, repo, payload, issue, issueNumber, branchName, state }) {
  if (state?.branch?.pr) return null;
  if (typeof gh.listPullRequests !== "function") return null;

  const issueType = issue.issueType?.name || state?.original_issue_type || "issue";
  const expectedBranchName = buildIssueBranchName({
    issueType,
    issueNumber,
    title: issue.title,
  });
  if (branchName !== expectedBranchName) return null;

  const closedPullRequests = await gh.listPullRequests(owner, repo, {
    state: "closed",
    head: `${owner}:${branchName}`,
    sort: "updated",
    direction: "desc",
    perPage: 10,
  });
  const restoredFromPr = (closedPullRequests || []).find((pr) => pullRequestMatchesIssue(pr, issueNumber, branchName));
  if (!restoredFromPr) return null;

  const body = ensureAutomationState(issue.body || "", issueType, {
    issueNumber,
    title: issue.title,
  });
  let activePr = null;
  let reopened = false;
  let reopenError = null;

  try {
    activePr = {
      ...restoredFromPr,
      ...(await gh.reopenPullRequest(owner, repo, restoredFromPr.number)),
      number: restoredFromPr.number,
    };
    reopened = true;
    await normalizePullRequestForIssue({
      gh,
      owner,
      repo,
      pr: activePr,
      issue,
      issueNumber,
      issueType,
      branchName,
    });
  } catch (err) {
    reopenError = err;
  }

  if (!activePr) {
    activePr = await createDraftPullRequestForIssue({
      gh,
      owner,
      repo,
      issueNumber,
      issueType,
      issueTitle: issue.title,
      branchName,
    });
    if (activePr.skipped) {
      const failedState = {
        ...state,
        allowed_branch_name: branchName,
        branch: {
          exists: true,
          linked: true,
          error: `Restored branch but could not create a draft PR: ${activePr.reason}`,
          pr: null,
        },
      };
      await gh.updateIssueTitleAndBody(
        owner,
        repo,
        issueNumber,
        undefined,
        setManagedBranchBodyLink(replaceAutomationState(body, failedState), { owner, repo, branchName })
      );
      await createBranchEventComment(
        gh,
        owner,
        repo,
        issueNumber,
        payload,
        "/branch restore",
        [
          "Restored the managed branch from a closed PR, but I could not create a new draft PR.",
          "",
          `Branch: \`${branchName}\``,
          `Previous PR: #${restoredFromPr.number}`,
          `Reason: ${activePr.reason}`,
        ].join("\n")
      );
      return {
        processed: true,
        allowed: true,
        restored: true,
        branch: branchName,
        issue: issueNumber,
        pr: null,
        reason: activePr.reason,
      };
    }
    await gh.createComment(
      owner,
      repo,
      restoredFromPr.number,
      [
        "This branch was restored, but this PR could not be reopened.",
        "",
        `A new draft PR was created instead: #${activePr.number}`,
      ].join("\n")
    );
  }

  const restoredState = {
    ...state,
    allowed_branch_name: branchName,
    branch: {
      exists: true,
      linked: true,
      error: null,
      pr: activePr.number,
    },
  };
  await gh.updateIssueTitleAndBody(
    owner,
    repo,
    issueNumber,
    undefined,
    setManagedBranchBodyLink(replaceAutomationState(body, restoredState), { owner, repo, branchName })
  );

  if (reopened) {
    await createBranchEventComment(
      gh,
      owner,
      repo,
      issueNumber,
      payload,
      "/branch restore",
      [
        "Restored the managed branch from a closed PR and reopened the PR.",
        "",
        `Branch: \`${branchName}\``,
        `PR: #${activePr.number}`,
      ].join("\n")
    );
    await gh.createComment(
      owner,
      repo,
      restoredFromPr.number,
      [
        "This PR was reopened after its branch was restored.",
        "",
        `Branch: \`${branchName}\``,
        `Issue: #${issueNumber}`,
      ].join("\n")
    );
  } else {
    await createBranchEventComment(
      gh,
      owner,
      repo,
      issueNumber,
      payload,
      "/branch restore",
      [
        "Restored the managed branch from a closed PR.",
        "",
        `Branch: \`${branchName}\``,
        `Previous PR: #${restoredFromPr.number}`,
        `New draft PR: #${activePr.number}`,
      ].join("\n")
    );
  }

  await notifyClosedPullRequestsBlockedByActiveBranch({
    gh,
    owner,
    repo,
    branchName,
    activePrNumber: activePr.number,
    ignorePullNumber: restoredFromPr.number,
    closedPullRequests,
  });

  return {
    processed: true,
    allowed: true,
    restored: true,
    reopened,
    branch: branchName,
    issue: issueNumber,
    pr: activePr.number,
    previousPr: restoredFromPr.number,
    reopenError: reopenError ? summarizeError(reopenError) : null,
    reason: reopened ? "restored branch and reopened pull request" : "restored branch and created new draft pull request",
  };
}

/**
 * Creates the draft pull request after the first real push to an authorized issue branch.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function handlePushEvent({ gh, owner, repo, payload }) {
  const ref = payload.ref || "";
  if (!ref.startsWith("refs/heads/")) {
    return { processed: false, reason: `push ref=${ref || "unknown"}` };
  }

  if (payload.deleted) {
    return { processed: false, reason: "push deleted branch" };
  }

  if (payload.created) {
    return { processed: false, reason: "push created branch" };
  }

  const branchName = ref.slice("refs/heads/".length);
  const issueNumber = extractIssueNumberFromBranch(branchName);
  if (!issueNumber) {
    return { processed: false, reason: "push branch is not issue-managed" };
  }

  let issue = await gh.getIssue(owner, repo, issueNumber);
  issue = (await cleanupStaleLinkedBranchRecords({ gh, owner, repo, issueNumber, issue })).issue;

  const issueType = issue.issueType?.name || "issue";
  const expectedBranchName = buildIssueBranchName({
    issueType,
    issueNumber,
    title: issue.title,
  });
  const state = parseAutomationState(issue.body || "");
  const branchStatus = await inspectIssueBranchState({
    gh,
    owner,
    repo,
    issue,
    issueNumber,
    expectedBranchName,
    state,
  });
  const blockingMessage = branchStateBlockingMessage(branchStatus);
  if (blockingMessage) {
    await createBranchEventComment(gh, owner, repo, issueNumber, payload, "/branch push", blockingMessage);
    return {
      processed: true,
      prCreated: false,
      branch: branchName,
      issue: issueNumber,
      reason: branchStatus.reason,
    };
  }

  if (
    branchName !== expectedBranchName ||
    state?.allowed_branch_name !== branchName ||
    state?.branch?.exists !== true ||
    state?.branch?.linked !== true ||
    !branchStatus.metadataLinked ||
    !branchStatus.metadataRef.exists
  ) {
    await createBranchEventComment(
      gh,
      owner,
      repo,
      issueNumber,
      payload,
      "/branch push",
      [
        "I did not create a draft PR for this push because the branch is not registered as the authorized linked branch for the issue.",
        "",
        `Pushed branch: \`${branchName}\``,
        `Expected branch: \`${expectedBranchName}\``,
        `Expected metadata branch: \`${state?.allowed_branch_name || "none"}\``,
        "",
        "Run `/branch repair` if the branch should be managed by automation.",
      ].join("\n")
    );
    return {
      processed: true,
      prCreated: false,
      branch: branchName,
      issue: issueNumber,
      reason: "push branch is not authorized for issue",
    };
  }

  if (state.branch.pr) {
    return {
      processed: true,
      prCreated: false,
      branch: branchName,
      issue: issueNumber,
      pr: state.branch.pr,
      reason: "draft pull request already recorded",
    };
  }

  let draftPr;
  try {
    draftPr = await createDraftPullRequestForIssue({
      gh,
      owner,
      repo,
      issueNumber,
      issueType,
      issueTitle: issue.title,
      branchName,
    });
  } catch (err) {
    const failedState = {
      ...state,
      branch: {
        ...state.branch,
        error: summarizeError(err),
      },
    };
    await gh.updateIssueTitleAndBody(
      owner,
      repo,
      issueNumber,
      undefined,
      replaceAutomationState(issue.body || "", failedState)
    );
    await createBranchEventComment(
      gh,
      owner,
      repo,
      issueNumber,
      payload,
      "/branch push",
      [
        "I could not create the draft PR for this branch push.",
        "",
        `Branch: \`${branchName}\``,
        `Base: \`${BASE_BRANCH}\``,
        "",
        "```text",
        failedState.branch.error,
        "```",
      ].join("\n")
    );

    return {
      processed: true,
      prCreated: false,
      branch: branchName,
      issue: issueNumber,
      reason: "draft pull request creation failed",
    };
  }

  if (draftPr.skipped) {
    return {
      processed: true,
      prCreated: false,
      branch: branchName,
      issue: issueNumber,
      reason: draftPr.reason,
    };
  }

  const updatedState = {
    ...state,
    branch: {
      ...state.branch,
      error: null,
      pr: draftPr.number,
    },
  };
  await gh.updateIssueTitleAndBody(
    owner,
    repo,
    issueNumber,
    undefined,
    setManagedBranchBodyLink(replaceAutomationState(issue.body || "", updatedState), {
      owner,
      repo,
      branchName,
    })
  );
  await createBranchEventComment(
    gh,
    owner,
    repo,
    issueNumber,
    payload,
    "/branch push",
    [
      "Created draft PR:",
      "",
      `#${draftPr.number}`,
      "",
      `Branch: \`${branchName}\``,
      `Base: \`${BASE_BRANCH}\``,
    ].join("\n")
  );

  return {
    processed: true,
    prCreated: true,
    branch: branchName,
    issue: issueNumber,
    pr: draftPr.number,
  };
}

export async function handleIssueClosedEvent({ gh, owner, repo, issueNumber, issue, stateReason }) {
  const state = parseAutomationState(issue.body || "");
  if (!state?.branch) {
    return { processed: false, reason: "closed issue has no branch metadata" };
  }

  const pr = state.branch.pr ? await getPullRequestOrNull(gh, owner, repo, state.branch.pr) : null;
  if (pr?.state === "open") {
    await gh.reopenIssue(owner, repo, issueNumber);
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "This issue cannot be closed while its PR is still open.",
        "",
        "Close or merge the PR first.",
        "",
        `Open PR: #${pr.number}`,
      ].join("\n")
    );
    return { processed: true, reopened: true, issue: issueNumber, pr: pr.number, reason: "PR is still open" };
  }

  if (stateReason !== "not_planned") {
    return { processed: false, reason: `closed issue state_reason=${stateReason || "unknown"}` };
  }

  const branchName = state.allowed_branch_name;
  if (!branchName) {
    return { processed: false, reason: "closed issue has no allowed branch" };
  }

  const refInfo = await getBranchRefInfo(gh, owner, repo, branchName);
  if (refInfo.exists) {
    await gh.deleteReference(owner, repo, `heads/${branchName}`);
  }

  const afterDeleteIssue = await gh.getIssue(owner, repo, issueNumber);
  const staleCleanup = await cleanupStaleLinkedBranchRecords({ gh, owner, repo, issueNumber, issue: afterDeleteIssue });
  const updatedState = resetBranchState(state);
  await gh.updateIssueTitleAndBody(
    owner,
    repo,
    issueNumber,
    undefined,
    removeManagedBranchBodyLink(replaceAutomationState(staleCleanup.issue.body || afterDeleteIssue.body || issue.body || "", updatedState))
  );
  await gh.createComment(
    owner,
    repo,
    issueNumber,
    [
      "This issue was closed as not planned.",
      "",
      refInfo.exists
        ? `Deleted managed branch: \`${branchName}\``
        : `Managed branch did not exist: \`${branchName}\``,
      pr ? "" : null,
      pr ? `Associated PR was already closed: #${pr.number}` : null,
    ].filter((line) => line !== null).join("\n")
  );

  return {
    processed: true,
    issue: issueNumber,
    branchDeleted: refInfo.exists ? branchName : null,
    pr: pr?.number || null,
    cleanedLinkedBranches: staleCleanup.deletedCount,
  };
}

function isIssueLinkedBranch(issue, branchName) {
  const nodes = issue.linkedBranches?.nodes || [];
  return nodes.some((node) => node?.ref?.name === branchName);
}

function isStaleBranchState(issue, branchName) {
  return !isIssueLinkedBranch(issue, branchName);
}

async function cleanupStaleLinkedBranchRecords({ gh, owner, repo, issueNumber, issue }) {
  const staleRecords = (issue.linkedBranches?.nodes || []).filter((node) => node?.id && !node.ref);
  if (!staleRecords.length || typeof gh.deleteLinkedBranch !== "function") {
    return { issue, deletedCount: 0 };
  }

  for (const record of staleRecords) {
    await gh.deleteLinkedBranch(record.id);
  }

  return {
    issue: await gh.getIssue(owner, repo, issueNumber),
    deletedCount: staleRecords.length,
  };
}

async function syncIssueBranchMetadata({ gh, owner, repo, issueNumber, issue, issueBody, state, expectedBranchName, checkExpectedRefOnly = false }) {
  if (!state?.branch) {
    return { issue, issueBody, state };
  }

  const branchStatus = await inspectIssueBranchState({
    gh,
    owner,
    repo,
    issue,
    issueNumber,
    expectedBranchName,
    state,
    checkExpectedRefOnly,
  });
  const syncedState = {
    ...state,
    branch: {
      ...state.branch,
      exists: branchStatus.metadataRef.exists == null
        ? state.branch.exists === true
        : branchStatus.metadataRef.exists === true,
      linked: branchStatus.metadataLinked === true,
      error: branchStatus.reason ? branchStatus.message : null,
    },
  };

  if (
    syncedState.branch.exists === state.branch.exists &&
    syncedState.branch.linked === state.branch.linked &&
    syncedState.branch.error === state.branch.error
  ) {
    return { issue, issueBody, state };
  }

  const syncedBody = replaceAutomationState(issueBody, syncedState);
  await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, syncedBody);
  return {
    issue,
    issueBody: syncedBody,
    state: parseAutomationState(syncedBody),
  };
}

async function inspectIssueBranchState({ gh, owner, repo, issue, expectedBranchName, state, checkExpectedRefOnly = false }) {
  const linkedNames = linkedBranchNames(issue);
  const staleLinkedRecordCount = staleLinkedBranchRecordCount(issue);
  const metadataName = state?.allowed_branch_name || null;
  const metadataLinked = metadataName ? linkedNames.includes(metadataName) : false;
  const expectedLinked = expectedBranchName ? linkedNames.includes(expectedBranchName) : false;
  const shouldCheckExpectedRef = checkExpectedRefOnly || expectedLinked || metadataName === expectedBranchName;
  const refNames = [...new Set([
    metadataName,
    shouldCheckExpectedRef ? expectedBranchName : null,
    ...linkedNames,
  ].filter(Boolean))];
  const refs = new Map();
  for (const name of refNames) {
    refs.set(name, await getBranchRefInfo(gh, owner, repo, name));
  }

  const unexpectedLinkedNames = linkedNames.filter((name) => name !== expectedBranchName);
  const ghostLinkedNames = linkedNames.filter((name) => refs.get(name)?.exists === false);
  const metadataRef = metadataName ? refs.get(metadataName) : { exists: false, sha: null };
  const expectedRef = expectedBranchName && refs.has(expectedBranchName)
    ? refs.get(expectedBranchName)
    : { exists: false, sha: null };

  const status = {
    expectedBranchName,
    metadataName,
    metadataLinked,
    metadataRef,
    expectedLinked,
    expectedRef,
    linkedNames,
    staleLinkedRecordCount,
    unexpectedLinkedNames,
    ghostLinkedNames,
    reason: null,
    message: null,
  };

  if (linkedNames.length > 1) {
    status.reason = "multiple linked branches";
    status.message = "GitHub reports multiple linked branches for this issue.";
  } else if (unexpectedLinkedNames.length > 0) {
    status.reason = "unexpected linked branch";
    status.message = `GitHub reports an unexpected linked branch: \`${unexpectedLinkedNames[0]}\`.`;
  } else if (metadataName && metadataName !== expectedBranchName) {
    status.reason = "metadata branch does not match expected branch";
    status.message = `Branch metadata points to \`${metadataName}\`, but the expected issue branch is \`${expectedBranchName}\`.`;
  } else if (ghostLinkedNames.length > 0) {
    status.reason = "linked branch missing git ref";
    status.message = `GitHub still reports \`${ghostLinkedNames[0]}\` as linked, but the git ref no longer exists.`;
  } else if (checkExpectedRefOnly && !metadataName && expectedRef.exists && !expectedLinked) {
    status.reason = "unlinked git ref already exists";
    status.message = `A git ref already exists for \`${expectedBranchName}\`, but GitHub does not report it as linked to this issue.`;
  }

  return status;
}

function branchStateBlockingMessage(status) {
  if (!status?.reason) return null;
  if (status.reason === "unexpected linked branch") {
    return [
      "This issue already has a linked branch:",
      "",
      `\`${status.unexpectedLinkedNames[0]}\``,
      "",
      "Each issue can only manage one branch.",
      "",
      "If you want to create a new branch, first delete the existing branch with `/branch delete`.",
      "",
      "Deleting a branch cannot be undone by automation.",
    ].join("\n");
  }

  if (status.reason === "metadata branch does not match expected branch") {
    return [
      "The expected branch name for this issue changed.",
      "",
      "Expected branch:",
      "",
      `\`${status.expectedBranchName}\``,
      "",
      "Current metadata branch:",
      "",
      `\`${status.metadataName}\``,
      "",
      "Run `/branch repair` if the metadata is stale, or `/branch delete` if you want to permanently delete the existing branch. Deleting a branch cannot be undone by automation.",
    ].join("\n");
  }

  if (status.reason === "unlinked git ref already exists") {
    return [
      "This issue can only manage one branch.",
      "",
      "A managed branch already exists, but GitHub does not report it as linked to this issue.",
      "",
      `\`${status.expectedBranchName}\``,
      "",
      "Run `/branch repair` to relink it.",
      "",
      "Run `/branch delete` only if you want to permanently delete it. This cannot be undone by automation.",
    ].join("\n");
  }

  if (status.reason === "linked branch missing git ref") {
    return [
      "GitHub reports a linked branch for this issue, but the branch no longer exists.",
      "",
      "Linked branch:",
      "",
      `\`${status.ghostLinkedNames[0]}\``,
      "",
      "Run `/branch repair` to clean the stale link.",
    ].join("\n");
  }

  return [
    "Branch state needs attention before automation can continue.",
    "",
    status.message,
    "",
    "Current state:",
    `- Expected branch: \`${status.expectedBranchName || "none"}\``,
    `- Metadata branch: \`${status.metadataName || "none"}\``,
    `- Linked branches: ${status.linkedNames.length ? status.linkedNames.map((name) => `\`${name}\``).join(", ") : "`none`"}`,
    `- Stale linked records: \`${status.staleLinkedRecordCount || 0}\``,
    `- Expected git ref exists: \`${status.expectedRef.exists ? "yes" : "no"}\``,
    "",
    status.reason === "linked branch missing git ref"
      ? "Remove the stale linked branch from the issue sidebar, then run `/branch repair` again."
      : "Run `/branch repair` or clean up the conflicting branch/link before retrying.",
  ].join("\n");
}

function invalidManualBranchNameMessage({ expectedBranchName, branchName }) {
  return [
    "This branch name is not valid for this issue, so it could not be created manually.",
    "",
    "Expected branch:",
    "",
    `\`${expectedBranchName}\``,
    "",
    "Received branch:",
    "",
    `\`${branchName}\``,
    "",
    "Use `/branch create` to create the correct branch automatically.",
  ].join("\n");
}

function linkedBranchNames(issue) {
  return [...new Set((issue.linkedBranches?.nodes || [])
    .map((node) => node?.ref?.name)
    .filter(Boolean))];
}

function staleLinkedBranchRecordCount(issue) {
  return (issue.linkedBranches?.nodes || []).filter((node) => node && !node.ref).length;
}

async function getBranchRefInfo(gh, owner, repo, branchName) {
  if (typeof gh.getReference !== "function") {
    return { exists: null, sha: null };
  }

  try {
    const ref = await gh.getReference(owner, repo, `heads/${branchName}`);
    return { exists: true, sha: ref?.object?.sha || null };
  } catch (err) {
    if (String(err?.message || "").includes("HTTP 404")) {
      return { exists: false, sha: null };
    }
    throw err;
  }
}

async function waitForLinkedBranch(gh, owner, repo, issueNumber, branchName, attempts = 5, delayMs = 250) {
  let issue = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    issue = await gh.getIssue(owner, repo, issueNumber);
    if (isIssueLinkedBranch(issue, branchName)) {
      return issue;
    }
    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }
  return issue;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createBranchEventComment(gh, owner, repo, issueNumber, payload, command, body) {
  if (typeof gh.setCommandLogMetadata === "function") {
    gh.setCommandLogMetadata(owner, repo, issueNumber, {
      actor: payload.sender?.login,
      command,
    });
  }
  await gh.createComment(owner, repo, issueNumber, body);
}

async function createDraftPullRequestForIssue({ gh, owner, repo, issueNumber, issueType, issueTitle, branchName }) {
  if (typeof gh.createPullRequest !== "function") {
    throw new Error("GitHub client does not support pull request creation.");
  }

  if (await branchMatchesBase(gh, owner, repo, branchName, BASE_BRANCH)) {
    return { number: null, skipped: true, reason: "no commits between branch and base" };
  }

  return gh.createPullRequest({
    owner,
    repo,
    title: buildIssuePullRequestTitle({
      issueType,
      issueNumber,
      title: issueTitle,
    }),
    head: branchName,
    base: BASE_BRANCH,
    body: formatPullRequestBody({
      owner,
      repo,
      branchName,
      body: `Closes #${issueNumber}`,
      issueNumber,
    }),
    draft: true,
  });
}

async function deleteReferenceIfExists(gh, owner, repo, ref) {
  try {
    await gh.deleteReference(owner, repo, ref);
  } catch (err) {
    if (String(err?.message || "").includes("HTTP 404")) return;
    throw err;
  }
}

async function branchMatchesBase(gh, owner, repo, branchName, baseBranch) {
  const [branchRef, baseRef] = await Promise.all([
    gh.getReference(owner, repo, `heads/${branchName}`),
    gh.getReference(owner, repo, `heads/${baseBranch}`),
  ]);
  return branchRef?.object?.sha === baseRef?.object?.sha;
}

/**
 * Validates and records pull requests opened from authorized issue branches.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function handlePullRequestEvent({ gh, owner, repo, payload }) {
  if (payload.action === "closed") {
    return handlePullRequestClosedEvent({ gh, owner, repo, payload });
  }

  if (payload.action !== "opened") {
    return { processed: false, reason: `pull_request action=${payload.action}` };
  }

  const pr = payload.pull_request;
  const branchName = pr?.head?.ref;
  const baseName = pr?.base?.ref;
  const issueNumber = extractIssueNumberFromBranch(branchName);
  if (!issueNumber) {
    return { processed: false, reason: "PR branch is not issue-managed" };
  }

  let issue = await gh.getIssue(owner, repo, issueNumber);
  issue = (await cleanupStaleLinkedBranchRecords({ gh, owner, repo, issueNumber, issue })).issue;
  const state = parseAutomationState(issue.body || "");
  const branchStatus = await inspectIssueBranchState({
    gh,
    owner,
    repo,
    issue,
    issueNumber,
    expectedBranchName: branchName,
    state,
  });
  const problems = [];

  const blockingMessage = branchStateBlockingMessage(branchStatus);
  if (blockingMessage) {
    problems.push(branchStatus.message);
  }

  if (
    !state?.branch ||
    state.allowed_branch_name !== branchName ||
    state.branch.exists !== true ||
    state.branch.linked !== true ||
    !branchStatus.metadataLinked ||
    !branchStatus.metadataRef.exists
  ) {
    problems.push("the source branch is not registered as an authorized linked branch for this issue");
  }

  if (baseName !== BASE_BRANCH) {
    problems.push(`the PR base must be \`${BASE_BRANCH}\``);
  }

  if (state?.branch?.pr && state.branch.pr !== pr.number) {
    problems.push(`this issue is already associated with PR #${state.branch.pr}`);
  }

  if (problems.length > 0) {
    await gh.createComment(
      owner,
      repo,
      pr.number,
      [
        "This PR is not fully linked to its issue yet:",
        "",
        ...problems.map((p) => `- ${p}`),
      ].join("\n")
    );
    return { processed: true, valid: false, issue: issueNumber, pr: pr.number };
  }

  const expectedTitle = buildIssuePullRequestTitle({
    issueType: issue.issueType?.name || state?.original_issue_type || "issue",
    issueNumber,
    title: issue.title,
  });
  const expectedBodyLink = `Closes #${issueNumber}`;
  const nextTitle = pr.title === expectedTitle ? undefined : expectedTitle;
  const expectedBody = formatPullRequestBody({
    owner,
    repo,
    branchName,
    body: pr.body || "",
    issueNumber,
  });
  const nextBody = pr.body === expectedBody ? undefined : expectedBody;

  if (nextTitle !== undefined || nextBody !== undefined) {
    await gh.updatePullRequest(owner, repo, pr.number, {
      title: nextTitle,
      body: nextBody,
    });
    await gh.createComment(
      owner,
      repo,
      pr.number,
      [
        "This PR was adopted by automation because it uses the managed branch for this issue.",
        "",
        nextTitle !== undefined ? `Updated title to: \`${expectedTitle}\`` : null,
        nextBody !== undefined ? `Ensured PR body includes the managed branch link and \`${expectedBodyLink}\`.` : null,
      ].filter(Boolean).join("\n")
    );
  }

  const updatedState = {
    ...state,
    branch: {
      ...state.branch,
      error: null,
      pr: pr.number,
    },
  };

  await gh.updateIssueTitleAndBody(
    owner,
    repo,
    issueNumber,
    undefined,
    setManagedBranchBodyLink(replaceAutomationState(issue.body || "", updatedState), {
      owner,
      repo,
      branchName,
    })
  );

  return { processed: true, valid: true, issue: issueNumber, pr: pr.number };
}

async function handlePullRequestClosedEvent({ gh, owner, repo, payload }) {
  const pr = payload.pull_request;
  const branchName = pr?.head?.ref;
  const issueNumber = extractIssueNumberFromBranch(branchName);
  if (!issueNumber) {
    return { processed: false, reason: "PR branch is not issue-managed" };
  }

  let issue = await gh.getIssue(owner, repo, issueNumber);
  const state = parseAutomationState(issue.body || "");
  if (!state?.branch || state.allowed_branch_name !== branchName || state.branch.pr !== pr.number) {
    return { processed: true, valid: false, issue: issueNumber, pr: pr.number, reason: "closed PR is not active for issue" };
  }

  if (pr.merged === true) {
    const updatedState = resetBranchState(state);
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, removeManagedBranchBodyLink(replaceAutomationState(issue.body || "", updatedState)));
    return { processed: true, merged: true, issue: issueNumber, pr: pr.number, metadataCleaned: true };
  }

  await gh.closeIssue(owner, repo, issueNumber, "not_planned");
  await deleteReferenceIfExists(gh, owner, repo, `heads/${branchName}`);
  issue = await gh.getIssue(owner, repo, issueNumber);
  const staleCleanup = await cleanupStaleLinkedBranchRecords({ gh, owner, repo, issueNumber, issue });
  const updatedState = resetBranchState(state);
  await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, removeManagedBranchBodyLink(replaceAutomationState(staleCleanup.issue.body || issue.body || "", updatedState)));
  await gh.createComment(
    owner,
    repo,
    issueNumber,
    [
      "This issue was closed as not planned because its PR was closed without merge.",
      "",
      `Closed PR: #${pr.number}`,
      `Deleted managed branch: \`${branchName}\``,
    ].join("\n")
  );

  return {
    processed: true,
    merged: false,
    issue: issueNumber,
    pr: pr.number,
    branchDeleted: branchName,
    cleanedLinkedBranches: staleCleanup.deletedCount,
  };
}

async function normalizePullRequestForIssue({ gh, owner, repo, pr, issue, issueNumber, issueType, branchName }) {
  const expectedTitle = buildIssuePullRequestTitle({
    issueType,
    issueNumber,
    title: issue.title,
  });
  const expectedBody = formatPullRequestBody({
    owner,
    repo,
    branchName,
    body: pr.body || "",
    issueNumber,
  });
  const nextTitle = pr.title === expectedTitle ? undefined : expectedTitle;
  const nextBody = pr.body === expectedBody ? undefined : expectedBody;
  if (nextTitle !== undefined || nextBody !== undefined) {
    const update = {};
    if (nextTitle !== undefined) update.title = nextTitle;
    if (nextBody !== undefined) update.body = nextBody;
    await gh.updatePullRequest(owner, repo, pr.number, update);
  }
  return { title: expectedTitle, body: expectedBody, titleUpdated: nextTitle !== undefined, bodyUpdated: nextBody !== undefined };
}

function pullRequestMatchesIssue(pr, issueNumber, branchName) {
  if (extractIssueNumberFromBranch(pr?.head?.ref) === issueNumber) return true;
  if (String(pr?.title || "").includes(`(#${issueNumber})`)) return true;
  if (bodyClosesIssue(pr?.body || "", issueNumber)) return true;
  return pr?.head?.ref === branchName;
}

async function notifyClosedPullRequestsBlockedByActiveBranch({ gh, owner, repo, branchName, activePrNumber, ignorePullNumber, closedPullRequests }) {
  if (!Array.isArray(closedPullRequests) || !activePrNumber) return;
  for (const pr of closedPullRequests) {
    if (!pr?.number || pr.number === ignorePullNumber) continue;
    await gh.createComment(
      owner,
      repo,
      pr.number,
      [
        "This PR cannot restore its branch while the managed branch already exists.",
        "",
        `Active branch: \`${branchName}\``,
        `Active PR: #${activePrNumber}`,
        "",
        "Delete the active branch with `/branch delete` before restoring this PR's branch.",
      ].join("\n")
    );
  }
}

function summarizeError(err) {
  const message = err?.message || String(err);
  return message.length > 1200 ? `${message.slice(0, 1200)}...` : message;
}

function bodyClosesIssue(body, issueNumber) {
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bclose[sd]?\\s+#${escaped}\\b`, "i").test(String(body || ""));
}

function formatPullRequestBody({ owner, repo, branchName, body, issueNumber }) {
  const cleanedBody = String(body || "")
    .replace(/^Branch: \[`[^`]+`\]\(https:\/\/github\.com\/[^)]+\)\s*/i, "")
    .trim();
  const bodyWithIssueLink = bodyClosesIssue(cleanedBody, issueNumber)
    ? cleanedBody
    : [cleanedBody, `Closes #${issueNumber}`].filter(Boolean).join("\n\n");
  return [
    `Branch: ${branchMarkdownLink(owner, repo, branchName)}`,
    "",
    bodyWithIssueLink,
  ].join("\n").trim();
}

function branchMarkdownLink(owner, repo, branchName) {
  return `[\`${branchName}\`](https://github.com/${owner}/${repo}/tree/${encodeBranchPath(branchName)})`;
}

function encodeBranchPath(branchName) {
  return String(branchName || "").split("/").map(encodeURIComponent).join("/");
}

function resetBranchState(state) {
  return {
    ...state,
    branch: {
      exists: false,
      linked: false,
      error: null,
      pr: null,
    },
  };
}

async function getPullRequestOrNull(gh, owner, repo, pullNumber) {
  if (!pullNumber || typeof gh.getPullRequest !== "function") return null;
  try {
    return await gh.getPullRequest(owner, repo, pullNumber);
  } catch (err) {
    if (String(err?.message || "").includes("HTTP 404")) return null;
    throw err;
  }
}

async function getOpenPullRequestOrNull(gh, owner, repo, pullNumber) {
  const pr = await getPullRequestOrNull(gh, owner, repo, pullNumber);
  return pr?.state === "open" ? pr : null;
}

async function closePullRequestForBranchDeletion({ gh, owner, repo, issueNumber, prNumber, branchName }) {
  if (typeof gh.closePullRequest === "function") {
    await gh.closePullRequest(owner, repo, prNumber);
  }
  await gh.createComment(
    owner,
    repo,
    prNumber,
    [
      "This PR was closed because the managed branch was deleted with `/branch delete`.",
      "",
      `Issue: #${issueNumber}`,
      `Deleted branch: \`${branchName}\``,
      "",
      "If this branch is not recreated, GitHub may allow restoring it from this closed PR.",
    ].join("\n")
  );
}

function buildTemporaryBranchName(branchName) {
  const safeName = branchName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `temp/${safeName}-${timestamp}`;
}

function isTemporaryRepairBranch(branchName) {
  return /^temp\/[A-Za-z0-9._-]+-\d{14}$/.test(String(branchName || ""));
}
