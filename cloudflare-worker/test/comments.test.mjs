import assert from "node:assert/strict";
import test from "node:test";
import { handleIssueCommentEvent, handleIssueCommentProtectionEvent } from "../src/handlers/comments.js";
import { withCommandLog } from "../src/utils/comment-log.js";

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
    async listIssueComments() {
      return [];
    },
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
    comment: { id: 3, body: "/branch repair", user: { login: "Lagarie404" } },
  });

  assert.equal(processed.processed, true);
  assert.equal(processed.command, "branch repair");
});

test("handleIssueCommentEvent treats /branch delete as a branch command", async () => {
  let latestBody = [
    "<!-- protected:start -->",
    "Body",
    "<!-- protected:end -->",
    "",
    "<!-- protected:start -->",
    "<!-- automation-state:start",
    JSON.stringify({
      original_issue_type: "Feature",
      allowed_branch_name: "feat/123-add-login",
      branch: { exists: true, linked: true, error: null, pr: null },
    }, null, 2),
    "automation-state:end -->",
    "<!-- protected:end -->",
  ].join("\n");
  const deletedRefs = [];
  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "Add login",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Feature" },
        linkedBranches: { nodes: [] },
      };
    },
    async getReference(_owner, _repo, ref) {
      assert.equal(ref, "heads/feat/123-add-login");
      return { object: { sha: "abc123" } };
    },
    async deleteReference(_owner, _repo, ref) {
      deletedRefs.push(ref);
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async createComment() {},
    async deleteComment() {},
  };

  const processed = await handleIssueCommentEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    repoFullName: "mcf-technologie-gmbh/app",
    issueNumber: 123,
    comment: { id: 4, body: "/branch delete", user: { login: "Lagarie404" } },
  });

  assert.equal(processed.processed, true);
  assert.equal(processed.command, "branch delete");
  assert.deepEqual(deletedRefs, ["heads/feat/123-add-login"]);
});

test("withCommandLog folds previous bot comments into the next bot response", async () => {
  const deleted = [];
  const createdComments = [];
  class FakeGitHub {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "Add login",
        body: "<!-- protected:start -->\nBody\n<!-- protected:end -->",
        repository: { id: "REPO_id" },
        issueType: { name: "Feature" },
        linkedBranches: { nodes: [] },
      };
    }

    async updateIssueTitleAndBody() {}

    async listIssueComments() {
      return [
        {
          id: 10,
          user: { login: "mcf-automation-bot[bot]" },
          created_at: "2026-06-24T08:00:00Z",
          body: [
            "old bot response",
            "",
            "<details><summary>Command log</summary>",
            "<p>",
            "older nested log",
            "</p>",
            "</details>",
            '<!-- command-log:meta',
            '{"actor":"Mark-Lagarie","command":"/branch repair","history":[{"actor":"Lagarie404","command":"/branch create","createdAt":"2026-06-24T07:50:00Z","body":"created earlier"}]}',
            'command-log:end -->',
          ].join("\n"),
        },
        { id: 11, user: { login: "mark" }, body: "user comment" },
      ];
    }

    async createComment(_owner, _repo, _issueNumber, body) {
      createdComments.push(body);
    }

    async deleteComment(_owner, _repo, commentId) {
      deleted.push(commentId);
    }
  }

  const gh = withCommandLog(new FakeGitHub());
  const processed = await handleIssueCommentEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    repoFullName: "mcf-technologie-gmbh/app",
    issueNumber: 123,
    comment: { id: 3, body: "/branch repair", user: { login: "Lagarie404" } },
  });

  assert.equal(processed.processed, true);
  assert.deepEqual(deleted, [10, 3]);
  assert.equal(createdComments.length, 1);
  assert.ok(createdComments.at(-1).indexOf("old bot response") < createdComments.at(-1).indexOf("created earlier"));
  assert.match(createdComments.at(-1), /Nothing to repair/);
  assert.match(createdComments.at(-1), /<details><summary>Bot log<\/summary>/);
  assert.match(createdComments.at(-1), /#### 2026-06-24 07:50:00 UTC/);
  assert.match(createdComments.at(-1), /Command: `\/branch create`/);
  assert.match(createdComments.at(-1), /Executed by: @Lagarie404/);
  assert.match(createdComments.at(-1), /Output:\n```text\ncreated earlier\n```/);
  assert.match(createdComments.at(-1), /#### 2026-06-24 08:00:00 UTC/);
  assert.match(createdComments.at(-1), /Command: `\/branch repair`/);
  assert.match(createdComments.at(-1), /Executed by: @Mark-Lagarie/);
  assert.match(createdComments.at(-1), /Output:\n```text\nold bot response\n```/);
  assert.match(createdComments.at(-1), /old bot response/);
  assert.doesNotMatch(createdComments.at(-1), /older nested log/);
  assert.doesNotMatch(createdComments.at(-1), /user comment/);
  assert.match(createdComments.at(-1), /<!-- command-log:meta\n\{"actor":"Lagarie404","command":"\/branch repair","history":\[/);
});

test("withCommandLog createCommentRaw bypasses decoration and cleanup", async () => {
  const created = [];
  let listed = false;
  let deleted = false;
  const gh = withCommandLog({
    async listIssueComments() {
      listed = true;
      return [];
    },
    async deleteComment() {
      deleted = true;
    },
    async createCommentRaw(_owner, _repo, issueNumber, body) {
      created.push({ issueNumber, body });
    },
    async createComment() {
      throw new Error("decorated createComment should not be used");
    },
  });

  await gh.createCommentRaw("MCF-Technologie-GmbH", "app", 123, "plain body");

  assert.deepEqual(created, [{ issueNumber: 123, body: "plain body" }]);
  assert.equal(listed, false);
  assert.equal(deleted, false);
});

test("handleIssueCommentProtectionEvent restores edited bot comments", async () => {
  const updates = [];
  const gh = {
    async updateComment(_owner, _repo, commentId, body) {
      updates.push({ commentId, body });
    },
  };

  const result = await handleIssueCommentProtectionEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 123,
    action: "edited",
    comment: {
      id: 10,
      body: "tampered",
      user: { login: "mcf-automation-bot[bot]" },
    },
    changes: {
      body: { from: "original bot comment" },
    },
  });

  assert.equal(result.protected, true);
  assert.deepEqual(updates, [{ commentId: 10, body: "original bot comment" }]);
});

test("handleIssueCommentProtectionEvent recreates deleted bot comments without log decoration", async () => {
  const created = [];
  const gh = {
    async createCommentRaw(_owner, _repo, issueNumber, body) {
      created.push({ issueNumber, body });
    },
    async createComment() {
      throw new Error("decorated createComment should not be used");
    },
  };

  const result = await handleIssueCommentProtectionEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 123,
    action: "deleted",
    comment: {
      id: 10,
      body: "original bot comment",
      user: { login: "mcf-automation-bot[bot]" },
    },
  });

  assert.equal(result.protected, true);
  assert.deepEqual(created, [{ issueNumber: 123, body: "original bot comment" }]);
});

test("handleIssueCommentProtectionEvent ignores user-owned comments", async () => {
  const gh = {
    async updateComment() {
      throw new Error("should not update user comments");
    },
  };

  const result = await handleIssueCommentProtectionEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 123,
    action: "edited",
    comment: {
      id: 10,
      body: "user comment",
      user: { login: "mark" },
    },
    changes: {
      body: { from: "old user comment" },
    },
  });

  assert.equal(result.processed, false);
  assert.equal(result.reason, "comment is not owned by automation bot");
});
