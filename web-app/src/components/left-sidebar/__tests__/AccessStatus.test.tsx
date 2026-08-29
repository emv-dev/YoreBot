import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LeftSidebar } from '..'
import type { YoreBotAccessStatus } from '@/services/yorebot-access'

const accessMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  status: vi.fn(),
  restore: vi.fn(),
  forget: vi.fn(),
}))

vi.mock('@/services/yorebot-access', () => ({
  EMPTY_YOREBOT_ACCESS_STATUS: {
    fullAccess: false,
    hasSavedKey: false,
    paidControlsAvailable: false,
    monthlyCheckoutUrl: null,
    yearlyCheckoutUrl: null,
    manageUrl: null,
  },
  refreshSavedYoreBotAccess: accessMocks.refresh,
  getYoreBotAccessStatus: accessMocks.status,
  restoreYoreBotAccess: accessMocks.restore,
  forgetYoreBotAccess: accessMocks.forget,
}))

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) =>
    values.filter(Boolean).join(' '),
  isLlamacppProvider: () => true,
}))
vi.mock('@/hooks/useAgentMode', () => {
  const state = {
    sidebarMode: 'chat',
    setSidebarMode: vi.fn(),
    setAgentMode: vi.fn(),
  }
  return {
    useAgentMode: Object.assign(
      (selector: (value: typeof state) => unknown) => selector(state),
      { getState: () => state }
    ),
  }
})
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (
    selector: (value: { selectedProvider: string }) => unknown
  ) => selector({ selectedProvider: 'llamacpp-upstream' }),
}))
vi.mock('@/containers/ChatAgentModeSwitch', () => ({
  ChatAgentModeSwitch: () => null,
}))
vi.mock('@/containers/dialogs/YoreBotAboutDialog', () => ({
  default: () => null,
}))
vi.mock('@/components/left-sidebar/NavMain', () => ({ NavMain: () => null }))
vi.mock('@/components/left-sidebar/NavChats', () => ({ NavChats: () => null }))
vi.mock('@/components/ui/sidebar', () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarTrigger: () => <button type="button">Toggle sidebar</button>,
  SidebarRail: () => null,
}))

const freeStatus: YoreBotAccessStatus = {
  fullAccess: false,
  hasSavedKey: false,
  paidControlsAvailable: true,
  monthlyCheckoutUrl:
    'https://yorebot.gumroad.com/l/access?monthly=true&wanted=true',
  yearlyCheckoutUrl:
    'https://yorebot.gumroad.com/l/access?yearly=true&wanted=true',
  manageUrl: 'https://gumroad.com/library',
}

const fullStatus: YoreBotAccessStatus = {
  ...freeStatus,
  fullAccess: true,
  hasSavedKey: true,
}

describe('LeftSidebar access status', () => {
  beforeEach(() => {
    accessMocks.refresh.mockReset()
    accessMocks.status.mockReset().mockResolvedValue(fullStatus)
    accessMocks.restore.mockReset().mockResolvedValue(fullStatus)
    accessMocks.forget.mockReset().mockResolvedValue(freeStatus)
  })

  it('does not let an older startup refresh overwrite a later forget', async () => {
    let resolveStartup: (status: YoreBotAccessStatus) => void = () => {}
    accessMocks.refresh.mockReturnValue(
      new Promise<YoreBotAccessStatus>((resolve) => {
        resolveStartup = resolve
      })
    )
    render(<LeftSidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Access: Free' }))
    await screen.findByRole('button', { name: 'Access: Full', hidden: true })
    fireEvent.click(screen.getByRole('button', { name: 'Forget saved access' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Access: Free', hidden: true })
      ).toBeInTheDocument()
    )

    await act(async () => {
      resolveStartup(fullStatus)
      await Promise.resolve()
    })

    expect(
      screen.getByRole('button', { name: 'Access: Free', hidden: true })
    ).toBeInTheDocument()
  })
})
