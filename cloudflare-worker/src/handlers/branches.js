import { GITHUB_APP_BOT_LOGIN } from "../config.js";
import {
  bodyLinksIssue,
  buildIssueBranchName,
  buildIssuePullRequestTitle,
  ensureAutomationState,
  extractIssueNumberFromBranch,
  parseAutomationState,
  replaceAutomationState,
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
        "This issue has recorded branch metadata, but the branch is not currently linked.",
        "",
        `Recorded branch: \`${allowedBranchName}\``,
        "",
        "Run `/branch repair` to repair the linked branch relationship or reset the metadata if the branch no longer exists.",
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

    let draftPr;
    try {
      draftPr = await createDraftPullRequestForIssue({
        gh,
        owner,
        repo,
        issueNumber,
        issueType,
        issueTitle: currentIssue.title,
        branchName,
      });
    } catch (prErr) {
      const failedPrState = {
        ...reservedState,
        branch: {
          ...reservedState.branch,
          exists: true,
          linked: true,
          error: summarizeError(prErr),
        },
      };
      await gh.updateIssueTitleAndBody(
        owner,
        repo,
        issueNumber,
        undefined,
        replaceAutomationState(linkedIssueBody, failedPrState)
      );
      await gh.createComment(
        owner,
        repo,
        issueNumber,
        [
          "Created linked branch, but I could not create the draft PR.",
          "",
          `Branch: \`${branchName}\``,
          `Base: \`${BASE_BRANCH}\``,
          "",
          "```text",
          failedPrState.branch.error,
          "```",
        ].join("\n")
      );

      return {
        processed: true,
        command: "branch",
        created: true,
        prCreated: false,
        branch: branchName,
        reason: "draft pull request creation failed",
      };
    }

    const createdState = {
      ...linkedState,
      branch: {
        ...linkedState.branch,
        error: null,
        pr: draftPr.number,
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
        `Created draft PR: #${draftPr.number}`,
      ].join("\n")
    );

    return { processed: true, command: "branch", created: true, branch: branchName, pr: draftPr.number };
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

    await gh.createComment(
      owner,
      repo,
      issueNumber,
      "Nothing to repair: this issue does not have recorded branch metadata."
    );
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
        "No repair needed: the recorded branch is already linked.",
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
        "Nothing to repair: the recorded branch does not exist.",
        "",
        "Marked the branch state as missing so `/branch create` can be used again.",
        "",
        `Allowed branch: \`${branchName}\``,
      ].join("\n")
    );

    return {
      processed: true,
      command: "branch repair",
      repaired: false,
      reset: true,
      reason: "recorded branch does not exist",
    };
  }

  const branchOid = branchRef?.object?.sha;
  if (!branchOid) {
    throw new Error(`Recorded branch ${branchName} did not return a commit SHA.`);
  }

  const temporaryBranchName = buildTemporaryBranchName(branchName);

  try {
    await gh.createReference(owner, repo, `refs/heads/${temporaryBranchName}`, branchOid);
    await gh.deleteReference(owner, repo, `heads/${branchName}`);
    await gh.createLinkedBranch({
      issueId: currentIssue.id,
      repositoryId: currentIssue.repository?.id,
      branchName,
      baseOid: branchOid,
    });

    const repairedIssue = await gh.getIssue(owner, repo, issueNumber);
    if (!isIssueLinkedBranch(repairedIssue, branchName)) {
      throw new Error("GitHub created the branch ref but did not report it as a linked branch for this issue.");
    }

    await deleteReferenceIfExists(gh, owner, repo, `heads/${temporaryBranchName}`);
  } catch (err) {
    const failedState = {
      ...state,
      branch: {
        ...state.branch,
        exists: true,
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
        "If the temporary branch still exists, the existing commits were preserved there.",
        "",
        "```text",
        failedState.branch.error,
        "```",
      ].join("\n")
    );

    return { processed: true, command: "branch repair", repaired: false, reason: "linked branch repair failed" };
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

  if (issue && isIssueLinkedBranch(issue, branchName)) {
    const isFromDev = await branchMatchesBase(gh, owner, repo, branchName, BASE_BRANCH);
    const issueType = issue.issueType?.name || "issue";
    const expectedBranchName = buildIssueBranchName({
      issueType,
      issueNumber,
      title: issue.title,
    });
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
          "This issue already has recorded branch metadata:",
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
      } catch (prErr) {
        const failedPrState = {
          allowed_branch_name: branchName,
          branch: {
            exists: true,
            linked: true,
            error: summarizeError(prErr),
            pr: state?.branch?.pr ?? null,
          },
        };
        await gh.updateIssueTitleAndBody(
          owner,
          repo,
          issueNumber,
          undefined,
          replaceAutomationState(linkedBody, failedPrState)
        );
        await createBranchEventComment(
          gh,
          owner,
          repo,
          issueNumber,
          payload,
          "/branch manual",
          [
            "Branch linked and recorded, but I could not create the draft PR.",
            "",
            `Branch: \`${branchName}\``,
            `Base: \`${BASE_BRANCH}\``,
            "",
            "```text",
            failedPrState.branch.error,
            "```",
          ].join("\n")
        );

        return {
          processed: true,
          allowed: true,
          prCreated: false,
          branch: branchName,
          issue: issueNumber,
          reason: "draft pull request creation failed",
        };
      }
      const updatedState = {
        ...linkedState,
        branch: {
          ...linkedState.branch,
          error: null,
          pr: draftPr.number,
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
          `Draft PR: #${draftPr.number}`,
          "",
          "Created from GitHub's sidebar and accepted by automation.",
        ].join("\n")
      );

      return {
        processed: true,
        allowed: true,
        branch: branchName,
        issue: issueNumber,
        pr: draftPr.number,
        reason: "branch is linked to issue and based on dev",
      };
    }
  }

  await gh.deleteReference(owner, repo, `heads/${branchName}`);

  if (issueNumber) {
    try {
      await createBranchEventComment(
        gh,
        owner,
        repo,
        issueNumber,
        payload,
        "/branch manual",
        [
          `Deleted branch \`${branchName}\` because it was not accepted by automation.`,
          "",
          "Prefer `/branch create` for managed issue branches, or use the GitHub sidebar only when the generated branch name matches the issue convention and no branch is already recorded.",
        ].join("\n")
      );
    } catch (err) {
      console.error(`Failed to comment after deleting unauthorized branch: ${err.message}`);
    }
  }

  return { processed: true, allowed: false, deleted: true, branch: branchName, issue: issueNumber };
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
    status.message = `Recorded branch metadata points to \`${metadataName}\`, but the expected issue branch is \`${expectedBranchName}\`.`;
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
  return [
    "Branch state needs attention before automation can continue.",
    "",
    status.message,
    "",
    "Current state:",
    `- Expected branch: \`${status.expectedBranchName || "none"}\``,
    `- Recorded metadata: \`${status.metadataName || "none"}\``,
    `- Linked branches: ${status.linkedNames.length ? status.linkedNames.map((name) => `\`${name}\``).join(", ") : "`none`"}`,
    `- Stale linked records: \`${status.staleLinkedRecordCount || 0}\``,
    `- Expected git ref exists: \`${status.expectedRef.exists ? "yes" : "no"}\``,
    "",
    status.reason === "linked branch missing git ref"
      ? "Remove the stale linked branch from the issue sidebar, then run `/branch repair` again."
      : "Run `/branch repair` or clean up the conflicting branch/link before retrying.",
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
    body: `Closes #${issueNumber}`,
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

  if (!bodyLinksIssue(pr.body || "", issueNumber)) {
    problems.push(`the PR body must reference this issue, for example \`Refs #${issueNumber}\``);
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

  const updatedState = {
    ...state,
    branch: {
      ...state.branch,
      pr: pr.number,
    },
  };

  await gh.updateIssueTitleAndBody(
    owner,
    repo,
    issueNumber,
    undefined,
    replaceAutomationState(issue.body || "", updatedState)
  );

  return { processed: true, valid: true, issue: issueNumber, pr: pr.number };
}

function summarizeError(err) {
  const message = err?.message || String(err);
  return message.length > 1200 ? `${message.slice(0, 1200)}...` : message;
}

function buildTemporaryBranchName(branchName) {
  const safeName = branchName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `temp/${safeName}-${timestamp}`;
}

function isTemporaryRepairBranch(branchName) {
  return /^temp\/[A-Za-z0-9._-]+-\d{14}$/.test(String(branchName || ""));
}
