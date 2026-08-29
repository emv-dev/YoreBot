/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTools } from '@/hooks/useTools'
import { cn } from '@/lib/utils'

import { useModelProvider } from '@/hooks/useModelProvider'
import YoreBotSetupScreen from '@/containers/YoreBotSetupScreen'
import { route } from '@/constants/routes'
import { localStorageKey } from '@/constants/localStorage'
import { YOREBOT_PINNED_MODELS } from '@/constants/yorebot-models'
import { useCallback, useEffect, useState } from 'react'
import { useThreads } from '@/hooks/useThreads'
import { useAgentMode } from '@/hooks/useAgentMode'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { usePrompt } from '@/hooks/usePrompt'
import { AgentTaskSuggestions } from '@/containers/AgentTaskSuggestions'
import { AgentWorkspaceLayout } from '@/containers/AgentWorkspaceLayout'
import { useServiceHub } from '@/hooks/useServiceHub'
import { resolveAgentWorkspaceRoot } from '@/services/agent/tauri'

export const Route = createFileRoute(route.home as any)({
  component: Index,
})

function Index() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const { setCurrentThreadId } = useThreads()
  const isAgentMode = useAgentMode(
    (state) => state.agentThreads[TEMPORARY_CHAT_ID] === true
  )
  const sidebarMode = useAgentMode((state) => state.sidebarMode)
  const setAgentMode = useAgentMode((state) => state.setAgentMode)
  const setSidebarMode = useAgentMode((state) => state.setSidebarMode)
  const agentWorkspace = useAgentMode(
    (state) => state.workspaces[TEMPORARY_CHAT_ID]
  )
  const setPrompt = usePrompt((state) => state.setPrompt)
  const [selectedAgentSkillName, setSelectedAgentSkillName] = useState<
    string | undefined
  >()
  useTools()

  const handleSelectAgentTask = useCallback(
    (prompt: string, skillName: string) => {
      setPrompt(prompt)
      setSelectedAgentSkillName(skillName)
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
        ?.focus()
    },
    [setPrompt]
  )

  const addExternalAgentRoot = useCallback(async () => {
    const selected = await serviceHub.dialog().open({
      multiple: false,
      directory: true,
    })
    if (typeof selected !== 'string') return

    const root = await resolveAgentWorkspaceRoot(selected)
    useAgentMode.getState().addExternalRoot(TEMPORARY_CHAT_ID, {
      ...root,
      canEdit: true,
    })
  }, [serviceHub])

  const readSetupCompleted = useCallback(() => {
    if (typeof window === 'undefined') return false
    const pinnedModel = localStorage.getItem(localStorageKey.yorebotPinnedModel)
    return (
      localStorage.getItem(localStorageKey.setupCompleted) === 'true' &&
      YOREBOT_PINNED_MODELS.some((model) => model.id === pinnedModel)
    )
  }, [])
  const [setupCompleted, setSetupCompleted] = useState(readSetupCompleted)

  useEffect(() => {
    const refresh = () => setSetupCompleted(readSetupCompleted())
    window.addEventListener('app:setup-completed', refresh)
    return () => window.removeEventListener('app:setup-completed', refresh)
  }, [readSetupCompleted])

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  useEffect(() => {
    const nextMode =
      sidebarMode === 'agent' && selectedProvider === 'mlx'
        ? 'chat'
        : sidebarMode
    if (nextMode !== sidebarMode) setSidebarMode(nextMode)
    setAgentMode(TEMPORARY_CHAT_ID, nextMode === 'agent')
  }, [selectedProvider, setAgentMode, setSidebarMode, sidebarMode])

  //* Dev-флаг FORCE_ONBOARDING — принудительный показ SetupScreen без удаления моделей
  if (FORCE_ONBOARDING || !setupCompleted) {
    return <YoreBotSetupScreen />
  }

  return (
    <AgentWorkspaceLayout
      threadId={TEMPORARY_CHAT_ID}
      agentModeActive={isAgentMode}
      workspace={agentWorkspace ?? { externalRoots: [] }}
      onAddExternal={() => void addExternalAgentRoot()}
      refreshKey={0}
    >
      <div className="flex h-full w-full min-w-0 flex-col justify-center">
        <div
          className={cn(
            'h-full overflow-y-auto inline-flex flex-col gap-2 justify-center px-3'
          )}
        >
          <div
            className={cn('relative mx-auto w-full md:w-4/5 xl:w-4/6 -mt-20')}
          >
            <div className={cn('text-center mb-4')}>
              <h1 className={cn('text-2xl mt-2 font-studio font-medium')}>
                {t('chat:description')}
              </h1>
            </div>
            <div className="flex-1 shrink-0">
              <ChatInput
                showSpeedToken={false}
                initialMessage={true}
                preselectedAgentSkillName={selectedAgentSkillName}
              />
            </div>
            <div className="absolute inset-x-0 top-full mx-auto w-full max-w-3xl">
              <AgentTaskSuggestions
                visible={isAgentMode}
                onSelect={handleSelectAgentTask}
              />
            </div>
          </div>
        </div>
      </div>
    </AgentWorkspaceLayout>
  )
}
