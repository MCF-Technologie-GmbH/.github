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
};
