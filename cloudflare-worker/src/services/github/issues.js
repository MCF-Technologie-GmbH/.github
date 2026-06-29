export const issueMethods = {
  async getIssue(owner, repo, issueNumber) {
    const data = await this.graphql(
      `query($owner: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          id
          issue(number: $issueNumber) {
            id
            number
            title
            body
            state
            repository {
              id
              nameWithOwner
            }
            issueType {
              id
              name
            }
            linkedBranches(first: 20) {
              nodes {
                id
                ref {
                  name
                  prefix
                  target {
                    oid
                  }
                }
              }
            }
            labels(first: 20) {
              nodes {
                name
              }
            }
            issueFieldValues(first: 20) {
              nodes {
                ... on IssueFieldSingleSelectValue {
                  field {
                    ... on IssueFieldSingleSelect {
                      id
                      name
                    }
                    ... on IssueFieldText {
                      id
                      name
                    }
                    ... on IssueFieldNumber {
                      id
                      name
                    }
                    ... on IssueFieldDate {
                      id
                      name
                    }
                  }
                  name
                }
              }
            }
            projectItems(first: 10) {
              nodes {
                id
                project {
                  id
                  title
                  number
                }
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      id
                      name
                      optionId
                      field {
                        ... on ProjectV2SingleSelectField {
                          id
                          name
                        }
                      }
                    }
                  }
                }
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
  },

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
  },

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
  },

  async closeIssue(owner, repo, issueNumber, stateReason = "not_planned") {
    return this.rest(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      {
        state: "closed",
        state_reason: stateReason,
      }
    );
  },

  async reopenIssue(owner, repo, issueNumber) {
    return this.rest(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      {
        state: "open",
      }
    );
  },

  async updateIssueTitleAndBody(owner, repo, issueNumber, title, body) {
    const update = {};
    if (title !== undefined) update.title = title;
    if (body !== undefined) update.body = body;
    return this.rest(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      update
    );
  },

  async addLabels(owner, repo, issueNumber, labels) {
    if (!labels.length) return;
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`,
      { labels }
    );
  },

  async removeLabel(owner, repo, issueNumber, labelName) {
    return this.rest(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`
    );
  },
};
