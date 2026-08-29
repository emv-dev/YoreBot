const BLOCKED_CONSUMER_PREFIXES = [
  '/settings',
  '/hub',
  '/skills',
  '/launch',
  '/local-api-server',
  '/logs',
  '/project',
  '/system-monitor',
] as const

export function isConsumerBlockedPath(pathname: string): boolean {
  return BLOCKED_CONSUMER_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}
