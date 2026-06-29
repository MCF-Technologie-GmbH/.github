export const commentMethods = {
  async createComment(owner, repo, issueNumber, body) {
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      { body }
    );
  },

  async createCommentRaw(owner, repo, issueNumber, body) {
    return this.createComment(owner, repo, issueNumber, body);
  },

  async listIssueComments(owner, repo, issueNumber) {
    return this.rest(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`
    );
  },

  async deleteComment(owner, repo, commentId) {
    return this.rest(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`
    );
  },

  async updateComment(owner, repo, commentId, body) {
    return this.rest(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`,
      { body }
    );
  },

  async createCommentReaction(owner, repo, commentId, content) {
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/reactions`,
      { content }
    );
  },
};
