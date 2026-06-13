/**
 * Secret read/update over /secrets/resource/{resourceId}.json.
 *
 * Returns the raw armored ciphertext for KeyContext to decrypt — no crypto
 * happens here. The current user only ever sees their own secret row for a
 * resource (one Secret per user per resource).
 */
import { api } from '../api';
import type { ApiResponse, Secret } from '../types';

/** GET /secrets/resource/{resourceId}.json — current user's secret (READ perm). */
export async function getSecretForResource(resourceId: string): Promise<Secret> {
  const res = await api.get<ApiResponse<Secret>>(
    `/secrets/resource/${resourceId}.json`
  );
  return res.data.body as Secret;
}

/** PUT /secrets/resource/{resourceId}.json — replace the armored data (UPDATE perm). */
export async function updateSecretForResource(
  resourceId: string,
  data: string
): Promise<Secret> {
  const res = await api.put<ApiResponse<Secret>>(
    `/secrets/resource/${resourceId}.json`,
    { data }
  );
  return res.data.body as Secret;
}
