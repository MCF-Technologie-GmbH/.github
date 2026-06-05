import { GITHUB_API_VERSION, GITHUB_GRAPHQL_FEATURES } from "../config.js";
import { createGitHubAppJwt } from "../utils/crypto.js";

/**
 * Client wrapper for the GitHub REST and GraphQL APIs.
 * Automatically injects authorization headers and version pinning.
 */
export class GitHubClient {
  /**
   * @param {string} token - The GitHub installation access token.
   */
  constructor(token) {
    this.token = token;
    this.baseUrl = "https://api.github.com";
    this.graphqlUrl = "https://api.github.com/graphql";
  }

  /**
   * Performs a GitHub GraphQL API query or mutation.
   *
   * @param {string} query - The GraphQL query/mutation string.
   * @param {object} variables - Variables to pass to the GraphQL query.
   * @returns {Promise<object>} Resolves to the 'data' field of the GraphQL response.
   */
  async graphql(query, variables = {}) {
    const res = await fetch(this.graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "mcf-github-automation-bot",
        "GraphQL-Features": GITHUB_GRAPHQL_FEATURES,
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
    }

    const body = JSON.parse(text);

    if (body.errors?.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
    }

    return body.data;
  }

  /**
   * Performs a GitHub REST API request.
   *
   * @param {string} method - HTTP Verb (GET, POST, PATCH, DELETE, etc.).
   * @param {string} path - The relative path (e.g. "/repos/owner/repo/issues/1").
   * @param {object} [body] - Request body object.
   * @returns {Promise<object|null>} Parsed JSON response body, or null if empty.
   */
  async rest(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "mcf-github-automation-bot",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`REST ${method} ${path} -> HTTP ${res.status}: ${text}`);
    }

    return text ? JSON.parse(text) : null;
  }

  /**
   * Retrieves an issue by repository and number.
   * Fetches metadata including custom fields (issueType) and labels.
   *
   * @param {string} owner - Repository owner login.
   * @param {string} repo - Repository name.
   * @param {number} issueNumber - GitHub issue number.
   * @returns {Promise<object>} The GraphQL Issue object.
   */
  async getIssue(owner, repo, issueNumber) {
    const data = await this.graphql(
      `query($owner: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issueNumber) {
            id
            number
            title
            body
            state
            issueType {
              id
              name
            }
            labels(first: 20) {
              nodes {
                name
              }
            }
          }
        }
      }`,
      { owner, repo, issueNumber }
    );

    if (!data.repository?.issue) {
      throw new Error(`Issue not found: ${owner}/${repo}#${issueNumber}`);
    }

    return data.repository.issue;
  }

  /**
   * Updates the Issue Type of an issue.
   *
   * @param {string} issueId - The GraphQL Node ID of the issue.
   * @param {string} issueTypeId - The GraphQL Node ID of the target Issue Type.
   * @returns {Promise<object>} Resolves to the updated issue type metadata.
   */
  async updateIssueType(issueId, issueTypeId) {
    return this.graphql(
      `mutation($issueId: ID!, $issueTypeId: ID!) {
        updateIssueIssueType(input: {
          issueId: $issueId
          issueTypeId: $issueTypeId
        }) {
          issue {
            id
            issueType {
              id
              name
            }
          }
        }
      }`,
      { issueId, issueTypeId }
    );
  }

  /**
   * Traverses the issue timeline to find the first IssueTypeChangedEvent.
   * Used to revert unauthorized issue type changes back to the original creation type.
   *
   * @param {string} owner - Repository owner login.
   * @param {string} repo - Repository name.
   * @param {number} issueNumber - GitHub issue number.
   * @returns {Promise<object|null>} The original Issue Type metadata object, or null if no change event exists.
   */
  async getOriginalIssueType(owner, repo, issueNumber) {
    const data = await this.graphql(
      `query($owner: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issueNumber) {
            timelineItems(first: 1, itemTypes: [ISSUE_TYPE_CHANGED_EVENT]) {
              nodes {
                ... on IssueTypeChangedEvent {
                  prevIssueType {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }`,
      { owner, repo, issueNumber }
    );

    const nodes = data.repository?.issue?.timelineItems?.nodes ?? [];
    return nodes[0]?.prevIssueType ?? null;
  }

  /**
   * Creates a comment on a GitHub Issue.
   *
   * @param {string} owner - Repository owner login.
   * @param {string} repo - Repository name.
   * @param {number} issueNumber - GitHub issue number.
   * @param {string} body - The Markdown body of the comment.
   * @returns {Promise<object>} The created comment REST payload.
   */
  async createComment(owner, repo, issueNumber, body) {
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      { body }
    );
  }

  /**
   * Closes a GitHub Issue.
   *
   * @param {string} owner - Repository owner login.
   * @param {string} repo - Repository name.
   * @param {number} issueNumber - GitHub issue number.
   * @param {string} [stateReason="not_planned"] - Reason for closure ('completed' or 'not_planned').
   * @returns {Promise<object>} The updated issue REST payload.
   */
  async closeIssue(owner, repo, issueNumber, stateReason = "not_planned") {
    return this.rest(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      {
        state: "closed",
        state_reason: stateReason,
      }
    );
  }

  /**
   * Retrieves all custom issue types defined at the organization level.
   *
   * @param {string} orgName - The organization login.
   * @returns {Promise<array>} Array of Issue Type objects [{ id, name }].
   */
  async getOrgIssueTypes(orgName) {
    const data = await this.graphql(
      `query($orgName: String!) {
        organization(login: $orgName) {
          issueTypes(first: 50) {
            nodes {
              id
              name
            }
          }
        }
      }`,
      { orgName }
    );
    return data.organization?.issueTypes?.nodes ?? [];
  }

  /**
   * Retrieves all custom issue fields defined at the organization level.
   * Resolves options for select fields dynamically.
   *
   * @param {string} orgName - The organization login.
   * @returns {Promise<array>} Array of Field metadata objects.
   */
  async getOrgIssueFields(orgName) {
    const data = await this.graphql(
      `query($orgName: String!) {
        organization(login: $orgName) {
          issueFields(first: 50) {
            nodes {
              ... on IssueFieldSingleSelect {
                id
                name
                options {
                  id
                  name
                }
              }
              ... on IssueFieldText { id name }
              ... on IssueFieldNumber { id name }
              ... on IssueFieldDate { id name }
            }
          }
        }
      }`,
      { orgName }
    );
    return data.organization?.issueFields?.nodes ?? [];
  }

  /**
   * Updates a custom issue field value on an issue.
   *
   * @param {string} issueId - The GraphQL Node ID of the issue.
   * @param {string} fieldId - The GraphQL Node ID of the field to update.
   * @param {object} valueInput - Object representing the value (e.g. { singleSelectOptionId: "opt-id" }).
   * @returns {Promise<object>} Resolves when the mutation finishes.
   */
  async updateIssueFieldValue(issueId, fieldId, valueInput) {
    return this.graphql(
      `mutation($issueId: ID!, $issueField: IssueFieldCreateOrUpdateInput!) {
        updateIssueFieldValue(input: {
          issueId: $issueId
          issueField: $issueField
        }) {
          issue {
            id
          }
        }
      }`,
      {
        issueId,
        issueField: {
          fieldId,
          ...valueInput,
        },
      }
    );
  }

  /**
   * Updates the title and/or body of a GitHub Issue.
   * Parameters not defined (undefined) are omitted from the update payload.
   *
   * @param {string} owner - Repository owner login.
   * @param {string} repo - Repository name.
   * @param {number} issueNumber - GitHub issue number.
   * @param {string} [title] - The new title.
   * @param {string} [body] - The new description body.
   * @returns {Promise<object>} The updated issue REST payload.
   */
  async updateIssueTitleAndBody(owner, repo, issueNumber, title, body) {
    const update = {};
    if (title !== undefined) update.title = title;
    if (body !== undefined) update.body = body;
    return this.rest(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      update
    );
  }

  /**
   * Deletes an issue comment.
   *
   * @param {string} owner - Repository owner login.
   * @param {string} repo - Repository name.
   * @param {number} commentId - The ID of the comment to delete.
   * @returns {Promise<null>}
   */
  async deleteComment(owner, repo, commentId) {
    return this.rest(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`
    );
  }

  /**
   * Adds a reaction to an issue comment.
   *
   * @param {string} owner - Repository owner login.
   * @param {string} repo - Repository name.
   * @param {number} commentId - The ID of the comment to react to.
   * @param {string} content - The reaction type (e.g. 'rocket', 'eyes', 'thumbs_up').
   * @returns {Promise<object>} The reaction payload.
   */
  async createCommentReaction(owner, repo, commentId, content) {
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/reactions`,
      { content }
    );
  }

  /**
   * Adds one or more labels to an issue.
   *
   * @param {string} owner - Repository owner login.
   * @param {string} repo - Repository name.
   * @param {number} issueNumber - GitHub issue number.
   * @param {array} labels - Array of label names to add.
   * @returns {Promise<object|undefined>} Resolves with the label response, or undefined if array is empty.
   */
  async addLabels(owner, repo, issueNumber, labels) {
    if (!labels.length) return;
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`,
      { labels }
    );
  }

  /**
   * Removes a label from an issue.
   *
   * @param {string} owner - Repository owner login.
   * @param {string} repo - Repository name.
   * @param {number} issueNumber - GitHub issue number.
   * @param {string} labelName - Name of the label to remove.
   * @returns {Promise<object>} REST response.
   */
  async removeLabel(owner, repo, issueNumber, labelName) {
    return this.rest(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`
    );
  }
}

/**
 * Generates a temporary GitHub App Installation Access Token.
 * Uses a signed JWT to call the installations access tokens endpoint.
 *
 * @param {object} env - Cloudflare Workers environment bindings (contains secret GITHUB_PRIVATE_KEY & GITHUB_APP_ID).
 * @param {number|string} installationId - The target GitHub App installation ID.
 * @returns {Promise<string>} The installation access token to authenticate client requests.
 */
export async function createInstallationAccessToken(env, installationId) {
  if (!env.GITHUB_APP_ID) {
    throw new Error("Missing Cloudflare variable: GITHUB_APP_ID");
  }

  if (!env.GITHUB_PRIVATE_KEY) {
    throw new Error("Missing Cloudflare secret: GITHUB_PRIVATE_KEY");
  }

  const jwt = await createGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "mcf-github-automation-bot",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    }
  );

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Failed to create installation token: HTTP ${res.status}: ${text}`);
  }

  const body = JSON.parse(text);

  if (!body.token) {
    throw new Error("GitHub installation token response did not include token");
  }

  return body.token;
}
