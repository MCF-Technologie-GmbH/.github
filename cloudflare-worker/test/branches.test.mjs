import assert from "node:assert/strict";
import test from "node:test";
import {
  handleBranchCommand,
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
    async getReference() {
      return { object: { sha: "abc123" } };
    },
    async createLinkedBranch(input) {
      assert.equal(input.branchName, "feature/123-add-login");
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
    async getReference() {
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
      ref: "feature/123-add-login",
      sender: { login: "mark" },
    },
  });

  assert.equal(result.deleted, true);
  assert.deepEqual(deleted, ["heads/feature/123-add-login"]);
  assert.equal(comments[0].issueNumber, 123);
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

test("handleCreateEvent allows bot-created branches only with matching reservation", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature"),
    {
      issue_type: "feature",
      branch: {
        name: "feature/123-add-login",
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
      return { body };
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
      ref: "feature/123-add-login",
      sender: { login: "mcf-automation-bot[bot]" },
    },
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(deleted, []);
});

test("handlePullRequestEvent records valid PR number", async () => {
  const body = replaceAutomationState(
    ensureAutomationState("<!-- protected:start -->\nBody\n<!-- protected:end -->", "Feature"),
    {
      issue_type: "feature",
      branch: {
        name: "feature/123-add-login",
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
      return { body };
    },
    async updateIssueTitleAndBody(_owner, _repo, _issueNumber, _title, nextBody) {
      updatedBody = nextBody;
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
        head: { ref: "feature/123-add-login" },
        base: { ref: "dev" },
      },
    },
  });

  assert.equal(result.valid, true);
  assert.match(updatedBody, /"pr": 456/);
});
