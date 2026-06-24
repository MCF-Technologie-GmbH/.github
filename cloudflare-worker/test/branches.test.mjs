import assert from "node:assert/strict";
import test from "node:test";
import {
  handleBranchCommand,
  handleBranchRepairCommand,
  handleCreateEvent,
  handlePullRequestEvent,
} from "../src/handlers/branches.js";
import { ensureAutomationState, replaceAutomationState } from "../src/utils/automation-state.js";

test("handleBranchCommand reserves and records a linked branch", async () => {
  const body = ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature");
  const updates = [];
  const comments = [];
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
      updates.push(nextBody);
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/feat/123-add-login") {
        throw new Error("REST GET /git/ref/heads/feat/123-add-login -> HTTP 404: Not Found");
      }
      return { object: { sha: "abc123" } };
    },
    async createLinkedBranch(input) {
      assert.equal(input.branchName, "feat/123-add-login");
      return {};
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
  assert.match(updates.at(-1), /"created": true/);
  assert.match(updates.at(-1), /"linked": true/);
  assert.match(comments.at(-1), /Created linked branch/);
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
  assert.match(latestBody, /"created": false/);
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
  assert.match(latestBody, /"name": "bug\/50-test-bug-issue"/);
  assert.match(comments.at(-1), /Recorded branch metadata points to/);
});

test("handleBranchCommand does not delete unlinked recorded branches", async () => {
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
  assert.match(latestBody, /"name": "fix\/50-test-bug-issue"/);
  assert.match(latestBody, /"linked": true/);
  assert.match(comments.at(-1), /Run `\/branch repair`/);
});

test("handleBranchCommand ignores stale linked branch reservations with null refs", async () => {
  const body = ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug");
  const comments = [];
  let latestBody = body;
  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body: latestBody,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: { nodes: [{ ref: null }, { ref: null }] },
      };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      latestBody = nextBody;
    },
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/fix/50-test-bug-issue") {
        throw new Error("REST GET /git/ref/heads/fix/50-test-bug-issue -> HTTP 404: Not Found");
      }
      if (ref === "heads/dev") return { object: { sha: "sha-dev" } };
      throw new Error(`unexpected ref ${ref}`);
    },
    async createLinkedBranch(input) {
      assert.equal(input.branchName, "fix/50-test-bug-issue");
      return {};
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
  assert.match(comments.at(-1), /Created linked branch/);
});

test("handleBranchRepairCommand resets metadata when the recorded branch no longer exists", async () => {
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
  assert.match(latestBody, /"branch": null/);
  assert.match(comments.at(-1), /Nothing to repair: the recorded branch no longer exists/);
  assert.match(comments.at(-1), /Removed metadata for: `fix\/50-test-bug-issue`/);
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
  assert.match(latestBody, /"name": "fix\/50-test-bug-issue"/);
  assert.match(latestBody, /GitHub still reports/);
  assert.match(comments.at(-1), /Remove the stale linked branch from the issue sidebar/);
});

test("handleBranchRepairCommand ignores stale linked branch reservations when metadata is empty", async () => {
  const body = ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Bug");
  const comments = [];
  const gh = {
    async getIssue() {
      return {
        id: "ISSUE_id",
        title: "fix: test-bug-issue",
        body,
        repository: { id: "REPO_id" },
        issueType: { name: "Bug" },
        linkedBranches: { nodes: [{ ref: null }] },
      };
    },
    async updateIssueTitleAndBody() {},
    async getReference(_owner, _repo, ref) {
      if (ref === "heads/fix/50-test-bug-issue") {
        throw new Error("REST GET /git/ref/heads/fix/50-test-bug-issue -> HTTP 404: Not Found");
      }
      throw new Error(`unexpected ref ${ref}`);
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
  assert.equal(result.reason, "no branch metadata");
  assert.match(comments.at(-1), /does not have recorded branch metadata/);
});

test("handleBranchRepairCommand preserves an existing recorded branch and recreates it as linked", async () => {
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
      return { object: { sha: "branch-sha" } };
    },
    async createReference() {},
    async deleteReference(_owner, _repo, ref) {
      deletedRefs.push(ref);
    },
    async createLinkedBranch() {},
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
  assert.deepEqual(deletedRefs, ["heads/fix/50-test-bug-issue"]);
  assert.match(latestBody, /"linked": false/);
  assert.match(latestBody, /did not report it as a linked branch/);
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
  assert.match(comments[0].body, /Prefer `\/branch create`/);
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
  assert.match(updatedBody, /"name": "feat\/123-add-login"/);
  assert.match(updatedBody, /"base": "dev"/);
  assert.match(updatedBody, /"linked": true/);
  assert.equal(comments[0].issueNumber, 123);
  assert.match(comments[0].body, /Branch linked and recorded successfully/);
  assert.match(comments[0].body, /Created from GitHub's sidebar/);
});

test("handleCreateEvent repairs metadata when a manual linked branch matches recorded metadata", async () => {
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
  assert.match(updatedBody, /"name": "feat\/123-add-login"/);
  assert.match(updatedBody, /"linked": true/);
  assert.match(updatedBody, /"error": null/);
  assert.equal(comments[0].issueNumber, 123);
  assert.match(comments[0].body, /Branch manually linked and metadata repaired successfully/);
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

test("handleCreateEvent rejects bot-created branches reserved from a non-dev base", async () => {
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

  assert.equal(result.deleted, true);
  assert.deepEqual(deleted, ["heads/feat/123-add-login"]);
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
