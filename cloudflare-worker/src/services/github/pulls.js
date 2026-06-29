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
};
