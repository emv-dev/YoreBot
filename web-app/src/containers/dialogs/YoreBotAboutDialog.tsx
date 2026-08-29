import { useEffect, useMemo, useState } from 'react'
import { getJanDataFolderPath, joinPath } from '@janhq/core'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { localStorageKey } from '@/constants/localStorage'
import { YOREBOT_PINNED_MODELS } from '@/constants/yorebot-models'
import { useModelProvider } from '@/hooks/useModelProvider'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const isAbsolutePath = (value: string) =>
  value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)

export default function YoreBotAboutDialog({ open, onOpenChange }: Props) {
  const providers = useModelProvider((state) => state.providers)
  const [storageLocation, setStorageLocation] = useState('')
  const pinned = useMemo(() => {
    if (!open) return undefined
    const id = localStorage.getItem(localStorageKey.yorebotPinnedModel)
    return YOREBOT_PINNED_MODELS.find((model) => model.id === id)
  }, [open])
  const installed = providers
    .find((provider) => provider.provider === LOCAL_LLAMACPP_PROVIDER)
    ?.models.find((model) => model.id === pinned?.id)

  useEffect(() => {
    if (!open || !pinned) return
    let cancelled = false
    const resolve = async () => {
      const relative = installed?.model_path
      const location = relative
        ? isAbsolutePath(relative)
          ? relative
          : await joinPath([await getJanDataFolderPath(), relative])
        : await joinPath([
            await getJanDataFolderPath(),
            'llamacpp',
            'models',
            pinned.id,
          ])
      if (!cancelled) setStorageLocation(location)
    }
    void resolve()
    return () => {
      cancelled = true
    }
  }, [installed?.model_path, open, pinned])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>About this AI</DialogTitle>
          <DialogDescription>
            The verified local package YoreBot selected for this computer.
          </DialogDescription>
        </DialogHeader>
        {pinned ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Model</dt>
            <dd className="break-all">{pinned.baseModel}</dd>
            <dt className="text-muted-foreground">Developer</dt>
            <dd>{pinned.developer}</dd>
            <dt className="text-muted-foreground">Package</dt>
            <dd className="break-all">{pinned.repository}</dd>
            <dt className="text-muted-foreground">License</dt>
            <dd>{pinned.license}</dd>
            <dt className="text-muted-foreground">Revision</dt>
            <dd className="break-all font-mono text-xs">{pinned.revision}</dd>
            <dt className="text-muted-foreground">SHA-256</dt>
            <dd className="break-all font-mono text-xs">{pinned.sha256}</dd>
            <dt className="text-muted-foreground">Stored at</dt>
            <dd className="break-all font-mono text-xs">
              {storageLocation || 'Loading…'}
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            Setup has not selected a verified local package yet.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
