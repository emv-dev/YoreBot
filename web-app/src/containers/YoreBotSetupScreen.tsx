import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { DownloadEvent, events } from '@janhq/core'
import { IconAlertTriangle, IconLoader2 } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { localStorageKey } from '@/constants/localStorage'
import {
  selectPinnedModelForHardware,
  type YoreBotPinnedModel,
} from '@/constants/yorebot-models'
import { route } from '@/constants/routes'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useBackendUpdater } from '@/hooks/useBackendUpdater'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'
import { switchToModel } from '@/utils/switchModel'

type SetupPhase =
  | 'checking'
  | 'optimizing'
  | 'downloading'
  | 'starting'
  | 'unsupported'
  | 'error'

type DownloadProgress = {
  modelId: string
  percent: number
  size?: { transferred: number; total: number }
}

const percentLabel = (value: number) =>
  `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`

export default function YoreBotSetupScreen() {
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const { selectModelProvider, setProviders } = useModelProvider()
  const { recheckOptimalBackend, downloadRecommendedBackend } =
    useBackendUpdater({ postUpgradeRecheckEnabled: false })
  const backendSetup = useRef({
    recheckOptimalBackend,
    downloadRecommendedBackend,
  })
  backendSetup.current = {
    recheckOptimalBackend,
    downloadRecommendedBackend,
  }
  const [phase, setPhase] = useState<SetupPhase>('checking')
  const [model, setModel] = useState<YoreBotPinnedModel>()
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const onProgress = (state: DownloadProgress) => {
      if (state.modelId === model?.id) setProgress(state.percent)
      if (state.modelId.startsWith('llamacpp-backend-')) {
        setProgress(state.percent)
      }
    }
    events.on(DownloadEvent.onFileDownloadUpdate, onProgress)
    return () => events.off(DownloadEvent.onFileDownloadUpdate, onProgress)
  }, [model?.id])

  useEffect(() => {
    useModelLoad.getState().setOnboardingActive(true)
    return () => useModelLoad.getState().setOnboardingActive(false)
  }, [])

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      setPhase('checking')
      setProgress(0)
      setError('')

      try {
        const hardware = await serviceHub.hardware().getHardwareInfo()
        if (cancelled) return
        const selected = hardware
          ? selectPinnedModelForHardware(hardware)
          : undefined
        setModel(selected)
        if (!selected) {
          setPhase('unsupported')
          return
        }

        if (IS_WINDOWS) {
          setPhase('optimizing')
          const recommendation =
            await backendSetup.current.recheckOptimalBackend()
          if (cancelled) return
          await backendSetup.current.downloadRecommendedBackend(
            recommendation?.recommendedBackend ?? 'b10431/win-cpu-x64'
          )
          if (cancelled) return
        }

        let providers = await serviceHub.providers().getProviders()
        if (cancelled) return
        setProviders(providers)
        let provider = providers.find(
          (candidate) => candidate.provider === LOCAL_LLAMACPP_PROVIDER
        )
        let installed = provider?.models.find(
          (candidate) => candidate.id === selected.id
        )

        if (installed) {
          if (
            installed.model_sha256 !== selected.sha256 ||
            installed.model_size_bytes !== selected.sizeBytes
          ) {
            throw new Error(
              'The installed model does not match YoreBot’s pinned checksum and size.'
            )
          }
        } else {
          setPhase('downloading')
          await serviceHub.models().pullModel(
            selected.id,
            selected.url,
            selected.sha256,
            selected.sizeBytes
          )
          if (cancelled) return
          providers = await serviceHub.providers().getProviders()
          if (cancelled) return
          setProviders(providers)
          provider = providers.find(
            (candidate) => candidate.provider === LOCAL_LLAMACPP_PROVIDER
          )
          installed = provider?.models.find(
            (candidate) => candidate.id === selected.id
          )
        }

        if (!installed || !provider) {
          throw new Error('The verified model was not registered after download.')
        }

        setPhase('starting')
        selectModelProvider(LOCAL_LLAMACPP_PROVIDER, installed.id)
        await switchToModel({
          modelId: installed.id,
          providerName: LOCAL_LLAMACPP_PROVIDER,
          serviceHub,
        })
        if (cancelled) return

        localStorage.setItem(localStorageKey.yorebotPinnedModel, selected.id)
        localStorage.setItem(
          localStorageKey.lastUsedModel,
          JSON.stringify({
            provider: LOCAL_LLAMACPP_PROVIDER,
            model: installed.id,
          })
        )
        localStorage.setItem(localStorageKey.setupCompleted, 'true')
        window.dispatchEvent(new Event('app:setup-completed'))
        useLeftPanel.getState().setLeftPanel(true)
        await navigate({ to: route.home, replace: true })
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setPhase('error')
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [
    attempt,
    navigate,
    selectModelProvider,
    serviceHub,
    setProviders,
  ])

  const status = useMemo(() => {
    if (phase === 'checking') return 'Checking this computer…'
    if (phase === 'optimizing')
      return `Preparing your AI · ${percentLabel(progress)}`
    if (phase === 'downloading')
      return `Downloading your AI · ${percentLabel(progress)}`
    if (phase === 'starting') return 'Starting your AI…'
    return ''
  }, [phase, progress])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  return (
    <main
      aria-label="YoreBot setup"
      data-setup-phase={phase}
      className="flex h-svh w-full items-center justify-center bg-background px-6"
    >
      <section className="w-full max-w-lg text-center">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-neutral-950 text-2xl font-semibold text-white dark:bg-white dark:text-neutral-950">
          Y
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">YoreBot</h1>

        {phase === 'unsupported' ? (
          <div className="mt-8">
            <IconAlertTriangle className="mx-auto mb-3 size-7 text-amber-500" />
            <h2 className="text-xl font-medium">
              This computer isn’t supported yet
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              YoreBot could not safely fit either verified local AI package on
              this computer. No model was downloaded.
            </p>
          </div>
        ) : phase === 'error' ? (
          <div className="mt-8">
            <IconAlertTriangle className="mx-auto mb-3 size-7 text-destructive" />
            <h2 className="text-xl font-medium">Setup didn’t finish</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              Nothing unverified will be started. Check your connection and try
              again.
            </p>
            <Button className="mt-5" onClick={retry}>
              Try again
            </Button>
            {error && (
              <details className="mx-auto mt-4 max-w-md text-left text-xs text-muted-foreground">
                <summary className="cursor-pointer text-center">
                  Technical details
                </summary>
                <p className="mt-2 break-words rounded-lg border p-3">{error}</p>
              </details>
            )}
          </div>
        ) : (
          <div className="mt-8">
            <IconLoader2 className="mx-auto mb-4 size-7 animate-spin text-muted-foreground" />
            <h2 className="text-lg font-medium">{status}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              YoreBot chooses one verified package automatically. Internet is
              used for this download.
            </p>
            {(phase === 'optimizing' || phase === 'downloading') && (
              <div
                className="mx-auto mt-5 h-2 max-w-sm overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
              >
                <div
                  className="h-full rounded-full bg-foreground transition-[width]"
                  style={{ width: percentLabel(progress) }}
                />
              </div>
            )}
          </div>
        )}

        {model && (
          <details className="mx-auto mt-8 max-w-md text-left text-xs text-muted-foreground">
            <summary className="cursor-pointer text-center">About this AI</summary>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-xl border p-4">
              <dt>Model</dt>
              <dd className="break-all text-foreground">{model.baseModel}</dd>
              <dt>Developer</dt>
              <dd className="text-foreground">{model.developer}</dd>
              <dt>Package</dt>
              <dd className="break-all text-foreground">{model.repository}</dd>
              <dt>License</dt>
              <dd className="text-foreground">{model.license}</dd>
              <dt>Revision</dt>
              <dd className="break-all font-mono text-foreground">
                {model.revision}
              </dd>
              <dt>SHA-256</dt>
              <dd className="break-all font-mono text-foreground">
                {model.sha256}
              </dd>
            </dl>
          </details>
        )}
      </section>
    </main>
  )
}
