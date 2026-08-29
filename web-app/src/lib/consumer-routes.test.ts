import { describe, expect, it } from 'vitest'
import { isConsumerBlockedPath } from './consumer-routes'

describe('consumer route guard', () => {
  it.each([
    '/settings',
    '/settings/general',
    '/hub',
    '/skills/downloads-organizer',
    '/launch',
    '/local-api-server/logs',
    '/logs/app',
    '/project/123',
    '/system-monitor',
  ])('blocks %s', (pathname) => {
    expect(isConsumerBlockedPath(pathname)).toBe(true)
  })

  it.each(['/', '/threads/123', '/temporary-chat'])('allows %s', (pathname) => {
    expect(isConsumerBlockedPath(pathname)).toBe(false)
  })
})
