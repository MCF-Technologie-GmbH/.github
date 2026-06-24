import { GITHUB_APP_BOT_LOGIN } from "../config.js";
import {
  bodyLinksIssue,
  buildIssueBranchName,
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
  const currentIssue = await gh.getIssue(owner, repo, issueNumber);
  const issueType = currentIssue.issueType?.name || "issue";
  const branchName = buildIssueBranchName({
    issueType,
    issueNumber,
    title: currentIssue.title,
  });

  let issueBody = ensureAutomationState(currentIssue.body || "", issueType);
  let state = parseAutomationState(issueBody);

  if (issueBody !== (currentIssue.body || "")) {
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, issueBody);
  }

  if (state?.branch?.name && state.branch.name !== branchName) {
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "This issue already has an assigned branch:",
        "",
        `\`${state.branch.name}\``,
        "",
        "A second branch cannot be created for the same issue.",
      ].join("\n")
    );
    return { processed: true, command: "branch", created: false, reason: "issue already has another branch" };
  }

  if (state?.branch?.name && isStaleBranchState(currentIssue, state.branch.name)) {
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "This issue has recorded branch metadata, but the branch is not currently linked.",
        "",
        `Recorded branch: \`${state.branch.name}\``,
        "",
        "Run `/branch repair` to repair the linked branch relationship or reset the metadata if the branch no longer exists.",
      ].join("\n")
    );
    return { processed: true, command: "branch", created: false, reason: "branch metadata needs repair" };
  }

  if (state?.branch?.created === true) {
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "This issue already has an authorized branch:",
        "",
        `\`${state.branch.name}\``,
      ].join("\n")
    );
    return { processed: true, command: "branch", created: false, reason: "branch already exists" };
  }

  const reservedState = {
    issue_type: state.issue_type,
    branch: {
      name: branchName,
      base: BASE_BRANCH,
      created: false,
      linked: false,
      error: null,
      pr: state?.branch?.pr ?? null,
    },
  };

  issueBody = replaceAutomationState(issueBody, reservedState);
  await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, issueBody);

  const reloadedIssue = await gh.getIssue(owner, repo, issueNumber);
  const reloadedState = parseAutomationState(reloadedIssue.body || "");
  if (reloadedState?.branch?.name !== branchName || reloadedState.branch.created === true) {
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

    const createdState = {
      ...reservedState,
      branch: {
        ...reservedState.branch,
        created: true,
        linked: true,
        error: null,
      },
    };
    await gh.updateIssueTitleAndBody(
      owner,
      repo,
      issueNumber,
      undefined,
      replaceAutomationState(reloadedIssue.body || issueBody, createdState)
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
      ].join("\n")
    );

    return { processed: true, command: "branch", created: true, branch: branchName };
  } catch (err) {
    const failedState = {
      ...reservedState,
      branch: {
        ...reservedState.branch,
        created: false,
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
  const currentIssue = await gh.getIssue(owner, repo, issueNumber);
  const issueType = currentIssue.issueType?.name || "issue";
  let issueBody = ensureAutomationState(currentIssue.body || "", issueType);
  let state = parseAutomationState(issueBody);
  const branchName = state?.branch?.name;

  if (issueBody !== (currentIssue.body || "")) {
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, issueBody);
  }

  if (!branchName) {
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      "Nothing to repair: this issue does not have recorded branch metadata."
    );
    return { processed: true, command: "branch repair", repaired: false, reason: "no branch metadata" };
  }

  if (isIssueLinkedBranch(currentIssue, branchName)) {
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

    state = { ...state, branch: null };
    issueBody = replaceAutomationState(issueBody, state);
    await gh.updateIssueTitleAndBody(owner, repo, issueNumber, undefined, issueBody);
    await gh.createComment(
      owner,
      repo,
      issueNumber,
      [
        "Nothing to repair: the recorded branch no longer exists.",
        "",
        "Resetting linked branch metadata so `/branch create` can be used again.",
        "",
        `Removed metadata for: \`${branchName}\``,
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
        created: true,
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
      created: true,
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
      state = parseAutomationState(issue.body || "");
    } catch (err) {
      console.error(`Failed to read issue #${issueNumber} for branch authorization: ${err.message}`);
    }
  }

  const isReservedBranch = state?.branch?.name === branchName && state.branch.base === BASE_BRANCH;
  const isAutomationBot = payload.sender?.login === GITHUB_APP_BOT_LOGIN;

  if (isAutomationBot && isTemporaryRepairBranch(branchName)) {
    return { processed: true, allowed: true, reason: "temporary repair branch created by automation bot" };
  }

  if (isAutomationBot && isReservedBranch) {
    return { processed: true, allowed: true, reason: "branch created by automation bot with matching reservation" };
  }

  if (issue && isIssueLinkedBranch(issue, branchName)) {
    const isFromDev = await branchMatchesBase(gh, owner, repo, branchName, BASE_BRANCH);
    const issueType = issue.issueType?.name || state?.issue_type || "issue";
    const expectedBranchName = buildIssueBranchName({
      issueType,
      issueNumber,
      title: issue.title,
    });

    if (isFromDev && branchName === expectedBranchName && state?.branch?.name) {
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
          `\`${state.branch.name}\``,
          "",
          "Run `/branch repair` before creating or linking a branch manually.",
        ].join("\n")
      );

      return {
        processed: true,
        allowed: false,
        deleted: true,
        branch: branchName,
        issue: issueNumber,
        reason: "issue branch metadata needs repair before manual link",
      };
    }

    if (isFromDev && branchName === expectedBranchName) {
      const body = ensureAutomationState(issue.body || "", issueType);
      const updatedState = {
        issue_type: parseAutomationState(body)?.issue_type || state?.issue_type || "issue",
        branch: {
          name: branchName,
          base: BASE_BRANCH,
          created: true,
          linked: true,
          error: null,
          pr: state?.branch?.pr ?? null,
        },
      };

      await gh.updateIssueTitleAndBody(
        owner,
        repo,
        issueNumber,
        undefined,
        replaceAutomationState(body, updatedState)
      );

      await createBranchEventComment(
        gh,
        owner,
        repo,
        issueNumber,
        payload,
        "/branch manual",
        [
          "Branch linked and recorded successfully.",
          "",
          `Branch: \`${branchName}\``,
          `Base: \`${BASE_BRANCH}\``,
          "",
          "Created from GitHub's sidebar and accepted by automation.",
        ].join("\n")
      );

      return {
        processed: true,
        allowed: true,
        branch: branchName,
        issue: issueNumber,
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

async function createBranchEventComment(gh, owner, repo, issueNumber, payload, command, body) {
  if (typeof gh.setCommandLogMetadata === "function") {
    gh.setCommandLogMetadata(owner, repo, issueNumber, {
      actor: payload.sender?.login,
      command,
    });
  }
  await gh.createComment(owner, repo, issueNumber, body);
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

  const issue = await gh.getIssue(owner, repo, issueNumber);
  const state = parseAutomationState(issue.body || "");
  const problems = [];

  if (!state?.branch || state.branch.name !== branchName || state.branch.created !== true || state.branch.linked !== true) {
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
