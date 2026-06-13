/**
 * Favorite endpoints. POST marks a resource as favorite, DELETE removes it.
 *
 * The backend returns 409 when the resource is already a favorite; callers can
 * catch `FavoriteAlreadyExistsError` to treat that as a no-op.
 */
import { AxiosError } from 'axios';
import { api } from '../api';
import type { ApiResponse, Favorite } from '../types';

/** Thrown by addFavorite when the resource is already favorited (HTTP 409). */
export class FavoriteAlreadyExistsError extends Error {
  constructor(message = 'Resource is already a favorite.') {
    super(message);
    this.name = 'FavoriteAlreadyExistsError';
  }
}

/**
 * POST /favorites/resource/{foreignId}.json — mark a resource as favorite.
 * Empty JSON body. Re-throws an already-favorited 409 as
 * FavoriteAlreadyExistsError.
 */
export async function addFavorite(resourceId: string): Promise<Favorite> {
  try {
    const res = await api.post<ApiResponse<Favorite>>(
      `/favorites/resource/${resourceId}.json`,
      {}
    );
    return res.data.body as Favorite;
  } catch (err) {
    if (err instanceof AxiosError && err.response?.status === 409) {
      throw new FavoriteAlreadyExistsError(
        err.response?.data?.header?.message
      );
    }
    throw err;
  }
}

/** DELETE /favorites/{favoriteId}.json — remove a favorite (owner only). */
export async function removeFavorite(favoriteId: string): Promise<void> {
  await api.delete(`/favorites/${favoriteId}.json`);
}
