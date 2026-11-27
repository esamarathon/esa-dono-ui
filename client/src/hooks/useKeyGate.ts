import { useCallback, useEffect, useState } from 'react';
import { getDonor } from '../api/donor';
import { validateAdminKey, validateModeratorKey, type KeyValidation } from '../api/staffKeys';
import { hasAdminAccess, hasModeratorAccess, type Role } from '../types';
import { isSessionActive } from '../utils/authToken';

export type AccessState = 'checking' | 'granted' | 'denied';

export interface KeyGateOptions {
  /** localStorage slot holding the operational key for this surface. */
  storageKey: string;
  /** Probes the API with a candidate key; must not reject. */
  validateKey: (key: string) => Promise<KeyValidation>;
  /** Role predicate for the donor-session fallback (ADR 0003/0004). */
  hasRoleAccess: (role: Role | string | null | undefined) => boolean;
  /** Error shown when the form is submitted without a key. */
  enterKeyError: string;
  /** Error shown when the server rejects the key (401/403). */
  invalidKeyError: string;
  /** Error shown when the key cannot be verified (network failure, 5xx). */
  unavailableError: string;
}

export interface KeyGate {
  access: AccessState;
  error: string;
  input: string;
  setInput: (value: string) => void;
  /** True while a submitted key is being verified. */
  pending: boolean;
  /** The validated key in use; '' when access is granted by donor session. */
  key: string;
  login: () => void;
  logout: () => void;
}

/**
 * Shared login gate for the admin and moderator layouts (issue #136).
 *
 * A key is persisted to localStorage and unlocks the dashboard chrome only
 * after a successful validation probe. A rejected key (401/403) or an
 * unverifiable one (network/5xx) keeps the login form with an inline error and
 * is never persisted. A stored key is revalidated on load: one the server
 * rejects is cleared and ignored, so a stale key can no longer render a broken
 * dashboard shell.
 *
 * Callers must pass stable function identities (module-level functions), as the
 * role-specific wrappers below do.
 */
export function useKeyGate(options: KeyGateOptions): KeyGate {
  const {
    storageKey,
    validateKey,
    hasRoleAccess,
    enterKeyError,
    invalidKeyError,
    unavailableError,
  } = options;
  const [access, setAccess] = useState<AccessState>('checking');
  const [key, setKey] = useState(() => localStorage.getItem(storageKey) ?? '');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const checkAccess = useCallback(async () => {
    setAccess('checking');
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      let result: KeyValidation = 'unavailable';
      try {
        result = await validateKey(stored);
      } catch {
        // Treated as 'unavailable' below.
      }
      if (result === 'valid') {
        setKey(stored);
        setError('');
        setAccess('granted');
        return;
      }
      if (result === 'invalid') {
        // A stored key the server rejects is cleared and ignored; fall
        // through to the donor-session check below.
        localStorage.removeItem(storageKey);
        setKey('');
        setError(invalidKeyError);
      } else {
        // Cannot verify (network/5xx): keep the stored key — do not destroy a
        // possibly valid credential on a transient failure — and ask the user
        // to retry instead of rendering an unverified dashboard shell.
        setError(unavailableError);
        setAccess('denied');
        return;
      }
    }
    if (!isSessionActive()) {
      setAccess('denied');
      return;
    }
    getDonor()
      .then((donor) => {
        const granted = hasRoleAccess(donor.role);
        if (granted) setError('');
        setAccess(granted ? 'granted' : 'denied');
      })
      .catch(() => setAccess('denied'));
  }, [storageKey, validateKey, hasRoleAccess, invalidKeyError, unavailableError]);

  useEffect(() => {
    void checkAccess();
  }, [checkAccess]);

  const login = useCallback(() => {
    const candidate = input.trim();
    if (!candidate) {
      setError(enterKeyError);
      return;
    }
    if (pending) return;
    setPending(true);
    void (async () => {
      let result: KeyValidation = 'unavailable';
      try {
        result = await validateKey(candidate);
      } catch {
        // Treated as 'unavailable' below.
      }
      if (result === 'valid') {
        localStorage.setItem(storageKey, candidate);
        setKey(candidate);
        setError('');
        setAccess('granted');
      } else {
        setError(result === 'invalid' ? invalidKeyError : unavailableError);
      }
      setPending(false);
    })();
  }, [input, pending, storageKey, validateKey, enterKeyError, invalidKeyError, unavailableError]);

  const logout = useCallback(() => {
    localStorage.removeItem(storageKey);
    setKey('');
    setError('');
    void checkAccess();
  }, [storageKey, checkAccess]);

  return { access, error, input, setInput, pending, key, login, logout };
}

export function useAdminKeyGate(): KeyGate {
  return useKeyGate({
    storageKey: 'admin_key',
    validateKey: validateAdminKey,
    hasRoleAccess: hasAdminAccess,
    enterKeyError: 'Enter API key',
    invalidKeyError: 'Invalid key',
    unavailableError: 'Could not verify the key. Try again.',
  });
}

export function useModeratorKeyGate(): KeyGate {
  return useKeyGate({
    storageKey: 'moderator_key',
    validateKey: validateModeratorKey,
    hasRoleAccess: hasModeratorAccess,
    enterKeyError: 'Enter moderator key',
    invalidKeyError: 'Invalid key',
    unavailableError: 'Could not verify the key. Try again.',
  });
}
