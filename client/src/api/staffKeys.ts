import axios from 'axios';

/**
 * Result of probing the API with an operational staff key (issue #136).
 *
 * - `valid`: the server accepted the key.
 * - `invalid`: the server rejected the credential (401/403).
 * - `unavailable`: the probe could not decide (network failure, 5xx, ...).
 */
export type KeyValidation = 'valid' | 'invalid' | 'unavailable';

function errorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const { response } = error as { response?: { status?: number } };
    return response?.status;
  }
  return undefined;
}

/**
 * Probe a staff route with a candidate key before the key is persisted
 * client-side. The probe deliberately omits the donor session cookie
 * (`withCredentials: false`) so the key is validated on its own — an active
 * donor session must not mask an invalid key. Never rejects.
 */
async function probeKey(url: string, authorization: string): Promise<KeyValidation> {
  try {
    await axios.get(url, {
      headers: { Authorization: authorization },
      withCredentials: false,
      timeout: 10_000,
    });
    return 'valid';
  } catch (error) {
    const status = errorStatus(error);
    return status === 401 || status === 403 ? 'invalid' : 'unavailable';
  }
}

/** Validate an operational admin key (`Authorization: Bearer key_admin_<key>`). */
export const validateAdminKey = (key: string): Promise<KeyValidation> =>
  probeKey('/api/admin/stats', `Bearer key_admin_${key}`);

/** Validate an operational moderator key (`Authorization: Bearer key_mod_<key>`). */
export const validateModeratorKey = (key: string): Promise<KeyValidation> =>
  probeKey('/api/moderator/stats', `Bearer key_mod_${key}`);
