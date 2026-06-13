/**
 * Comment endpoints over /comments/resource/{resourceId}.json and
 * /comments/{commentId}.json. Supports threaded children and embedded
 * creator/modifier user objects.
 */
import { api } from '../api';
import type { ApiResponse, Comment, CommentCreateRequest } from '../types';

export interface ListCommentsOptions {
  /** contain[creator]=1 — embed the comment author. */
  creator?: boolean;
  /** contain[modifier]=1 — embed the last modifier. */
  modifier?: boolean;
}

/** GET /comments/resource/{resourceId}.json — threaded comments (modified desc). */
export async function listComments(
  resourceId: string,
  opts: ListCommentsOptions = {}
): Promise<Comment[]> {
  const params: Record<string, string> = {};
  if (opts.creator) params['contain[creator]'] = '1';
  if (opts.modifier) params['contain[modifier]'] = '1';
  const res = await api.get<ApiResponse<Comment[]>>(
    `/comments/resource/${resourceId}.json`,
    { params }
  );
  return res.data.body ?? [];
}

/** POST /comments/resource/{resourceId}.json — add a comment or nested reply. */
export async function addComment(
  resourceId: string,
  req: CommentCreateRequest
): Promise<Comment> {
  const res = await api.post<ApiResponse<Comment>>(
    `/comments/resource/${resourceId}.json`,
    req
  );
  return res.data.body as Comment;
}

/** PUT /comments/{commentId}.json — edit content (creator only). */
export async function updateComment(
  commentId: string,
  content: string
): Promise<Comment> {
  const res = await api.put<ApiResponse<Comment>>(
    `/comments/${commentId}.json`,
    { content }
  );
  return res.data.body as Comment;
}

/** DELETE /comments/{commentId}.json — hard delete (creator only). */
export async function deleteComment(commentId: string): Promise<void> {
  await api.delete(`/comments/${commentId}.json`);
}
