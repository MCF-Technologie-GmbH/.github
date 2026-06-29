const STATE_START = "<!-- automation-state:start";
const STATE_END = "automation-state:end -->";
const MANAGED_BRANCH_START = "<!-- managed-branch:start -->";
const MANAGED_BRANCH_END = "<!-- managed-branch:end -->";

const ISSUE_TYPE_BRANCH_PREFIXES = {
  Bug: "fix",
  Chore: "chore",
  Documentation: "docs",
  Feature: "feat",
  Refactor: "refactor",
  Spike: "spike",
  Test: "test",
};

/**
 * Normalizes a GitHub Issue Type display name into the branch prefix key.
 *
 * @param {string} issueType
 * @returns {string}
 */
export function issueTypeKey(issueType) {
  return ISSUE_TYPE_BRANCH_PREFIXES[issueType] || slugify(issueType || "issue");
}

/**
 * Builds the one allowed branch name for an issue.
 *
 * @param {object} params
 * @param {string} params.issueType
 * @param {number} params.issueNumber
 * @param {string} params.title
 * @returns {string}
 */
export function buildIssueBranchName({ issueType, issueNumber, title }) {
  const prefix = issueTypeKey(issueType);
  const cleanedTitle = stripConventionalTitlePrefix(title);
  const slug = slugify(cleanedTitle) || "work";
  return `${prefix}/${issueNumber}-${slug}`.slice(0, 240);
}

/**
 * Builds the draft PR title for an issue branch.
 *
 * @param {object} params
 * @param {string} params.issueType
 * @param {number} params.issueNumber
 * @param {string} params.title
 * @returns {string}
 */
export function buildIssuePullRequestTitle({ issueType, issueNumber, title }) {
  const prefix = issueTypeKey(issueType);
  const cleanedTitle = stripConventionalTitlePrefix(title) || "Work";
  return `${prefix}: ${cleanedTitle} (#${issueNumber})`;
}

/**
 * Extracts the issue number from a managed branch name.
 *
 * @param {string} branchName
 * @returns {number|null}
 */
export function extractIssueNumberFromBranch(branchName) {
  const match = String(branchName || "").match(/(?:^|\/)([1-9]\d*)-[a-z0-9][a-z0-9-]*(?:$|\/)/);
  return match ? Number(match[1]) : null;
}

/**
 * Parses automation-state JSON from an issue body.
 *
 * @param {string} body
 * @returns {object|null}
 */
export function parseAutomationState(body) {
  const raw = extractAutomationStateJson(body);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return normalizeAutomationState(parsed);
  } catch {
    return null;
  }
}

/**
 * Ensures the issue body has an automation-state block inside the protected zone.
 *
 * @param {string} body
 * @param {string} issueType
 * @returns {string}
 */
export function ensureAutomationState(body, issueType, issueMeta = {}) {
  const existing = parseAutomationState(body);
  const allowedBranchName = existing?.allowed_branch_name || (
    issueMeta.issueNumber && issueMeta.title
      ? buildIssueBranchName({ issueType, issueNumber: issueMeta.issueNumber, title: issueMeta.title })
      : null
  );
  const state = normalizeAutomationState({
    ...existing,
    original_issue_type: existing?.original_issue_type || issueType || null,
    allowed_branch_name: allowedBranchName,
  });
  return replaceAutomationState(body, state);
}

/**
 * Replaces or inserts automation-state JSON.
 *
 * @param {string} body
 * @param {object} state
 * @returns {string}
 */
export function replaceAutomationState(body, state) {
  const existing = parseAutomationState(body);
  const normalized = normalizeAutomationState({
    ...existing,
    ...state,
    original_issue_type: state?.original_issue_type ?? existing?.original_issue_type ?? null,
  });
  const block = formatAutomationStateBlock(normalized);
  const text = String(body || "");
  const bodyWithoutState = text
    .replace(wrappedAutomationStateRegex(), "")
    .replace(automationStateRegex(), "")
    .trim();

  return `${bodyWithoutState}\n\n${block}`.trim();
}

/**
 * Adds or replaces the protected visible managed branch block at the top.
 *
 * @param {string} body
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.branchName
 * @returns {string}
 */
export function setManagedBranchBodyLink(body, { owner, repo, branchName }) {
  const withoutLink = removeManagedBranchBodyLink(body);
  if (!owner || !repo || !branchName) return withoutLink;
  const block = [
    "<!-- protected:start -->",
    MANAGED_BRANCH_START,
    `Branch: [\`${branchName}\`](https://github.com/${owner}/${repo}/tree/${encodeBranchPath(branchName)})`,
    MANAGED_BRANCH_END,
    "<!-- protected:end -->",
  ].join("\n");
  return `${block}\n\n${withoutLink}`.trim();
}

/**
 * Removes the protected visible managed branch block.
 *
 * @param {string} body
 * @returns {string}
 */
export function removeManagedBranchBodyLink(body) {
  return String(body || "").replace(managedBranchBlockRegex(), "").trim();
}

/**
 * Checks whether a PR body links to the expected issue number.
 *
 * @param {string} body
 * @param {number} issueNumber
 * @returns {boolean}
 */
export function bodyLinksIssue(body, issueNumber) {
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\\s+#${escaped}\\b`, "i");
  return regex.test(String(body || ""));
}

/**
 * Converts arbitrary text into a branch-safe slug.
 *
 * @param {string} value
 * @returns {string}
 */
export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
}

function stripConventionalTitlePrefix(value) {
  return String(value || "")
    .replace(/^[a-zA-Z0-9_-]+\([^)]+\)\s*:\s*/, "")
    .replace(/^[a-zA-Z0-9_-]+\s*:\s*/, "")
    .trim();
}

function normalizeAutomationState(state) {
  const allowedBranchName = normalizeAllowedBranchName(state);
  return {
    original_issue_type: normalizeOriginalIssueType(state),
    allowed_branch_name: allowedBranchName,
    branch: normalizeBranchState(state?.branch),
  };
}

function normalizeOriginalIssueType(state) {
  if (typeof state?.original_issue_type === "string" && state.original_issue_type.trim()) {
    return state.original_issue_type.trim();
  }
  return null;
}

function normalizeBranchState(branch) {
  if (!branch || typeof branch !== "object") return null;
  return {
    exists: branch.exists === true || branch.created === true,
    linked: branch.linked === true,
    error: branch.error == null ? null : String(branch.error),
    pr: branch.pr == null ? null : Number(branch.pr),
  };
}

function normalizeAllowedBranchName(state) {
  if (typeof state?.allowed_branch_name === "string" && state.allowed_branch_name.trim()) {
    return state.allowed_branch_name.trim();
  }
  if (typeof state?.branch?.name === "string" && state.branch.name.trim()) {
    return state.branch.name.trim();
  }
  return null;
}

function extractAutomationStateJson(body) {
  const match = String(body || "").match(automationStateRegex());
  return match ? match[1].trim() : null;
}

function formatAutomationStateBlock(state) {
  return [
    "<!-- protected:start -->",
    `${STATE_START}\n${JSON.stringify(state, null, 2)}\n${STATE_END}`,
    "<!-- protected:end -->",
  ].join("\n");
}

function automationStateRegex() {
  return /<!-- automation-state:start\s*([\s\S]*?)\s*automation-state:end -->/;
}

function wrappedAutomationStateRegex() {
  return /\s*<!-- protected:start -->\s*<!-- automation-state:start\s*[\s\S]*?\s*automation-state:end -->\s*<!-- protected:end -->\s*/;
}

function managedBranchBlockRegex() {
  return /\s*<!-- protected:start -->\s*<!-- managed-branch:start -->[\s\S]*?<!-- managed-branch:end -->\s*<!-- protected:end -->\s*/;
}

function encodeBranchPath(branchName) {
  return String(branchName || "").split("/").map(encodeURIComponent).join("/");
}
