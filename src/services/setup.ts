/**
 * Account setup + recovery service (PHP SetupStart/SetupComplete + Recover parity).
 *
 * These endpoints run PRE-AUTHENTICATION and are GUEST-only on the backend: an
 * authenticated caller (real JWT) gets 403. The setup/recover pages are reached
 * via an emailed link before the user has a session, so a JWT is normally absent.
 * To be safe against a stale token, every call here passes an explicit
 * `Authorization: undefined` header so the api.ts request interceptor's
 * `config.headers.Authorization = Bearer ...` is overwritten back to undefined
 * (axios drops undefined headers), guaranteeing no bearer token is sent.
 *
 * Wire shapes are taken verbatim from the backend:
 *   - GET  /setup/start/{userId}/{tokenId}.json      -> body.user (SetupStartUser)
 *   - PUT|POST /setup/complete/{userId}.json         -> body null
 *   - POST /users/recover.json                       -> body null
 *   - GET  /setup/recover/start/{userId}/{tokenId}.json   -> body.user
 *   - PUT|POST /setup/recover/complete/{userId}.json      -> body null
 *
 * SECURITY: completeSetup/completeRecovery upload ONLY the armored PUBLIC key. The
 * armored private key + passphrase stay client-side and are never part of any body.
 */
import { api } from '../api';
import type { ApiResponse, SetupStartUser, User } from '../types';

/**
 * A guest (no-auth) request config. Explicitly nulls out Authorization so the
 * shared request interceptor cannot attach a stale bearer token (the backend
 * returns 403 if one is present on these guest-only endpoints).
 */
const GUEST_CONFIG = { headers: { Authorization: undefined } } as const;

/** Body shape returned by setup/start (and recover/start): `{ user }`. */
interface SetupStartBody {
  user: SetupStartUser;
}

/**
 * GET /setup/start/{userId}/{tokenId}.json — validate the setup link and return
 * the pending user (username + profile names for display). Throws (400) if the
 * link is invalid or expired.
 */
export async function startSetup(
  userId: string,
  tokenId: string,
): Promise<User> {
  const res = await api.get<ApiResponse<SetupStartBody>>(
    `/setup/start/${userId}/${tokenId}.json`,
    GUEST_CONFIG,
  );
  return res.data.body!.user;
}

/**
 * POST /setup/complete/{userId}.json — activate the account by uploading the
 * user's armored PUBLIC key and consuming the register token. Resolves void
 * (success body is JSON null).
 *
 * Only `armoredPublicKey` is sent. The private key/passphrase never leave the client.
 */
export async function completeSetup(
  userId: string,
  { token, armoredPublicKey }: { token: string; armoredPublicKey: string },
): Promise<void> {
  await api.post(
    `/setup/complete/${userId}.json`,
    {
      authentication_token: { token },
      gpgkey: { armored_key: armoredPublicKey },
    },
    GUEST_CONFIG,
  );
}

/**
 * POST /users/recover.json — request an account-recovery email. `case` selects
 * the recovery scenario (defaults to 'default'). Resolves void.
 */
export async function requestRecovery({
  username,
  recoveryCase,
}: {
  username: string;
  recoveryCase?: string;
}): Promise<void> {
  await api.post(
    '/users/recover.json',
    {
      username,
      case: recoveryCase ?? 'default',
    },
    GUEST_CONFIG,
  );
}

/**
 * GET /setup/recover/start/{userId}/{tokenId}.json — validate a recovery link and
 * return the user. Mirrors startSetup; guest-only. Throws (400) on bad/expired link.
 */
export async function startRecovery(
  userId: string,
  tokenId: string,
): Promise<User> {
  const res = await api.get<ApiResponse<SetupStartBody>>(
    `/setup/recover/start/${userId}/${tokenId}.json`,
    GUEST_CONFIG,
  );
  return res.data.body!.user;
}

/**
 * PUT|POST /setup/recover/complete/{userId}.json — finalize recovery by uploading a
 * fresh armored PUBLIC key and consuming the recovery token. Same body shape as
 * completeSetup. Resolves void. Only the public key is uploaded.
 */
export async function completeRecovery(
  userId: string,
  { token, armoredPublicKey }: { token: string; armoredPublicKey: string },
): Promise<void> {
  await api.post(
    `/setup/recover/complete/${userId}.json`,
    {
      authentication_token: { token },
      gpgkey: { armored_key: armoredPublicKey },
    },
    GUEST_CONFIG,
  );
}
