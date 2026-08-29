import { useEffect, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  forgetYoreBotAccess,
  getYoreBotAccessStatus,
  restoreYoreBotAccess,
  type YoreBotAccessStatus,
} from '@/services/yorebot-access'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: YoreBotAccessStatus
  onStatusChange: (status: YoreBotAccessStatus) => void
}

export default function YoreBotAccessDialog({
  open,
  onOpenChange,
  status,
  onStatusChange,
}: Props) {
  const [licenseKey, setLicenseKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void getYoreBotAccessStatus()
      .then((next) => {
        if (!cancelled) onStatusChange(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [onStatusChange, open])

  const openHosted = async (url: string | null) => {
    if (!url) return
    setMessage('')
    try {
      await openUrl(url)
    } catch {
      setMessage('That page could not be opened.')
    }
  }

  const restore = async () => {
    if (!status.paidControlsAvailable || !licenseKey.trim() || busy) return
    setBusy(true)
    setMessage('')
    try {
      const next = await restoreYoreBotAccess(licenseKey)
      onStatusChange(next)
      setLicenseKey('')
      setMessage('Full access restored.')
    } catch {
      setMessage('Access could not be restored. Check the key and connection.')
    } finally {
      setBusy(false)
    }
  }

  const forget = async () => {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      const next = await forgetYoreBotAccess()
      onStatusChange(next)
      setLicenseKey('')
      setMessage('Saved access forgotten.')
    } catch {
      setMessage('Saved access could not be forgotten.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Access</DialogTitle>
          <DialogDescription>
            Payment opens securely in your browser.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border p-4">
          <p className="text-lg font-semibold">
            {status.fullAccess ? 'Full access' : 'Free'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {status.fullAccess
              ? 'Chat and tasks are ready.'
              : 'Chat is free. Tasks include 2 million tokens each day.'}
          </p>
        </div>

        <div className="grid gap-2">
          <Button
            type="button"
            disabled={!status.monthlyCheckoutUrl || busy}
            onClick={() => void openHosted(status.monthlyCheckoutUrl)}
          >
            Try 7 days - then $20/month
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!status.yearlyCheckoutUrl || busy}
            onClick={() => void openHosted(status.yearlyCheckoutUrl)}
          >
            $200/year
          </Button>
        </div>

        <div className="grid gap-2 border-t pt-4">
          <label htmlFor="yorebot-access-key" className="text-sm font-medium">
            Access key
          </label>
          <Input
            id="yorebot-access-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={licenseKey}
            disabled={!status.paidControlsAvailable || busy}
            placeholder="Paste your access key"
            onChange={(event) => setLicenseKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void restore()
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={
              !status.paidControlsAvailable || !licenseKey.trim() || busy
            }
            onClick={() => void restore()}
          >
            Restore access
          </Button>
          <p className="text-xs text-muted-foreground">
            Your key stays securely on this computer.
          </p>
        </div>

        {!status.paidControlsAvailable && (
          <p className="text-sm text-muted-foreground">
            Paid access is not ready in this build. Free use still works.
          </p>
        )}

        {(status.hasSavedKey || status.fullAccess) && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={!status.manageUrl || busy}
              onClick={() => void openHosted(status.manageUrl)}
            >
              Manage membership
            </Button>
            {status.hasSavedKey && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => void forget()}
              >
                Forget saved access
              </Button>
            )}
          </div>
        )}

        {message && (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
