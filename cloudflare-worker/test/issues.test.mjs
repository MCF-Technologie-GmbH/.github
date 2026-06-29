import assert from "node:assert/strict";
import test from "node:test";
import { enforceIssueTypePolicy } from "../src/handlers/issues.js";

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
