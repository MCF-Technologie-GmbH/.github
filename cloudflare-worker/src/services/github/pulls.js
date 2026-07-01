export const pullMethods = {
  async createPullRequest({ owner, repo, title, head, base, body, draft = false }) {
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      {
        title,
        head,
        base,
        body,
        draft,
      }
    );
  },

  async getPullRequest(owner, repo, pullNumber) {
    return this.rest(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`
    );
  },

  async listPullRequests(owner, repo, { state, head, base, sort, direction, perPage } = {}) {
    const params = new URLSearchParams();
    if (state !== undefined) params.set("state", state);
    if (head !== undefined) params.set("head", head);
    if (base !== undefined) params.set("base", base);
    if (sort !== undefined) params.set("sort", sort);
    if (direction !== undefined) params.set("direction", direction);
    if (perPage !== undefined) params.set("per_page", String(perPage));
    const query = params.toString();
    return this.rest(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls${query ? `?${query}` : ""}`
    );
  },

  async listIssueClosingPullRequests(owner, repo, issueNumber, { includeClosedPrs = true, first = 20 } = {}) {
    const data = await this.graphql(
      `query($owner: String!, $repo: String!, $issueNumber: Int!, $first: Int!, $includeClosedPrs: Boolean!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issueNumber) {
            closedByPullRequestsReferences(first: $first, includeClosedPrs: $includeClosedPrs) {
              nodes {
                number
                title
                body
                state
                headRefName
                baseRefName
              }
            }
          }
        }
      }`,
      { owner, repo, issueNumber, first, includeClosedPrs }
    );
    return data.repository?.issue?.closedByPullRequestsReferences?.nodes || [];
  },

  async updatePullRequest(owner, repo, pullNumber, { title, body, state } = {}) {
    const update = {};
    if (title !== undefined) update.title = title;
    if (body !== undefined) update.body = body;
    if (state !== undefined) update.state = state;
    return this.rest(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
      update
    );
  },

  async closePullRequest(owner, repo, pullNumber) {
    return this.updatePullRequest(owner, repo, pullNumber, { state: "closed" });
  },

  async reopenPullRequest(owner, repo, pullNumber) {
    return this.updatePullRequest(owner, repo, pullNumber, { state: "open" });
  },
};
