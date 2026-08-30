const RELEASE_BASE =
  "https://github.com/emv-dev/YoreBot/releases/download/";
const WINDOWS_INSTALLER_PATH =
  /^\/emv-dev\/YoreBot\/releases\/download\/[^/]+\/YoreBot[^/]*\.exe$/;
const MAX_URL_LENGTH = 2_048;

/**
 * Return only a complete HTTPS Windows-installer URL, byte-for-byte as
 * configured. Any missing or ambiguous value fails closed.
 */
export function getSignedReleaseUrl(
  raw = process.env.YOREBOT_SIGNED_RELEASE_URL,
) {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_URL_LENGTH ||
    raw !== raw.trim() ||
    !raw.startsWith(RELEASE_BASE)
  ) {
    return null;
  }

  let candidate;
  try {
    candidate = new URL(raw);
  } catch {
    return null;
  }

  if (
    candidate.protocol !== "https:" ||
    candidate.origin !== "https://github.com" ||
    candidate.port.length > 0 ||
    candidate.username.length > 0 ||
    candidate.password.length > 0 ||
    candidate.search.length > 0 ||
    candidate.hash.length > 0 ||
    !WINDOWS_INSTALLER_PATH.test(candidate.pathname)
  ) {
    return null;
  }

  return raw;
}
