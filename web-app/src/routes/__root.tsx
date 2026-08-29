import { createRootRoute, Outlet, redirect } from '@tanstack/react-router'
// import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

import { Fragment } from 'react/jsx-runtime'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { InterfaceProvider } from '@/providers/InterfaceProvider'
import { KeyboardShortcutsProvider } from '@/providers/KeyboardShortcuts'
import { DataProvider } from '@/providers/DataProvider'
import { route } from '@/constants/routes'
import { ExtensionProvider } from '@/providers/ExtensionProvider'
import { ToasterProvider } from '@/providers/ToasterProvider'
// import { useAnalytic } from '@/hooks/useAnalytic'
// import { PromptAnalytic } from '@/containers/analytics/PromptAnalytic'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useTrayStatusSync } from '@/hooks/useTrayStatusSync'
import ToolApproval from '@/containers/dialogs/ToolApproval'
import AgentApprovalDialog from '@/containers/dialogs/AgentApprovalDialog'
import AgentFolderAccessDialog from '@/containers/dialogs/AgentFolderAccessDialog'
import { TranslationProvider } from '@/i18n/TranslationContext'
import OutOfContextPromiseModal from '@/containers/dialogs/OutOfContextDialog'
import AttachmentIngestionDialog from '@/containers/dialogs/AttachmentIngestionDialog'
import { useEffect } from 'react'
import GlobalError from '@/containers/GlobalError'
import { GlobalEventHandler } from '@/providers/GlobalEventHandler'
import { ServiceHubProvider } from '@/providers/ServiceHubProvider'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { LeftSidebar } from '@/components/left-sidebar'
import { WindowControls } from '@/components/WindowControls'
import { isConsumerBlockedPath } from '@/lib/consumer-routes'

export const Route = createRootRoute({
  component: RootLayout,
  beforeLoad: ({ location }) => {
    if (isConsumerBlockedPath(location.pathname)) {
      throw redirect({ to: route.home })
    }
  },
  errorComponent: ({ error }) => {
    return <GlobalError error={error} />
  },
})

const AppLayout = () => {
  const {
    open: isLeftPanelOpen,
    setLeftPanel,
    width: sidebarWidth,
    setLeftPanelWidth,
  } = useLeftPanel()
  // Feeds live server / model / RAM state into the desktop system tray.
  // No-op outside macOS and Windows Tauri builds (see hook implementation).
  useTrayStatusSync()

  return (
    <div className="bg-neutral-50 dark:bg-background size-full relative">
      <SidebarProvider
        open={isLeftPanelOpen}
        onOpenChange={setLeftPanel}
        defaultWidth={sidebarWidth}
        onWidthChange={setLeftPanelWidth}
      >
        <KeyboardShortcutsProvider />
        {/* Fake absolute panel top to enable window drag */}
        {IS_WINDOWS && <WindowControls />}
        {/* On Windows we use a fixed overlay for the drag region.
            On macOS we attach data-tauri-drag-region directly to the
            SidebarHeader and HeaderPage elements so that the drag area is
            always the topmost element in those regions (the fixed overlay at
            z-20 is covered by header content at the same z-level and
            therefore never receives mousedown events on macOS). */}
        {IS_WINDOWS && (
          <div
            className="fixed w-full h-12 z-20 top-0"
            data-tauri-drag-region
          />
        )}
        <LeftSidebar />
        <SidebarInset>
          <div className="bg-neutral-50 dark:bg-background size-full">
            <Outlet />
          </div>
        </SidebarInset>

      </SidebarProvider>
    </div>
  )
}

const LogsLayout = () => {
  return (
    <Fragment>
      <main className="relative h-svh text-sm antialiased select-text bg-app">
        <div className="flex h-full">
          {/* Main content panel */}
          <div className="h-full flex w-full">
            <div className="bg-background text-foreground border w-full overflow-hidden">
              <Outlet />
            </div>
          </div>
        </div>
      </main>
    </Fragment>
  )
}

function RootLayout() {
  const getInitialLayoutType = () => {
    const pathname = window.location.pathname
    return (
      pathname === route.localApiServerlogs ||
      pathname === route.systemMonitor ||
      pathname === route.appLogs
    )
  }

  useEffect(() => {
    // Wait for the UI to be fully rendered before hiding the loader
    const hideLoader = () => {
      requestAnimationFrame(() => {
        // Hide the HTML loader
        document.body.classList.add('loaded')

        // Remove the HTML loader element after transition
        const loader = document.getElementById('initial-loader')
        if (loader) {
          setTimeout(() => {
            loader.remove()
          }, 300)
        }
      })
    }

    // Give providers time to initialize and paint
    const timer = setTimeout(hideLoader, 200)

    return () => clearTimeout(timer)
  }, [])

  const IS_LOGS_ROUTE = getInitialLayoutType()

  return (
    <Fragment>
      <ServiceHubProvider>
        <ThemeProvider />
        <InterfaceProvider />
        <ToasterProvider />
        <TranslationProvider>
          <ExtensionProvider>
            <DataProvider />
            <GlobalEventHandler />
            {IS_LOGS_ROUTE ? <LogsLayout /> : <AppLayout />}
          </ExtensionProvider>
          {/* <TanStackRouterDevtools position="bottom-right" /> */}
          <ToolApproval />
          <AgentApprovalDialog />
          <AgentFolderAccessDialog />
          <AttachmentIngestionDialog />
          <OutOfContextPromiseModal />
        </TranslationProvider>
      </ServiceHubProvider>
    </Fragment>
  )
}
