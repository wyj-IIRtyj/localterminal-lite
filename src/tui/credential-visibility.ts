export type CredentialKeyEvent = { name?: string; eventType: 'press' | 'repeat' | 'release' };

/**
 * Credentials are visible only while an eligible `v` key press is active.
 * Release packets are treated as a global fail-closed signal because terminal
 * protocols may omit or normalize the key name differently on key-up.
 */
export function nextCredentialVisibility(
  current: boolean,
  event: CredentialKeyEvent,
  eligible: boolean,
): boolean {
  if (event.eventType === 'release') return false;
  if (!eligible) return false;
  return event.name?.toLowerCase() === 'v' ? true : current;
}
