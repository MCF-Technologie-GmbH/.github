import { branchMethods } from "./branches.js";
import { BaseGitHubClient, createInstallationAccessToken } from "./client.js";
import { commentMethods } from "./comments.js";
import { fieldMethods } from "./fields.js";
import { issueMethods } from "./issues.js";
import { projectMethods } from "./projects.js";
import { pullMethods } from "./pulls.js";

export { createInstallationAccessToken };

export class GitHubClient extends BaseGitHubClient {}

Object.assign(
  GitHubClient.prototype,
  issueMethods,
  commentMethods,
  branchMethods,
  pullMethods,
  fieldMethods,
  projectMethods
);
