import { useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { ListTodoIcon } from '@/components/animated-icon/list-todo'
import { MessageCircleIcon } from '@/components/animated-icon/message-circle'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAgentMode, type SidebarMode } from '@/hooks/useAgentMode'

type AnimatedIconHandle = {
  startAnimation: () => void
  stopAnimation: () => void
}

export function NavMain({ mode }: { mode: SidebarMode }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const newChatIconRef = useRef<AnimatedIconHandle>(null)

  const handleNewChat = () => {
    useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, mode === 'agent')
    navigate({ to: route.home })
  }

  return (
    <SidebarMenu className="mt-3 px-2">
      <SidebarMenuItem>
        <SidebarMenuButton
          className="font-medium"
          onClick={handleNewChat}
          onMouseEnter={() => newChatIconRef.current?.startAnimation()}
          onMouseLeave={() => newChatIconRef.current?.stopAnimation()}
        >
          {mode === 'agent' ? (
            <ListTodoIcon
              ref={newChatIconRef}
              className="text-foreground/70"
              size={16}
            />
          ) : (
            <MessageCircleIcon
              ref={newChatIconRef}
              className="text-foreground/70"
              size={16}
            />
          )}
          <span>
            {mode === 'agent' ? t('common:newTask') : t('common:newChat')}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
