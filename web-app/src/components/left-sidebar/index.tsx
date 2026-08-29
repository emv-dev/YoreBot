import { NavChats } from './NavChats'
import { NavMain } from './NavMain'
import { cn, isLlamacppProvider } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAgentMode, type SidebarMode } from '@/hooks/useAgentMode'
import { useModelProvider } from '@/hooks/useModelProvider'
import { ChatAgentModeSwitch } from '@/containers/ChatAgentModeSwitch'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { localStorageKey } from '@/constants/localStorage'
import { route } from '@/constants/routes'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import YoreBotAboutDialog from '@/containers/dialogs/YoreBotAboutDialog'
import YoreBotAccessDialog from '@/containers/dialogs/YoreBotAccessDialog'
import {
  EMPTY_YOREBOT_ACCESS_STATUS,
  refreshSavedYoreBotAccess,
} from '@/services/yorebot-access'

import {
  Sidebar,
  SidebarContent,
  SidebarTrigger,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'

export function LeftSidebar() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const sidebarMode = useAgentMode((state) => state.sidebarMode)
  const setSidebarMode = useAgentMode((state) => state.setSidebarMode)
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const isAgentProviderSelected = isLlamacppProvider(selectedProvider)
  const [showAgentAttention, setShowAgentAttention] = useState(
    () =>
      localStorage.getItem(localStorageKey.agentModeAttentionSeen) !== 'true'
  )
  const [aboutOpen, setAboutOpen] = useState(false)
  const [accessOpen, setAccessOpen] = useState(false)
  const [accessStatus, setAccessStatus] = useState(
    EMPTY_YOREBOT_ACCESS_STATUS
  )

  useEffect(() => {
    let cancelled = false
    void refreshSavedYoreBotAccess()
      .then((status) => {
        if (!cancelled) setAccessStatus(status)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const selectMode = (mode: SidebarMode) => {
    if (mode === 'agent' && !isAgentProviderSelected) return
    if (mode === 'agent' && showAgentAttention) {
      localStorage.setItem(localStorageKey.agentModeAttentionSeen, 'true')
      setShowAgentAttention(false)
    }
    setSidebarMode(mode)
    useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, mode === 'agent')
    navigate({ to: route.home })
  }

  return (
    <div className="relative z-50">
      <Sidebar variant="floating" collapsible="offcanvas">
        {/*
          On macOS the window uses ``titleBarStyle: "Overlay"`` (see
          ``src-tauri/tauri.macos.conf.json``), so the red/yellow/green
          traffic-light controls are painted on top of our chrome at
          ~y=14, x=14-66 of the window. The first header row (download +
          sidebar toggle) is right-aligned, so it sits well clear of the
          left-edge traffic-light cluster and can share the same Y-coord
          with the system buttons. We therefore keep that row at the top
          and instead push only the left-aligned YoreBot header row
          below the traffic-light band, so it doesn't collide.
        */}
        <SidebarHeader className="flex flex-col gap-1 px-1 pb-0">
          {/* On macOS this row sits inside the z-50 stacking context of the
              LeftSidebar wrapper, so it is always above the z-20 fixed
              overlay and can receive mousedown events for window dragging.
              SidebarTrigger and DownloadManagement are <button> elements that
              Tauri's drag handler explicitly excludes, so they remain clickable. */}
          <div
            className="flex w-full items-center justify-end"
            {...(IS_MACOS ? { 'data-tauri-drag-region': true } : {})}
          >
            <SidebarTrigger className="text-muted-foreground rounded-full hover:bg-sidebar-foreground/8! -mt-0.5 relative z-50 ml-0.5" />
          </div>
          <div
            className={cn(
              'mt-1 flex w-full items-center gap-1 rounded-lg px-1 py-1',
              IS_MACOS && 'mt-3'
            )}
          >
            <button
              type="button"
              onClick={() => setAboutOpen(true)}
              className="flex min-w-0 flex-1 items-center justify-start gap-2 rounded-lg px-1 text-left hover:bg-sidebar-foreground/8"
              aria-label="About this AI"
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-neutral-950 text-base font-semibold text-white shadow-sm dark:bg-white dark:text-neutral-950">
                Y
              </div>
              <span className="truncate text-base font-semibold tracking-tight">
                YoreBot
              </span>
            </button>
            <button
              type="button"
              onClick={() => setAccessOpen(true)}
              className="shrink-0 rounded-full border px-2 py-1 text-xs font-medium hover:bg-sidebar-foreground/8"
              aria-label={`Access: ${accessStatus.fullAccess ? 'Full' : 'Free'}`}
            >
              {accessStatus.fullAccess ? 'Full' : 'Free'}
            </button>
          </div>
          <div className="mt-[6px] px-1">
            <ChatAgentModeSwitch
              isAgentMode={sidebarMode === 'agent'}
              onChange={(isAgent) => selectMode(isAgent ? 'agent' : 'chat')}
              chatLabel={t('chat:agentMode.chat')}
              agentLabel={t('chat:agentMode.agent')}
              agentDisabled={!isAgentProviderSelected}
              agentDisabledTooltip={t('chat:agentMode.providerUnavailable')}
              showAgentAttention={showAgentAttention}
            />
          </div>
        </SidebarHeader>
        <SidebarContent className="mask-b-from-95% mask-t-from-98%">
          <NavMain mode={sidebarMode} />
          <NavChats mode={sidebarMode} />
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
      <YoreBotAboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <YoreBotAccessDialog
        open={accessOpen}
        onOpenChange={setAccessOpen}
        status={accessStatus}
        onStatusChange={setAccessStatus}
      />
    </div>
  )
}
