import assert from "node:assert/strict";
import test from "node:test";
import { handleIssueCommentEvent } from "../src/handlers/comments.js";
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
  assert.match(createdComments.at(-1), /Nothing to repair/);
  assert.match(createdComments.at(-1), /<details><summary>Command log<\/summary>/);
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
