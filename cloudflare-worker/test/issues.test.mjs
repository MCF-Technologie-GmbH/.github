import assert from "node:assert/strict";
import test from "node:test";
import { enforceIssueTypePolicy } from "../src/handlers/issues.js";
import { ensureAutomationState } from "../src/utils/automation-state.js";

function createIssue(overrides = {}) {
  return {
    id: "ISSUE_id",
    title: "Add login flow",
    body: [
      "### Issue Type",
      "",
      "Feature",
      "",
      "### Scope",
      "",
      "ui",
      "",
      "### Priority",
      "",
      "High",
      "",
      "### Effort",
      "",
      "M",
      "",
      "### Description",
      "",
      "Build the login flow.",
    ].join("\n"),
    labels: { nodes: [] },
    issueFieldValues: { nodes: [] },
    ...overrides,
  };
}

function createBugIssueWithIssueTypeDropdown(overrides = {}) {
  return createIssue({
    title: "Crash after reconnect",
    body: [
      "### Issue Type",
      "",
      "Bug",
      "",
      "### Current Behavior",
      "",
      "The device stays offline.",
      "",
      "### Expected Behavior",
      "",
      "The device becomes online.",
      "",
      "### Frequency",
      "",
      "Always reproducible",
      "",
      "### Steps to Reproduce",
      "",
      "Reconnect the device.",
    ].join("\n"),
    ...overrides,
  });
}

test("enforceIssueTypePolicy does not add conventional type prefixes on issue creation", async () => {
  const updates = [];
  const gh = {
    async updateIssueType() {
      throw new Error("issue type should already match");
    },
    async createComment() {
      throw new Error("should not comment");
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, title, body) {
      updates.push({ title, body });
    },
    async addLabels() {},
    async removeLabel() {},
    async updateIssueFieldValue() {},
  };

  const result = await enforceIssueTypePolicy({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    repoFullName: "mcf-technologie-gmbh/app",
    issueNumber: 123,
    action: "opened",
    currentIssue: createIssue(),
    currentType: "Feature",
    changes: {},
    typeMap: new Map([["Feature", "TYPE_feature"]]),
    scopeField: null,
    priorityField: null,
    effortField: null,
  });

  assert.equal(result.title, "Add login flow");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].title, undefined);
  assert.match(updates[0].body, /### Description/);
  assert.doesNotMatch(updates[0].body, /### Issue Type/);
});

test("enforceIssueTypePolicy corrects changed issue type from issue type dropdown on creation", async () => {
  const typeUpdates = [];
  const comments = [];
  const updates = [];
  const gh = {
    async updateIssueType(issueId, issueTypeId) {
      typeUpdates.push({ issueId, issueTypeId });
    },
    async createComment(_owner, _repo, issueNumber, body) {
      comments.push({ issueNumber, body });
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, title, body) {
      updates.push({ title, body });
    },
    async addLabels() {},
    async removeLabel() {},
    async updateIssueFieldValue() {},
  };

  const result = await enforceIssueTypePolicy({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    repoFullName: "mcf-technologie-gmbh/app",
    issueNumber: 123,
    action: "opened",
    currentIssue: createBugIssueWithIssueTypeDropdown(),
    currentType: "Feature",
    changes: {},
    typeMap: new Map([["Bug", "TYPE_bug"], ["Feature", "TYPE_feature"]]),
    scopeField: null,
    priorityField: null,
    effortField: null,
  });

  assert.equal(result.currentType, "Bug");
  assert.deepEqual(typeUpdates, [{ issueId: "ISSUE_id", issueTypeId: "TYPE_bug" }]);
  assert.match(comments[0].body, /automatically corrected to `Bug`/);
  assert.match(updates[0].body, /"original_issue_type": "Bug"/);
});

test("enforceIssueTypePolicy corrects project type from issue type dropdown instead of closing on creation", async () => {
  const typeUpdates = [];
  const comments = [];
  const closed = [];
  const gh = {
    async updateIssueType(issueId, issueTypeId) {
      typeUpdates.push({ issueId, issueTypeId });
    },
    async createComment(_owner, _repo, issueNumber, body) {
      comments.push({ issueNumber, body });
    },
    async updateIssueTitleAndBody() {},
    async closeIssue(issueId) {
      closed.push(issueId);
    },
    async addLabels() {},
    async removeLabel() {},
    async updateIssueFieldValue() {},
  };

  const result = await enforceIssueTypePolicy({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    repoFullName: "mcf-technologie-gmbh/app",
    issueNumber: 123,
    action: "opened",
    currentIssue: createBugIssueWithIssueTypeDropdown(),
    currentType: "Project",
    changes: {},
    typeMap: new Map([["Bug", "TYPE_bug"], ["Project", "TYPE_project"]]),
    scopeField: null,
    priorityField: null,
    effortField: null,
  });

  assert.equal(result.currentType, "Bug");
  assert.deepEqual(typeUpdates, [{ issueId: "ISSUE_id", issueTypeId: "TYPE_bug" }]);
  assert.deepEqual(closed, []);
  assert.match(comments[0].body, /automatically corrected to `Bug`/);
});

test("enforceIssueTypePolicy does not revert legacy scope prefixes in edited titles", async () => {
  const updates = [];
  const gh = {
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, title, body) {
      updates.push({ title, body });
    },
    async addLabels() {},
    async removeLabel() {},
    async updateIssueFieldValue() {},
  };

  const result = await enforceIssueTypePolicy({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    repoFullName: "mcf-technologie-gmbh/app",
    issueNumber: 123,
    action: "edited",
    currentIssue: createIssue({
      title: "feat(api): Add login flow",
      body: "<!-- protected:start -->\nBody\n<!-- protected:end -->",
    }),
    currentType: "Feature",
    changes: {
      title: { from: "feat(ui): Add login flow" },
    },
    typeMap: new Map([["Feature", "TYPE_feature"]]),
    scopeField: null,
    priorityField: null,
    effortField: null,
  });

  assert.equal(result.title, "feat(api): Add login flow");
  assert.equal(result.scope, null);
  assert.deepEqual(updates, []);
});

test("enforceIssueTypePolicy reverts typed issue changes from recorded original type", async () => {
  const typeUpdates = [];
  const comments = [];
  const gh = {
    async getOriginalIssueType() {
      throw new Error("timeline should not be needed when original type is recorded");
    },
    async updateIssueType(issueId, issueTypeId) {
      typeUpdates.push({ issueId, issueTypeId });
    },
    async createComment(_owner, _repo, issueNumber, body) {
      comments.push({ issueNumber, body });
    },
  };

  const result = await enforceIssueTypePolicy({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    repoFullName: "mcf-technologie-gmbh/app",
    issueNumber: 123,
    action: "typed",
    currentIssue: createIssue({
      body: ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug", {
        issueNumber: 123,
        title: "Add login flow",
      }),
    }),
    currentType: "Feature",
    changes: {},
    typeMap: new Map([["Bug", "TYPE_bug"], ["Feature", "TYPE_feature"]]),
    scopeField: null,
    priorityField: null,
    effortField: null,
  });

  assert.equal(result.operation, "reverted");
  assert.equal(result.revertedTo, "Bug");
  assert.equal(result.source, "automation-state");
  assert.deepEqual(typeUpdates, [{ issueId: "ISSUE_id", issueTypeId: "TYPE_bug" }]);
  assert.match(comments[0].body, /The issue type was automatically reverted to `Bug`/);
});

for (const changes of [
  { type: { from: "Bug" } },
  { issue_type: { from: "Bug" } },
  { issueType: { from: "Bug" } },
]) {
  test(`enforceIssueTypePolicy reverts edited issue type changes for ${Object.keys(changes)[0]}`, async () => {
    const typeUpdates = [];
    const comments = [];
    const gh = {
      async getOriginalIssueType() {
        return { id: "TYPE_bug", name: "Bug" };
      },
      async updateIssueType(issueId, issueTypeId) {
        typeUpdates.push({ issueId, issueTypeId });
      },
      async createComment(_owner, _repo, issueNumber, body) {
        comments.push({ issueNumber, body });
      },
    };

    const result = await enforceIssueTypePolicy({
      gh,
      owner: "MCF-Technologie-GmbH",
      repo: "app",
      repoFullName: "mcf-technologie-gmbh/app",
      issueNumber: 123,
      action: "edited",
      currentIssue: createIssue({
        body: "<!-- protected:start -->\nBody\n<!-- protected:end -->",
      }),
      currentType: "Feature",
      changes,
      typeMap: new Map([["Bug", "TYPE_bug"], ["Feature", "TYPE_feature"]]),
      scopeField: null,
      priorityField: null,
      effortField: null,
    });

    assert.equal(result.operation, "reverted");
    assert.equal(result.revertedTo, "Bug");
    assert.deepEqual(typeUpdates, [{ issueId: "ISSUE_id", issueTypeId: "TYPE_bug" }]);
    assert.equal(comments[0].issueNumber, 123);
    assert.match(comments[0].body, /Issue types cannot be changed after issue creation/);
  });
}
