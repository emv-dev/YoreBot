const SAFE_HOST = /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+)(?::([1-9][0-9]{0,4}))?$/i;

function singleHeaderValue(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes(",")) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed === value ? trimmed : null;
}

function safeRequestHost(value) {
  const host = singleHeaderValue(value);
  if (!host || host.length > 253 || !SAFE_HOST.test(host)) {
    return null;
  }

  try {
    const parsed = new URL(`https://${host}`);
    const port = parsed.port ? Number(parsed.port) : null;
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      (port !== null && (!Number.isInteger(port) || port > 65_535))
    ) {
      return null;
    }
    return parsed.host;
  } catch {
    return null;
  }
}

export function getSocialImageUrl({ forwardedHost, host, forwardedProto }) {
  const protocol = singleHeaderValue(forwardedProto)?.toLowerCase();
  if (protocol !== "https") {
    return null;
  }

  const forwardedPresent = forwardedHost !== null && forwardedHost !== undefined;
  const hostPresent = host !== null && host !== undefined;
  const forwarded = forwardedPresent ? safeRequestHost(forwardedHost) : null;
  const direct = hostPresent ? safeRequestHost(host) : null;

  if (
    (forwardedPresent && !forwarded) ||
    (hostPresent && !direct) ||
    (forwardedPresent && hostPresent && forwarded !== direct)
  ) {
    return null;
  }

  const requestHost = forwarded ?? direct;
  return requestHost ? `https://${requestHost}/og.png` : null;
}
