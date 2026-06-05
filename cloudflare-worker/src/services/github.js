import { GITHUB_API_VERSION, GITHUB_GRAPHQL_FEATURES } from "../config.js";
import { createGitHubAppJwt } from "../utils/crypto.js";

export class GitHubClient {
  constructor(token) {
    this.token = token;
    this.baseUrl = "https://api.github.com";
    this.graphqlUrl = "https://api.github.com/graphql";
  }

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

  async createComment(owner, repo, issueNumber, body) {
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      { body }
    );
  }

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

  async deleteComment(owner, repo, commentId) {
    return this.rest(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`
    );
  }

  async createCommentReaction(owner, repo, commentId, content) {
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/reactions`,
      { content }
    );
  }

  async addLabels(owner, repo, issueNumber, labels) {
    if (!labels.length) return;
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`,
      { labels }
    );
  }

  async removeLabel(owner, repo, issueNumber, labelName) {
    return this.rest(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`
    );
  }
}

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
