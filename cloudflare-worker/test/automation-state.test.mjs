import assert from "node:assert/strict";
import test from "node:test";
import {
  bodyLinksIssue,
  buildIssueBranchName,
  ensureAutomationState,
  extractIssueNumberFromBranch,
  parseAutomationState,
  replaceAutomationState,
} from "../src/utils/automation-state.js";

test("ensureAutomationState inserts hidden JSON in a protected block at the bottom", () => {
  const body = [
    "<!-- protected:start -->",
    "### Problem",
    "Do the work",
    "<!-- protected:end -->",
  ].join("\n");

  const updated = ensureAutomationState(body, "Feature", {
    issueNumber: 123,
    title: "Add login flow",
  });
  const state = parseAutomationState(updated);

  assert.equal(state.allowed_branch_name, "feat/123-add-login-flow");
  assert.equal(state.branch, null);
  assert.match(updated, /<!-- protected:end -->\n\n<!-- protected:start -->\n<!-- automation-state:start/);
  assert.match(updated, /automation-state:end -->\n<!-- protected:end -->$/);
});

test("replaceAutomationState updates branch metadata", () => {
  const body = ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug");
  const updated = replaceAutomationState(body, {
    issue_type: "bug",
    branch: {
      name: "fix/42-fix-login",
      base: "dev",
      created: true,
      linked: true,
      error: null,
      pr: null,
    },
  });

  assert.deepEqual(parseAutomationState(updated), {
    allowed_branch_name: "fix/42-fix-login",
    branch: {
      exists: true,
      linked: true,
      error: null,
      pr: null,
    },
  });
});

test("buildIssueBranchName uses issue type key, issue number, and title slug", () => {
  assert.equal(
    buildIssueBranchName({
      issueType: "Feature",
      issueNumber: 123,
      title: "feat(ui): Add login flow!",
    }),
    "feat/123-add-login-flow"
  );
});

test("extractIssueNumberFromBranch accepts managed names only", () => {
  assert.equal(extractIssueNumberFromBranch("feat/123-add-login"), 123);
  assert.equal(extractIssueNumberFromBranch("123-add-login"), 123);
  assert.equal(extractIssueNumberFromBranch("mark/123-add-login"), 123);
  assert.equal(extractIssueNumberFromBranch("random"), null);
});

test("bodyLinksIssue accepts refs and closing keywords", () => {
  assert.equal(bodyLinksIssue("Refs #123", 123), true);
  assert.equal(bodyLinksIssue("Closes #123", 123), true);
  assert.equal(bodyLinksIssue("Refs #124", 123), false);
});
