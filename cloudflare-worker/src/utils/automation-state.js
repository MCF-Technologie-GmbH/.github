const STATE_START = "<!-- automation-state:start";
const STATE_END = "automation-state:end -->";

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
  const cleanedTitle = String(title || "")
    .replace(/^[a-zA-Z0-9_-]+\([^)]+\)\s*:\s*/, "")
    .replace(/^[a-zA-Z0-9_-]+\s*:\s*/, "");
  const slug = slugify(cleanedTitle) || "work";
  return `${prefix}/${issueNumber}-${slug}`.slice(0, 240);
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
    return {
      issue_type: typeof parsed.issue_type === "string" ? parsed.issue_type : "issue",
      branch: parsed.branch && typeof parsed.branch === "object" ? parsed.branch : null,
    };
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
export function ensureAutomationState(body, issueType) {
  const state = normalizeAutomationState(parseAutomationState(body), issueType);
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
  const normalized = normalizeAutomationState(state, state?.issue_type);
  const block = formatAutomationStateBlock(normalized);
  const text = String(body || "");
  const bodyWithoutState = text
    .replace(wrappedAutomationStateRegex(), "")
    .replace(automationStateRegex(), "")
    .trim();

  return `${bodyWithoutState}\n\n${block}`.trim();
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

function normalizeAutomationState(state, issueType) {
  const key = issueTypeKey(state?.issue_type || issueType);
  return {
    issue_type: key,
    branch: normalizeBranchState(state?.branch),
  };
}

function normalizeBranchState(branch) {
  if (!branch || typeof branch !== "object") return null;
  return {
    name: String(branch.name || ""),
    base: String(branch.base || "dev"),
    created: branch.created === true,
    linked: branch.linked === true,
    error: branch.error == null ? null : String(branch.error),
    pr: branch.pr == null ? null : Number(branch.pr),
  };
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
