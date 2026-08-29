import { useModelProvider } from '@/hooks/useModelProvider'
import { localStorageKey } from '@/constants/localStorage'
import { EMBEDDING_MODEL_ID } from '@/constants/models'

import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect } from 'react'
import { useAssistant, defaultAssistant } from '@/hooks/useAssistant'
import { useThreads } from '@/hooks/useThreads'
import { useAppState } from '@/hooks/useAppState'
import { switchToModel } from '@/utils/switchModel'
import { useModelLoad } from '@/hooks/useModelLoad'
import { consumeSilentImport } from '@/utils/backgroundImports'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'
import { AppEvent, events, ModelEvent } from '@janhq/core'
import { toast } from 'sonner'
import { isLocalProvider } from '@/utils/registerRemoteProvider'

export function DataProvider() {
  const { setProviders } = useModelProvider()

  const { setAssistants, initializeWithLastUsed } = useAssistant()
  const { setThreads } = useThreads()
  const serviceHub = useServiceHub()

  useEffect(() => {
    if (localStorage.getItem(localStorageKey.factoryResetPending) === 'true') {
      const backendType = localStorage.getItem('llama_cpp_backend_type')

      localStorage.clear()

      if (backendType) {
        localStorage.setItem('llama_cpp_backend_type', backendType)
      }

      console.log(
        'Factory reset detected — localStorage force-cleared on startup (backend preserved)'
      )
    }
  }, [])

  useEffect(() => {
    console.log('Initializing DataProvider...')
    serviceHub
      .providers()
      .getProviders()
      .then((providers) => {
        setProviders(
          providers.filter((provider) => isLocalProvider(provider.provider))
        )
      })
    serviceHub
      .assistants()
      .getAssistants()
      .then((data) => {
        if (data && Array.isArray(data) && data.length > 0) {
          // Keep the load-bearing legacy id while presenting YoreBot's default assistant.
          const migrated = (data as unknown as Assistant[]).map((a) =>
            a.id === 'jan'
              ? { ...defaultAssistant, id: 'jan', created_at: a.created_at }
              : a
          )
          setAssistants(migrated)
          initializeWithLastUsed()
        }
      })
      .catch((error) => {
        console.warn('Failed to load assistants, keeping default:', error)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceHub])

  useEffect(() => {
    serviceHub
      .threads()
      .fetchThreads()
      .then((threads) => {
        setThreads(threads)
      })
  }, [serviceHub, setThreads])

  useEffect(() => {
    const handleModelImported = async (eventData?: Record<string, unknown>) => {
      console.log('[LocalAPI] onModelImported fired, eventData:', eventData)

      try {
        const fetchedProviders = await serviceHub.providers().getProviders()
        setProviders(
          fetchedProviders.filter((provider) =>
            isLocalProvider(provider.provider)
          )
        )
      } catch (err) {
        console.error(
          '[LocalAPI] Failed to refresh providers after model import:',
          err
        )
        return
      }

      const modelId = eventData?.modelId as string | undefined
      if (!modelId) {
        console.warn(
          '[LocalAPI] onModelImported: no modelId in event data, skipping'
        )
        return
      }

      if (modelId === EMBEDDING_MODEL_ID) {
        console.log(
          '[LocalAPI] onModelImported: embedding model imported, skipping server switch'
        )
        return
      }

      // Background bulk-imports (onboarding adds every detected model to the
      // library by design) emit `onModelImported` too. Auto-switching to them
      // would hijack the model the user actually picked. This registry is
      // independent of any screen lifecycle, so it also covers imports that
      // settle AFTER the onboarding screen unmounts (when `onboardingActive` is
      // already false again).
      if (consumeSilentImport(modelId)) {
        console.log(
          '[LocalAPI] onModelImported: silent (background) import, skipping auto-switch for',
          modelId
        )
        return
      }

      // While onboarding is on screen it launches the chosen model itself, so
      // DataProvider stands down entirely to avoid double-launching it.
      if (useModelLoad.getState().onboardingActive) {
        console.log(
          '[LocalAPI] onModelImported: onboarding active, skipping auto-switch for',
          modelId
        )
        return
      }

      // Resolve the provider against the *post-setProviders* store, not the
      // raw `getProviders()` payload. On Windows the store strips the
      // turboquant `'llamacpp'` provider (ADR 2026-05-22 *Windows ships only
      // `llamacpp-upstream`*), but the raw payload may still carry a
      // ghost `'llamacpp'` entry from leftover persisted state — picking
      // it here would route the subsequent `switchToModel` to a provider
      // id that the store doesn't know about and crash with `Provider
      // 'llamacpp' not found`, leaving the previous model unloaded and
      // the server stopped.
      const storeProviders = useModelProvider.getState().providers
      let provider = storeProviders.find((p) =>
        p?.models?.some((m: { id: string }) => m.id === modelId)
      )
      if (!provider) {
        const altId = modelId.replace(/\//g, '\\')
        provider = storeProviders.find((p) =>
          p?.models?.some((m: { id: string }) => m.id === altId)
        )
      }
      if (!provider) {
        provider = storeProviders.find(
          (p) => p?.provider === LOCAL_LLAMACPP_PROVIDER
        )
        console.warn(
          '[LocalAPI] Could not find provider for model',
          modelId,
          `— falling back to ${LOCAL_LLAMACPP_PROVIDER}`
        )
      }
      const providerName = provider?.provider ?? LOCAL_LLAMACPP_PROVIDER
      console.log('[LocalAPI] Provider for model:', providerName)

      console.log(
        '[LocalAPI] Current server status:',
        useAppState.getState().serverStatus
      )

      // A model switch / server start may already be in flight (e.g. the
      // startup auto-start fired right as the download finished). Previously
      // we bailed out on 'pending', which left the freshly downloaded model
      // with nothing running and forced the user to start it manually from
      // Settings after onboarding. Instead, wait for the in-flight operation
      // to settle, then switch to the just-imported model so it auto-starts.
      if (useAppState.getState().serverStatus === 'pending') {
        console.log('[LocalAPI] Server pending — waiting before auto-start')
        const settled = await new Promise<boolean>((resolve) => {
          const startedAt = Date.now()
          const poll = () => {
            if (useAppState.getState().serverStatus !== 'pending') {
              resolve(true)
            } else if (Date.now() - startedAt > 20000) {
              resolve(false)
            } else {
              setTimeout(poll, 500)
            }
          }
          poll()
        })
        if (!settled) {
          console.log(
            '[LocalAPI] Server still pending after wait — skipping auto-start'
          )
          return
        }
      }

      // switchToModel handles stopAllModels, start the new model, start/restart
      // the Local API Server, and syncs all global state.
      try {
        await switchToModel({
          modelId,
          providerName,
          serviceHub,
          isAutoStart: true,
        })
        console.log('[LocalAPI] Model imported and switched to:', modelId)
      } catch (error) {
        console.error('[LocalAPI] Failed to switch to imported model:', error)
      }
    }

    events.on(AppEvent.onModelImported, handleModelImported)
    console.log('[LocalAPI] Registered onModelImported handler')
    return () => {
      events.off(AppEvent.onModelImported, handleModelImported)
      console.log('[LocalAPI] Unregistered onModelImported handler')
    }
  }, [serviceHub, setProviders])

  // Mirror any auto-increase of ctx_len performed by a backend extension
  // (triggered by the Local API Server proxy detecting a context-limit error)
  // into the persisted Zustand provider store so the UI stays in sync with
  // the live backend session.
  //
  // We subscribe on TWO redundant channels to guarantee delivery:
  //   1) `ModelEvent.OnAutoIncreasedCtxLen` on `@janhq/core::events`
  //      (in-process EventEmitter singleton hanging off `window.core.events`).
  //   2) `local_backend://auto_increase_ctx_notify` on the native Tauri
  //      event bus (bypasses any @janhq/core bundling quirks).
  //
  // The handler is idempotent: applying the same `newCtxLen` twice simply
  // writes the same value back, so double-delivery is harmless.
  useEffect(() => {
    const applyNewCtxLen = (
      providerName: string,
      modelId: string,
      newCtxLen: number,
      source: string
    ) => {
      const { providers, updateProvider } = useModelProvider.getState()
      const provider = providers.find((p) => p.provider === providerName)
      if (!provider) {
        console.warn(
          `[LocalAPI] OnAutoIncreasedCtxLen (${source}): provider "${providerName}" not found in store`
        )
        return
      }

      const modelIndex = provider.models.findIndex((m) => m.id === modelId)
      if (modelIndex === -1) {
        console.warn(
          `[LocalAPI] OnAutoIncreasedCtxLen (${source}): model "${modelId}" not found in provider "${providerName}"`
        )
        return
      }

      const model = provider.models[modelIndex]
      const currentValue =
        (model.settings?.ctx_len?.controller_props?.value as number | undefined) ??
        null
      if (currentValue === newCtxLen) {
        console.log(
          `[LocalAPI] OnAutoIncreasedCtxLen (${source}): ctx_len for ${providerName}/${modelId} already = ${newCtxLen}, no-op`
        )
        return
      }

      const updatedModel = {
        ...model,
        settings: {
          ...model.settings,
          ctx_len: {
            ...(model.settings?.ctx_len ?? {}),
            controller_props: {
              ...(model.settings?.ctx_len?.controller_props ?? {}),
              value: newCtxLen,
            },
          },
        },
      }

      const updatedModels = [...provider.models]
      updatedModels[modelIndex] = updatedModel as Model

      updateProvider(provider.provider, { models: updatedModels })
      console.log(
        `[LocalAPI] Mirrored auto-increased ctx_len for ${providerName}/${modelId} → ${newCtxLen} (via ${source})`
      )
    }

    const handleFromEvents = (eventData?: Record<string, unknown>) => {
      const providerName = eventData?.provider as string | undefined
      const modelId = eventData?.modelId as string | undefined
      const newCtxLen = eventData?.newCtxLen as number | undefined
      console.log(
        '[LocalAPI] OnAutoIncreasedCtxLen received (core/events)',
        eventData
      )
      if (!providerName || !modelId || typeof newCtxLen !== 'number') {
        console.warn(
          '[LocalAPI] OnAutoIncreasedCtxLen (core/events): invalid payload',
          eventData
        )
        return
      }
      applyNewCtxLen(providerName, modelId, newCtxLen, 'core/events')
    }

    events.on(ModelEvent.OnAutoIncreasedCtxLen, handleFromEvents)

    // Parallel native Tauri bus listener (extensions emit both channels).
    let unlistenTauri: (() => void) | undefined
    let unlistenAtMax: (() => void) | undefined
    let cancelled = false
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (cancelled) return
        const unsub = await listen<{
          provider?: string
          modelId?: string
          newCtxLen?: number
        }>('local_backend://auto_increase_ctx_notify', (event) => {
          const { provider, modelId, newCtxLen } = event.payload ?? {}
          console.log(
            '[LocalAPI] auto_increase_ctx_notify received (tauri)',
            event.payload
          )
          if (!provider || !modelId || typeof newCtxLen !== 'number') {
            console.warn(
              '[LocalAPI] auto_increase_ctx_notify (tauri): invalid payload',
              event.payload
            )
            return
          }
          applyNewCtxLen(provider, modelId, newCtxLen, 'tauri')
        })
        if (cancelled) {
          unsub()
          return
        }
        unlistenTauri = unsub
        console.log(
          '[LocalAPI] Subscribed to Tauri event: local_backend://auto_increase_ctx_notify'
        )

        /// Parallel subscription for the hard-stop signal: when an extension
        /// detects that the next ladder step would exceed (or equal) the
        /// model's training-max context, it emits this event so the UI can
        /// inform the user that auto-expand is done. The toast id is keyed
        /// on `provider/modelId` so consecutive overflows on the same model
        /// don't stack up multiple identical toasts.
        const unsubAtMax = await listen<{
          provider?: string
          modelId?: string
          maxCtxLen?: number
          currentCtxLen?: number
        }>('local_backend://auto_increase_ctx_at_max', (event) => {
          const { provider, modelId } = event.payload ?? {}
          console.log(
            '[LocalAPI] auto_increase_ctx_at_max received (tauri)',
            event.payload
          )
          if (!provider || !modelId) {
            console.warn(
              '[LocalAPI] auto_increase_ctx_at_max (tauri): invalid payload',
              event.payload
            )
            return
          }
          toast.error(
            'Model reached its maximum context, auto-expand stopped',
            { id: `ctx-at-max-${provider}-${modelId}` }
          )
        })
        if (cancelled) {
          unsubAtMax()
        } else {
          unlistenAtMax = unsubAtMax
          console.log(
            '[LocalAPI] Subscribed to Tauri event: local_backend://auto_increase_ctx_at_max'
          )
        }
      } catch (e) {
        console.warn(
          '[LocalAPI] Failed to subscribe to Tauri auto_increase_ctx_notify:',
          e
        )
      }
    })()

    return () => {
      cancelled = true
      events.off(ModelEvent.OnAutoIncreasedCtxLen, handleFromEvents)
      if (unlistenTauri) unlistenTauri()
      if (unlistenAtMax) unlistenAtMax()
    }
  }, [])

  // ATO-244: Listen for unexpected llama-server crashes that happen AFTER
  // model load (i.e. during generation). The Rust post-load watcher emits
  // `local_backend://llamacpp_upstream_session_died` when this occurs.
  // Show an actionable toast so the user knows why generation stopped.
  useEffect(() => {
    if (!IS_TAURI) return

    let unlistenSessionDied: (() => void) | undefined
    let cancelled = false
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (cancelled) return
        const unsub = await listen<{
          model_id?: string
          error_code?: string
          message?: string
        }>('local_backend://llamacpp_upstream_session_died', (event) => {
          const { model_id } = event.payload ?? {}
          console.warn(
            '[LocalAPI] llamacpp_upstream_session_died:',
            event.payload
          )
          // ATO-244: the backend process is gone, but `useAppState.activeModels`
          // (the store every "is this model running?" check in the UI reads
          // from — ChatInput's auto-start effect, the status dot, etc.) still
          // lists it as active until something re-queries the engine. Without
          // this, a "New chat" on the same model/provider never re-checks
          // (its auto-start effect only reruns on model/provider change) and
          // just sends straight into the dead backend, surfacing a raw
          // "Connection refused" instead of silently reloading. Dropping the
          // model here flips `isModelActive` to false, which re-triggers that
          // effect and lets it restart the model on its own.
          if (model_id) {
            const { activeModels, setActiveModels } = useAppState.getState()
            if (activeModels.includes(model_id)) {
              setActiveModels(activeModels.filter((id) => id !== model_id))
            }
          }
          toast.error('Model crashed during generation', {
            id: `session-died-${model_id ?? 'unknown'}`,
            description:
              "The model's backend process exited unexpectedly. This can happen with Vulkan backends on some GPU drivers. Try reloading the model, or switch to a CPU backend in Settings → Providers.",
          })
        })
        if (cancelled) {
          unsub()
          return
        }
        unlistenSessionDied = unsub
      } catch (e) {
        console.warn(
          '[LocalAPI] Failed to subscribe to llamacpp_upstream_session_died:',
          e
        )
      }
    })()

    return () => {
      cancelled = true
      if (unlistenSessionDied) unlistenSessionDied()
    }
  }, [])

  return null
}
