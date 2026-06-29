import assert from "node:assert/strict";
import test from "node:test";
import {
  handleBranchCommand,
  handleBranchDeleteCommand,
  handleBranchRepairCommand,
  handleCreateEvent,
  handlePullRequestEvent,
  handlePushEvent,
} from "../src/handlers/branches.js";
import { ensureAutomationState, replaceAutomationState } from "../src/utils/automation-state.js";

test("handleBranchCommand reserves and records a linked branch", async () => {
  const body = ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature");
  const updates = [];
  const comments = [];
  const pullRequests = [];
  let latestBody = body;
  let branchCreated = false;

  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "Add login",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Feature" },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
      updates.push(nextBody);
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") {
        if (branchCreated) return { object: { sha: "abc123" } };
        throw new Error("REST GET /git/ref/heads/feat/123-add-login -> HTTP 404: Not Found");
      }
      return { object: { sha: "abc123" } };
    },
    async createLinkedBranch(input) {
      assert.equal(input.branchName, "feat/123-add-login");
      branchCreated = true;
      return {};
    },
    async createPullRequest(input) {
      pullRequests.push(input);
      return { number: 456 };
    },
    async createComment(_owner, _repo, _issueNumber, body) {
      comments.push(body);
    },
  };

  const result = await handleBranchCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 123,
    comment: { id: 1 },
  });

  assert.equal(result.created, true);
  assert.equal(result.prCreated, false);
  assert.equal(result.pr, null);
  assert.match(updates.at(-1), /"exists": true/);
  assert.match(updates.at(-1), /"linked": true/);
  assert.match(updates.at(-1), /"pr": null/);
  assert.match(comments.at(-1), /Created linked branch/);
  assert.match(comments.at(-1), /draft PR will be created automatically after the first push/);
  assert.deepEqual(pullRequests, []);
});

test("handleBranchCommand stores creation errors and allows same-name retry", async () => {
  const body = ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature");
  let latestBody = body;

  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "Add login",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Feature" },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") {
        throw new Error("REST GET /git/ref/heads/feat/123-add-login -> HTTP 404: Not Found");
      }
      return { object: { sha: "abc123" } };
    },
    async createLinkedBranch() {
      throw new Error("CreateLinkedBranchInput is not supported");
    },
    async createComment() {},
  };

  const result = await handleBranchCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 123,
    comment: { id: 1 },
  });

  assert.equal(result.created, false);
  assert.match(latestBody, /"exists": false/);
  assert.match(latestBody, /CreateLinkedBranchInput is not supported/);
});

test("handleBranchCommand blocks old branch-name metadata without deleting it", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug"),
    {
      issue_type: "bug",
      branch: {
        name: "bug/50-test-bug-issue",
        base: "dev",
        created: true,
        linked: true,
        error: null,
        pr: null,
      },
    }
  );
  let latestBody = body;
  const comments = [];
  const deleted = [];

  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: { nodes: [] },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment(_owner, _repo, _issueNumber, commentBody) {
      comments.push(commentBody);
    },
  };

  const result = await handleBranchCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 50,
    comment: { id: 1 },
  });

  assert.equal(result.created, false);
  assert.equal(result.reason, "metadata branch does not match expected branch");
  assert.deepEqual(deleted, []);
  assert.match(latestBody, /"allowed_branch_name": "bug\/50-test-bug-issue"/);
  assert.match(comments.at(-1), /expected branch name for this issue changed/i);
});

test("handleBranchCommand does not delete unlinked expected branches", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug"),
    {
      issue_type: "fix",
      branch: {
        name: "fix/50-test-bug-issue",
        base: "dev",
        created: true,
        linked: true,
        error: null,
        pr: null,
      },
    }
  );
  let latestBody = body;
  const deleted = [];
  const comments = [];

  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: { nodes: [] },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment(_owner, _repo, _issueNumber, commentBody) {
      comments.push(commentBody);
    },
  };

  const result = await handleBranchCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 50,
    comment: { id: 1 },
  });

  assert.equal(result.created, false);
  assert.equal(result.reason, "branch metadata needs repair");
  assert.deepEqual(deleted, []);
  assert.match(latestBody, /"allowed_branch_name": "fix\/50-test-bug-issue"/);
  assert.match(latestBody, /"linked": false/);
  assert.match(comments.at(-1), /Run `\/branch repair`/);
  assert.match(comments.at(-1), /Run `\/branch delete`/);
});

test("handleBranchCommand recreates expected branch metadata when the git ref no longer exists", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug"),
    {
      issue_type: "fix",
      branch: {
        name: "fix/52-test-bug-issue",
        base: "dev",
        created: true,
        linked: false,
        error: null,
        pr: null,
      },
    }
  );
  let latestBody = body;
  const comments = [];
  const pullRequests = [];
  let branchCreated = false;
  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: { nodes: [] },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/fix/52-test-bug-issue") {
        if (branchCreated) return { object: { sha: "sha-dev" } };
        throw new Error("REST GET /git/ref/heads/fix/52-test-bug-issue -> HTTP 404: Not Found");
      }
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      throw new Error(`unexpected ref ${ref}`);
    },
    async createLinkedBranch(input) {
      assert.equal(input.branchName, "fix/52-test-bug-issue");
      branchCreated = true;
      return {};
    },
    async createPullRequest(input) {
      pullRequests.push(input);
      return { number: 457 };
    },
    async createComment(_owner, _repo, _issueNumber, body) {
      comments.push(body);
    },
  };

  const result = await handleBranchCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 52,
    comment: { id: 1 },
  });

  assert.equal(result.created, true);
  assert.equal(result.prCreated, false);
  assert.equal(result.pr, null);
  assert.match(latestBody, /"exists": true/);
  assert.match(latestBody, /"linked": true/);
  assert.match(latestBody, /"pr": null/);
  assert.match(comments.at(-1), /Created linked branch/);
  assert.deepEqual(pullRequests, []);
});

test("handleBranchCommand ignores stale linked branch reservations with null refs", async () => {
  const body = ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug");
  const comments = [];
  let latestBody = body;
  const deletedLinkedBranches = [];
  const pullRequests = [];
  let issueReads = 0;
  let branchCreated = false;
  const gh = {
    async getIssue() {
      issueReads += 1;
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: {
          nodes: issueReads === 1
            ? [{ id: "LB_1", ref: null }, { id: "LB_2", ref: null }]
            : [],
        },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/fix/50-test-bug-issue") {
        if (branchCreated) return { object: { sha: "sha-dev" } };
        throw new Error("REST GET /git/ref/heads/fix/50-test-bug-issue -> HTTP 404: Not Found");
      }
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      throw new Error(`unexpected ref ${ref}`);
    },
    async createLinkedBranch(input) {
      assert.equal(input.branchName, "fix/50-test-bug-issue");
      branchCreated = true;
      return {};
    },
    async createPullRequest(input) {
      pullRequests.push(input);
      return { number: 458 };
    },
    async deleteLinkedBranch(linkedBranchId) {
      deletedLinkedBranches.push(linkedBranchId);
    },
    async createComment(_owner, _repo, _issueNumber, body) {
      comments.push(body);
    },
  };

  const result = await handleBranchCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 50,
    comment: { id: 1 },
  });

  assert.equal(result.created, true);
  assert.equal(result.prCreated, false);
  assert.equal(result.pr, null);
  assert.deepEqual(deletedLinkedBranches, ["LB_1", "LB_2"]);
  assert.match(comments.at(-1), /Created linked branch/);
  assert.deepEqual(pullRequests, []);
});

test("handleBranchRepairCommand resets metadata when the expected branch no longer exists", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug"),
    {
      issue_type: "fix",
      branch: {
        name: "fix/50-test-bug-issue",
        base: "dev",
        created: true,
        linked: false,
        error: null,
        pr: null,
      },
    }
  );
  let latestBody = body;
  const comments = [];

  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: { nodes: [] },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async getReference() {
      throw new Error("REST GET /git/ref/heads/fix/50-test-bug-issue -> HTTP 404: Not Found");
    },
    async createComment(_owner, _repo, _issueNumber, body) {
      comments.push(body);
    },
  };

  const result = await handleBranchRepairCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 50,
  });

  assert.equal(result.reset, true);
  assert.match(latestBody, /"exists": false/);
  assert.match(comments.at(-1), /Nothing to repair: the expected branch does not exist/);
  assert.match(comments.at(-1), /Expected branch: `fix\/50-test-bug-issue`/);
});

test("handleBranchDeleteCommand deletes the managed branch and resets metadata", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug"),
    {
      issue_type: "fix",
      branch: {
        name: "fix/50-test-bug-issue",
        base: "dev",
        created: true,
        linked: true,
        error: null,
        pr: 123,
      },
    }
  );
  let latestBody = body;
  const deletedRefs = [];
  const comments = [];
  let issueReads = 0;

  const gh = {
    async getIssue() {
      issueReads += 1;
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: {
          nodes: issueReads > 1
            ? [{ id: "LB_1", ref: null }]
            : [{ id: "LB_1", ref: { name: "fix/50-test-bug-issue" } }],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      assert.equal(ref, "heads/fix/50-test-bug-issue");
      return { object: { sha: "branch-sha" } };
    },
    async deleteReference(_owner, _repo, ref) {
      deletedRefs.push(ref);
    },
    async deleteLinkedBranch(linkedBranchId) {
      assert.equal(linkedBranchId, "LB_1");
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async createComment(_owner, _repo, _issueNumber, body) {
      comments.push(body);
    },
  };

  const result = await handleBranchDeleteCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 50,
  });

  assert.equal(result.deleted, true);
  assert.equal(result.branch, "fix/50-test-bug-issue");
  assert.deepEqual(deletedRefs, ["heads/fix/50-test-bug-issue"]);
  assert.match(latestBody, /"exists": false/);
  assert.match(latestBody, /"linked": false/);
  assert.match(latestBody, /"error": null/);
  assert.match(latestBody, /"pr": 123/);
  assert.match(comments.at(-1), /Deleted the branch managed for this issue/);
  assert.match(comments.at(-1), /cannot be undone/);
});

test("handleBranchDeleteCommand deletes the visible linked branch before expected metadata branch", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug"),
    {
      allowed_branch_name: "fix/50-test-bug-issue",
      branch: {
        exists: true,
        linked: false,
        error: null,
        pr: null,
      },
    }
  );
  let latestBody = body;
  const deletedRefs = [];
  let issueReads = 0;

  const gh = {
    async getIssue() {
      issueReads += 1;
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: {
          nodes: issueReads > 1
            ? [{ id: "LB_1", ref: null }]
            : [{ id: "LB_1", ref: { name: "54-test-bug-issue" } }],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      assert.ok(["heads/fix/50-test-bug-issue", "heads/54-test-bug-issue"].includes(ref));
      return { object: { sha: "branch-sha" } };
    },
    async deleteReference(_owner, _repo, ref) {
      deletedRefs.push(ref);
    },
    async deleteLinkedBranch(linkedBranchId) {
      assert.equal(linkedBranchId, "LB_1");
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async createComment() {},
  };

  const result = await handleBranchDeleteCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 50,
  });

  assert.equal(result.deleted, true);
  assert.equal(result.branch, "54-test-bug-issue");
  assert.deepEqual(deletedRefs, ["heads/54-test-bug-issue"]);
  assert.match(latestBody, /"exists": false/);
  assert.match(latestBody, /"linked": false/);
});

test("handleBranchRepairCommand blocks ghost linked branches without resetting metadata", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug"),
    {
      issue_type: "fix",
      branch: {
        name: "fix/50-test-bug-issue",
        base: "dev",
        created: true,
        linked: true,
        error: null,
        pr: null,
      },
    }
  );
  let latestBody = body;
  const comments = [];

  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: {
          nodes: [{ ref: { name: "fix/50-test-bug-issue" } }],
        },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async getReference() {
      throw new Error("REST GET /git/ref/heads/fix/50-test-bug-issue -> HTTP 404: Not Found");
    },
    async createComment(_owner, _repo, _issueNumber, body) {
      comments.push(body);
    },
  };

  const result = await handleBranchRepairCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 50,
  });

  assert.equal(result.repaired, false);
  assert.equal(result.reason, "linked branch missing git ref");
  assert.match(latestBody, /"allowed_branch_name": "fix\/50-test-bug-issue"/);
  assert.match(latestBody, /GitHub still reports/);
  assert.match(comments.at(-1), /Run `\/branch repair` to clean the stale link/);
});

test("handleBranchRepairCommand reports stale linked branch cleanup when metadata is empty", async () => {
  const body = ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug");
  const comments = [];
  const deletedLinkedBranches = [];
  let issueReads = 0;
  const gh = {
    async getIssue() {
      issueReads += 1;
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: {
          nodes: issueReads === 1 ? [{ id: "LB_1", ref: null }] : [],
        },
      };
    },
    async updateIssueTitleAndBody() {},
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/fix/50-test-bug-issue") {
        throw new Error("REST GET /git/ref/heads/fix/50-test-bug-issue -> HTTP 404: Not Found");
      }
      throw new Error(`unexpected ref ${ref}`);
    },
    async deleteLinkedBranch(linkedBranchId) {
      deletedLinkedBranches.push(linkedBranchId);
    },
    async createComment(_owner, _repo, _issueNumber, body) {
      comments.push(body);
    },
  };

  const result = await handleBranchRepairCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 50,
  });

  assert.equal(result.repaired, true);
  assert.equal(result.cleaned, true);
  assert.equal(result.deletedLinkedBranches, 1);
  assert.deepEqual(deletedLinkedBranches, ["LB_1"]);
  assert.match(comments.at(-1), /Cleaned up stale linked branch records/);
  assert.match(comments.at(-1), /Removed records: `1`/);
});

test("handleBranchRepairCommand preserves an existing expected branch and recreates it as linked", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug"),
    {
      issue_type: "fix",
      branch: {
        name: "fix/50-test-bug-issue",
        base: "dev",
        created: true,
        linked: false,
        error: "Missing linked branch",
        pr: null,
      },
    }
  );
  let latestBody = body;
  const comments = [];
  const linkedBranches = [];
  const createdRefs = [];
  const deletedRefs = [];
  let issueReads = 0;

  const gh = {
    async getIssue() {
      issueReads += 1;
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: {
          nodes: issueReads > 1
            ? [{ ref: { name: "fix/50-test-bug-issue" } }]
            : [],
        },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async getReference(_owner, _repo, ref) {
      assert.equal(ref, "heads/fix/50-test-bug-issue");
      return { object: { sha: "branch-sha" } };
    },
    async createReference(_owner, _repo, ref, sha) {
      createdRefs.push({ ref, sha });
    },
    async deleteReference(_owner, _repo, ref) {
      deletedRefs.push(ref);
    },
    async createLinkedBranch(input) {
      linkedBranches.push(input);
      return {};
    },
    async createComment(_owner, _repo, _issueNumber, body) {
      comments.push(body);
    },
  };

  const result = await handleBranchRepairCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 50,
  });

  assert.equal(result.repaired, true);
  assert.match(result.temporaryBranch, /^temp\/fix-50-test-bug-issue-\d{14}$/);
  assert.deepEqual(createdRefs, [{
    ref: `refs/heads/${result.temporaryBranch}`,
    sha: "branch-sha",
  }]);
  assert.deepEqual(deletedRefs, [
    "heads/fix/50-test-bug-issue",
    `heads/${result.temporaryBranch}`,
  ]);
  assert.deepEqual(linkedBranches, [{
    issueId: "ISSUE_id",
    repositoryId: "REPO_id",
    branchName: "fix/50-test-bug-issue",
    baseOid: "branch-sha",
  }]);
  assert.match(latestBody, /"linked": true/);
  assert.match(latestBody, /"error": null/);
  assert.match(comments.at(-1), /Relinked branch successfully/);
  assert.doesNotMatch(comments.at(-1), /temporary/i);
});

test("handleBranchRepairCommand trusts createLinkedBranch payload before linkedBranches catches up", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug"),
    {
      issue_type: "fix",
      branch: {
        name: "fix/50-test-bug-issue",
        base: "dev",
        created: true,
        linked: false,
        error: "Missing linked branch",
        pr: null,
      },
    }
  );
  let latestBody = body;
  const deletedRefs = [];
  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: { nodes: [] },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async getReference(_owner, _repo, ref) {
      assert.equal(ref, "heads/fix/50-test-bug-issue");
      return { object: { sha: "branch-sha" } };
    },
    async createReference() {},
    async deleteReference(_owner, _repo, ref) {
      deletedRefs.push(ref);
    },
    async createLinkedBranch() {
      return {
        createLinkedBranch: {
          linkedBranch: {
            id: "LB_1",
            ref: { name: "fix/50-test-bug-issue" },
          },
        },
      };
    },
    async createComment() {},
  };

  const result = await handleBranchRepairCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 50,
  });

  assert.equal(result.repaired, true);
  assert.deepEqual(deletedRefs, [
    "heads/fix/50-test-bug-issue",
    `heads/${result.temporaryBranch}`,
  ]);
  assert.match(latestBody, /"linked": true/);
  assert.match(latestBody, /"error": null/);
});

test("handleBranchRepairCommand fails if GitHub does not report the recreated branch as linked", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug"),
    {
      issue_type: "fix",
      branch: {
        name: "fix/50-test-bug-issue",
        base: "dev",
        created: true,
        linked: false,
        error: null,
        pr: null,
      },
    }
  );
  let latestBody = body;
  const comments = [];
  const deletedRefs = [];
  const refs = new Map([
    ["heads/fix/50-test-bug-issue", "sha-dev"],
    ["heads/dev", "sha-dev"],
  ]);

  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: { nodes: [] },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async getReference(_owner, _repo, ref) {
      if (!refs.has(ref)) {
        throw new Error(`REST GET /git/ref/${ref} -> HTTP 404: Not Found`);
      }
      return { object: { sha: refs.get(ref) } };
    },
    async createReference(_owner, _repo, ref, sha) {
      refs.set(ref.replace(/^refs\//, ""), sha);
    },
    async deleteReference(_owner, _repo, ref) {
      deletedRefs.push(ref);
      refs.delete(ref);
    },
    async createLinkedBranch(input) {
      refs.set(`heads/${input.branchName}`, "sha-dev");
    },
    async createComment(_owner, _repo, _issueNumber, commentBody) {
      comments.push(commentBody);
    },
  };

  const result = await handleBranchRepairCommand({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    issueNumber: 50,
  });

  assert.equal(result.repaired, false);
  assert.equal(result.reason, "linked branch repair failed");
  assert.deepEqual(deletedRefs, [
    "heads/fix/50-test-bug-issue",
    `heads/${result.temporaryBranch}`,
  ]);
  assert.equal(refs.get("heads/fix/50-test-bug-issue"), "sha-dev");
  assert.equal(refs.has(`heads/${result.temporaryBranch}`), false);
  assert.match(latestBody, /"exists": true/);
  assert.match(latestBody, /"linked": false/);
  assert.match(latestBody, /did not report it as a linked branch/);
  assert.match(comments.at(-1), /original branch ref exists again/);
  assert.match(comments.at(-1), /I could not repair the linked branch relationship/);
});

test("handleCreateEvent deletes manual issue-shaped branches", async () => {
  const deleted = [];
  const comments = [];
  const gh = {
    async getIssue() {
      return { body: "" };
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment(_owner, _repo, issueNumber, body) {
      comments.push({ issueNumber, body });
    },
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "feat/123-add-login",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.deleted, true);
  assert.deepEqual(deleted, ["heads/feat/123-add-login"]);
  assert.equal(comments[0].issueNumber, 123);
  assert.match(comments[0].body, /This branch name is not valid for this issue/);
  assert.match(comments[0].body, /Use `\/branch create`/);
});

test("handleCreateEvent deletes sidebar-style issue branches", async () => {
  const deleted = [];
  const gh = {
    async getIssue() {
      return { body: "" };
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment() {},
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "123-add-login",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.deleted, true);
  assert.deepEqual(deleted, ["heads/123-add-login"]);
});

test("handleCreateEvent records a sidebar-linked branch based on dev", async () => {
  const body = ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature");
  let updatedBody = null;
  const deleted = [];
  const comments = [];
  const pullRequests = [];
  const gh = {
    async getIssue() {
      return {
        body,
        title: "Add login",
        issueType: { name: "Feature" },
        linkedBranches: {
          nodes: [
            {
              ref: {
                name: "feat/123-add-login",
                prefix: "refs/heads/",
                target: { oid: "sha-dev" },
              },
            },
          ],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") return { object: { sha: "sha-dev" } };
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      if (ref === "heads/feat/123-previous-login") {
        throw new Error("REST GET /git/ref/heads/feat/123-previous-login -> HTTP 404: Not Found");
      }
      throw new Error(`unexpected ref ${ref}`);
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      updatedBody = nextBody;
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createPullRequest(input) {
      pullRequests.push(input);
      return { number: 459 };
    },
    async createComment(_owner, _repo, issueNumber, body) {
      comments.push({ issueNumber, body });
    },
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "feat/123-add-login",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(deleted, []);
  assert.match(updatedBody, /"allowed_branch_name": "feat\/123-add-login"/);
  assert.match(updatedBody, /"linked": true/);
  assert.match(updatedBody, /"pr": null/);
  assert.equal(comments[0].issueNumber, 123);
  assert.match(comments[0].body, /Branch linked and recorded successfully/);
  assert.match(comments[0].body, /draft PR will be created automatically after the first push/);
  assert.match(comments[0].body, /Created from GitHub's sidebar/);
  assert.deepEqual(pullRequests, []);
});

test("handleCreateEvent repairs metadata when a manual linked branch matches expected metadata", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature"),
    {
      issue_type: "feature",
      branch: {
        name: "feat/123-add-login",
        base: "dev",
        created: true,
        linked: false,
        error: null,
        pr: null,
      },
    }
  );
  let updatedBody = null;
  const deleted = [];
  const comments = [];
  const pullRequests = [];
  const gh = {
    async getIssue() {
      return {
        body,
        title: "Add login",
        issueType: { name: "Feature" },
        linkedBranches: {
          nodes: [{ ref: { name: "feat/123-add-login" } }],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") return { object: { sha: "sha-dev" } };
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      if (ref === "heads/feat/123-previous-login") {
        throw new Error("REST GET /git/ref/heads/feat/123-previous-login -> HTTP 404: Not Found");
      }
      throw new Error(`unexpected ref ${ref}`);
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      updatedBody = nextBody;
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createPullRequest(input) {
      pullRequests.push(input);
      return { number: 460 };
    },
    async createComment(_owner, _repo, issueNumber, commentBody) {
      comments.push({ issueNumber, body: commentBody });
    },
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "feat/123-add-login",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(deleted, []);
  assert.match(updatedBody, /"allowed_branch_name": "feat\/123-add-login"/);
  assert.match(updatedBody, /"linked": true/);
  assert.match(updatedBody, /"error": null/);
  assert.match(updatedBody, /"pr": null/);
  assert.equal(comments[0].issueNumber, 123);
  assert.match(comments[0].body, /Branch manually linked and metadata repaired successfully/);
  assert.match(comments[0].body, /draft PR will be created automatically after the first push/);
  assert.deepEqual(pullRequests, []);
});

test("handleCreateEvent asks for repair before accepting a different manual linked branch when metadata exists", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature"),
    {
      issue_type: "feature",
      branch: {
        name: "feat/123-previous-login",
        base: "dev",
        created: true,
        linked: false,
        error: null,
        pr: null,
      },
    }
  );
  const deleted = [];
  const comments = [];
  const gh = {
    async getIssue() {
      return {
        body,
        title: "Add login",
        issueType: { name: "Feature" },
        linkedBranches: {
          nodes: [{ ref: { name: "feat/123-add-login" } }],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") return { object: { sha: "sha-dev" } };
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      if (ref === "heads/feat/123-previous-login") {
        throw new Error("REST GET /git/ref/heads/feat/123-previous-login -> HTTP 404: Not Found");
      }
      throw new Error(`unexpected ref ${ref}`);
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment(_owner, _repo, issueNumber, commentBody) {
      comments.push({ issueNumber, body: commentBody });
    },
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "feat/123-add-login",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.deleted, true);
  assert.equal(result.reason, "metadata branch does not match expected branch");
  assert.deepEqual(deleted, ["heads/feat/123-add-login"]);
  assert.equal(comments[0].issueNumber, 123);
  assert.match(comments[0].body, /Run `\/branch repair`/);
});

test("handleCreateEvent deletes linked branches that are not based on dev", async () => {
  const deleted = [];
  const gh = {
    async getIssue() {
      return {
        body: "",
        title: "Add login",
        linkedBranches: {
          nodes: [
            {
              ref: {
                name: "feat/123-add-login",
                prefix: "refs/heads/",
                target: { oid: "sha-main" },
              },
            },
          ],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") return { object: { sha: "sha-main" } };
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      throw new Error(`unexpected ref ${ref}`);
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment() {},
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "feat/123-add-login",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.deleted, true);
  assert.deepEqual(deleted, ["heads/feat/123-add-login"]);
});

test("handleCreateEvent deletes sidebar-linked branches with the wrong semantic name", async () => {
  const deleted = [];
  const gh = {
    async getIssue() {
      return {
        body: "",
        title: "Add login",
        issueType: { name: "Feature" },
        linkedBranches: {
          nodes: [
            {
              ref: {
                name: "wrong/123-add-login",
                prefix: "refs/heads/",
                target: { oid: "sha-dev" },
              },
            },
          ],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/wrong/123-add-login") return { object: { sha: "sha-dev" } };
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      throw new Error(`unexpected ref ${ref}`);
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment() {},
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "wrong/123-add-login",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.deleted, true);
  assert.deepEqual(deleted, ["heads/wrong/123-add-login"]);
});

test("handleCreateEvent deletes any branch without an authorization", async () => {
  const deleted = [];
  let issueWasRead = false;
  const gh = {
    async getIssue() {
      issueWasRead = true;
      return { body: "" };
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment() {},
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "random-experiment",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.deleted, true);
  assert.equal(result.issue, null);
  assert.equal(issueWasRead, false);
  assert.deepEqual(deleted, ["heads/random-experiment"]);
});

test("handleCreateEvent allows bot-created branches only with matching reservation", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature"),
    {
      issue_type: "feature",
      branch: {
        name: "feat/123-add-login",
        base: "dev",
        created: false,
        linked: false,
        error: null,
        pr: null,
      },
    }
  );
  const deleted = [];
  const gh = {
    async getIssue() {
      return {
        body,
        linkedBranches: {
          nodes: [{ ref: { name: "feat/123-add-login" } }],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") return { object: { sha: "sha-main" } };
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      throw new Error(`unexpected ref ${ref}`);
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment() {},
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "feat/123-add-login",
      sender: { login: "mcf-automation-bot[bot]" },
    },
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(deleted, []);
});

test("handleCreateEvent allows bot-created temporary repair branches", async () => {
  const deleted = [];
  const gh = {
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment() {},
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "temp/fix-50-test-bug-issue-20260624081137",
      sender: { login: "mcf-automation-bot[bot]" },
    },
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(deleted, []);
});

test("handleCreateEvent deletes user-created temporary repair branches", async () => {
  const deleted = [];
  const gh = {
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment() {},
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "temp/fix-50-test-bug-issue-20260624081137",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.deleted, true);
  assert.deepEqual(deleted, ["heads/temp/fix-50-test-bug-issue-20260624081137"]);
});

test("handleCreateEvent allows bot-created branches with matching legacy reservation", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature"),
    {
      issue_type: "feature",
      branch: {
        name: "feat/123-add-login",
        base: "main",
        created: false,
        linked: false,
        error: null,
        pr: null,
      },
    }
  );
  const deleted = [];
  const gh = {
    async getIssue() {
      return {
        body,
        linkedBranches: {
          nodes: [{ ref: { name: "feat/123-add-login" } }],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") return { object: { sha: "sha-main" } };
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      throw new Error(`unexpected ref ${ref}`);
    },
    async deleteReference(_owner, _repo, ref) {
      deleted.push(ref);
    },
    async createComment() {},
  };

  const result = await handleCreateEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref_type: "branch",
      ref: "feat/123-add-login",
      sender: { login: "mcf-automation-bot[bot]" },
    },
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(deleted, []);
});

test("handlePushEvent creates draft PR after first commit push", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature"),
    {
      allowed_branch_name: "feat/123-add-login",
      branch: {
        exists: true,
        linked: true,
        error: null,
        pr: null,
      },
    }
  );
  let updatedBody = null;
  const comments = [];
  const pullRequests = [];
  const gh = {
    async getIssue() {
      return {
        body,
        title: "Add login",
        issueType: { name: "Feature" },
        linkedBranches: {
          nodes: [{ ref: { name: "feat/123-add-login" } }],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") return { object: { sha: "sha-branch" } };
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      throw new Error(`unexpected ref ${ref}`);
    },
    async createPullRequest(input) {
      pullRequests.push(input);
      return { number: 456 };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      updatedBody = nextBody;
    },
    async createComment(_owner, _repo, issueNumber, commentBody) {
      comments.push({ issueNumber, body: commentBody });
    },
  };

  const result = await handlePushEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref: "refs/heads/feat/123-add-login",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.prCreated, true);
  assert.equal(result.pr, 456);
  assert.deepEqual(pullRequests, [{
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    title: "feat: Add login (#123)",
    head: "feat/123-add-login",
    base: "dev",
    body: "Closes #123",
    draft: true,
  }]);
  assert.match(updatedBody, /"pr": 456/);
  assert.match(comments[0].body, /Created draft PR/);
  assert.match(comments[0].body, /#456/);
});

test("handlePushEvent skips draft PR when branch still matches dev", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature"),
    {
      allowed_branch_name: "feat/123-add-login",
      branch: {
        exists: true,
        linked: true,
        error: null,
        pr: null,
      },
    }
  );
  const pullRequests = [];
  const gh = {
    async getIssue() {
      return {
        body,
        title: "Add login",
        issueType: { name: "Feature" },
        linkedBranches: {
          nodes: [{ ref: { name: "feat/123-add-login" } }],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") return { object: { sha: "sha-dev" } };
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      throw new Error(`unexpected ref ${ref}`);
    },
    async createPullRequest(input) {
      pullRequests.push(input);
      return { number: 456 };
    },
    async updateIssueTitleAndBody() {
      throw new Error("should not update issue when no PR is created");
    },
    async createComment() {
      throw new Error("should not comment when no PR is created");
    },
  };

  const result = await handlePushEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref: "refs/heads/feat/123-add-login",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.prCreated, false);
  assert.equal(result.reason, "no commits between branch and base");
  assert.deepEqual(pullRequests, []);
});

test("handlePushEvent does not duplicate a recorded draft PR", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature"),
    {
      allowed_branch_name: "feat/123-add-login",
      branch: {
        exists: true,
        linked: true,
        error: null,
        pr: 456,
      },
    }
  );
  const gh = {
    async getIssue() {
      return {
        body,
        title: "Add login",
        issueType: { name: "Feature" },
        linkedBranches: {
          nodes: [{ ref: { name: "feat/123-add-login" } }],
        },
      };
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") return { object: { sha: "sha-branch" } };
      throw new Error(`unexpected ref ${ref}`);
    },
    async createPullRequest() {
      throw new Error("should not create duplicate PR");
    },
    async updateIssueTitleAndBody() {
      throw new Error("should not update duplicate PR metadata");
    },
    async createComment() {
      throw new Error("should not comment for duplicate PR");
    },
  };

  const result = await handlePushEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      ref: "refs/heads/feat/123-add-login",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.prCreated, false);
  assert.equal(result.pr, 456);
  assert.equal(result.reason, "draft pull request already recorded");
});

test("handlePullRequestEvent records valid PR number", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature"),
    {
      issue_type: "feature",
      branch: {
        name: "feat/123-add-login",
        base: "dev",
        created: true,
        linked: true,
        error: null,
        pr: null,
      },
    }
  );
  let updatedBody = null;
  const gh = {
    async getIssue() {
      return {
        body,
        linkedBranches: {
          nodes: [{ ref: { name: "feat/123-add-login" } }],
        },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      updatedBody = nextBody;
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") return { object: { sha: "sha-dev" } };
      throw new Error(`unexpected ref ${ref}`);
    },
    async createComment() {
      throw new Error("should not comment for valid PR");
    },
  };

  const result = await handlePullRequestEvent({
    gh,
    owner: "MCF-Technologie-GmbH",
    repo: "app",
    payload: {
      action: "opened",
      pull_request: {
        number: 456,
        body: "Refs #123",
        head: { ref: "feat/123-add-login" },
        base: { ref: "dev" },
      },
    },
  });

  assert.equal(result.valid, true);
  assert.match(updatedBody, /"pr": 456/);
});
