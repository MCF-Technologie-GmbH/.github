import assert from "node:assert/strict";
import test from "node:test";
import { handleIssueCommentEvent } from "../src/handlers/comments.js";

test("handleIssueCommentEvent only treats /branch create as the branch creation command", async () => {
  let branchCommandCalls = 0;
  let latestBody = "<!-- protected:start -->\nBody\n<!-- protected:end -->";
  const gh = {
    async getIssue() {
      branchCommandCalls += 1;
      return {
        id: "ISSUE_id",
        title: "Add login",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Feature" },
        linkedBranches: { nodes: [] },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async getReference() {
      return { object: { sha: "abc123" } };
    },
    async createLinkedBranch() {},
    async createComment() {},
    async deleteComment() {},
  };

  const ignored = await handleIssueCommentEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    repoFullName: "mcf-technologie-gmbh/app",
    issueNumber: 123,
    comment: { id: 1, body: "/branch" },
  });

  assert.equal(ignored.processed, false);
  assert.equal(branchCommandCalls, 0);

  const processed = await handleIssueCommentEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    repoFullName: "mcf-technologie-gmbh/app",
    issueNumber: 123,
    comment: { id: 2, body: "/branch create" },
  });

  assert.equal(processed.processed, true);
  assert.equal(processed.command, "branch");
  assert.equal(branchCommandCalls > 0, true);
});

test("handleIssueCommentEvent treats /branch repair as a branch command", async () => {
  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "Add login",
        body: "<!-- protected:start -->\nBody\n<!-- protected:end -->",
        repository: { id: "REPO_id" },
        issueType: { name: "Feature" },
        linkedBranches: { nodes: [] },
      };
    },
    async updateIssueTitleAndBody() {},
    async createComment() {},
    async deleteComment() {},
  };

  const processed = await handleIssueCommentEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    repoFullName: "mcf-technologie-gmbh/app",
    issueNumber: 123,
    comment: { id: 3, body: "/branch repair" },
  });

  assert.equal(processed.processed, true);
  assert.equal(processed.command, "branch repair");
});
