import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { localStorageKey } from '@/constants/localStorage'
import { YOREBOT_PINNED_MODELS } from '@/constants/yorebot-models'
import { useAgentMode } from '@/hooks/useAgentMode'
import { usePrompt } from '@/hooks/usePrompt'

const mocks = vi.hoisted(() => ({
  downloadDir: vi.fn(),
  resolveAgentWorkspaceRoot: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
}))

vi.mock('@tauri-apps/api/path', () => ({
  downloadDir: mocks.downloadDir,
}))

vi.mock('@/services/agent/tauri', () => ({
  resolveAgentWorkspaceRoot: mocks.resolveAgentWorkspaceRoot,
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError },
}))

vi.mock('@/containers/ChatInput', () => ({
  default: ({ preselectedAgentSkillName }: { preselectedAgentSkillName?: string }) => (
    <textarea
      data-testid="chat-input"
      data-selected-skill={preselectedAgentSkillName ?? ''}
    />
  ),
}))

vi.mock('@/containers/YoreBotSetupScreen', () => ({
  default: () => <div>Setup</div>,
}))

vi.mock('@/containers/AgentWorkspaceLayout', () => ({
  AgentWorkspaceLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('@/hooks/useTools', () => ({ useTools: vi.fn() }))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'chat:description': 'How can I help?',
        'chat:agentTasks.title': 'Try a task',
        'chat:agentTasks.organizeDownloads.title': 'Organize my Downloads',
        'chat:agentTasks.organizeDownloads.prompt':
          'Organize Downloads prompt',
        'chat:agentTasks.organizeDownloads.unavailable':
          'Downloads is unavailable.',
      }
      return translations[key] ?? key
    },
  }),
}))

import { Index } from '@/routes/index'

describe('YoreBot Home Downloads task', () => {
  beforeEach(() => {
    vi.stubGlobal('FORCE_ONBOARDING', false)
    localStorage.clear()
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    localStorage.setItem(
      localStorageKey.yorebotPinnedModel,
      YOREBOT_PINNED_MODELS[0].id
    )
    useAgentMode.getState().clearAll()
    useAgentMode.getState().setSidebarMode('agent')
    usePrompt.getState().resetPrompt()
    mocks.downloadDir.mockReset()
    mocks.resolveAgentWorkspaceRoot.mockReset()
    mocks.toastError.mockReset()
  })

  it('connects the operating system Downloads folder before filling the task', async () => {
    const user = userEvent.setup()
    const downloadsPath = 'C:\\Users\\Grandma\\Downloads'
    mocks.downloadDir.mockResolvedValue(downloadsPath)
    mocks.resolveAgentWorkspaceRoot.mockResolvedValue({
      rootId: 'downloads-root',
      path: downloadsPath,
      name: 'Downloads',
    })

    render(<Index />)
    await user.click(
      screen.getByRole('button', { name: 'Organize my Downloads' })
    )

    await waitFor(() => expect(mocks.downloadDir).toHaveBeenCalledOnce())
    expect(mocks.resolveAgentWorkspaceRoot).toHaveBeenCalledWith(downloadsPath)
    expect(
      useAgentMode.getState().getWorkspace(TEMPORARY_CHAT_ID).primaryRoot
    ).toEqual({
      rootId: 'downloads-root',
      path: downloadsPath,
      name: 'Downloads',
      canEdit: true,
    })
    expect(usePrompt.getState().prompt).toBe('Organize Downloads prompt')
    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'data-selected-skill',
      'downloads-organizer'
    )
  })

  it('fails visibly without filling or silently selecting an internal workspace', async () => {
    const user = userEvent.setup()
    mocks.downloadDir.mockRejectedValue(new Error('known folder unavailable'))

    render(<Index />)
    await user.click(
      screen.getByRole('button', { name: 'Organize my Downloads' })
    )

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Downloads is unavailable.'
      )
    )
    expect(usePrompt.getState().prompt).toBe('')
    expect(
      useAgentMode.getState().getWorkspace(TEMPORARY_CHAT_ID).primaryRoot
    ).toBeUndefined()
    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'data-selected-skill',
      ''
    )
  })

  it('also fails closed when Downloads cannot be canonicalized', async () => {
    const user = userEvent.setup()
    mocks.downloadDir.mockResolvedValue('C:\\Users\\Grandma\\Downloads')
    mocks.resolveAgentWorkspaceRoot.mockRejectedValue(
      new Error('Downloads root cannot be resolved')
    )

    render(<Index />)
    await user.click(
      screen.getByRole('button', { name: 'Organize my Downloads' })
    )

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Downloads is unavailable.'
      )
    )
    expect(usePrompt.getState().prompt).toBe('')
    expect(
      useAgentMode.getState().getWorkspace(TEMPORARY_CHAT_ID).primaryRoot
    ).toBeUndefined()
  })
})
