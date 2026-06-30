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

  async getPullRequestClosingIssueNumbers(owner, repo, pullNumber) {
    const data = await this.graphql(
      `
        query PullRequestClosingIssues($owner: String!, $repo: String!, $pullNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $pullNumber) {
              closingIssuesReferences(first: 20) {
                nodes {
                  number
                }
              }
            }
          }
        }
      `,
      { owner, repo, pullNumber }
    );

    return (data.repository?.pullRequest?.closingIssuesReferences?.nodes || [])
      .map((issue) => issue?.number)
      .filter((number) => Number.isInteger(number));
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
