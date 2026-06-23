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
 * Handles the /branch issue comment command.
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

  if (state?.branch?.name && isStaleBranchState(currentIssue, state.branch.name)) {
    await deleteBranchIfExists(gh, owner, repo, state.branch.name);
    state = { ...state, branch: null };
    issueBody = replaceAutomationState(issueBody, state);
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
      "The branch reservation changed while processing `/branch`. Please retry."
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
        "The same branch can be retried with `/branch` after the error is fixed.",
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
 * Enforces that branches are created only by the automation bot through /branch.
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

    if (isFromDev && branchName === expectedBranchName && canRecordLinkedBranch(state, branchName)) {
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
      await gh.createComment(
        owner,
        repo,
        issueNumber,
        [
          `Deleted unauthorized branch \`${branchName}\`.`,
          "",
          "Branches must be created with `/branch` so they can be linked and recorded by automation.",
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

async function deleteBranchIfExists(gh, owner, repo, branchName) {
  try {
    await gh.deleteReference(owner, repo, `heads/${branchName}`);
  } catch (err) {
    if (String(err?.message || "").includes("HTTP 404")) return;
    throw err;
  }
}

function canRecordLinkedBranch(state, branchName) {
  return !state?.branch?.name || state.branch.name === branchName;
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
