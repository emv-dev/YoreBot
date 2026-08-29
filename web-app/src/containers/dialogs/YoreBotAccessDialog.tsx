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
  refreshSavedYoreBotAccess,
  restoreYoreBotAccess,
  type YoreBotAccessStatus,
} from '@/services/yorebot-access'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: YoreBotAccessStatus
  onStatusChange: (status: YoreBotAccessStatus) => void
  requestVersion: { current: number }
}

export default function YoreBotAccessDialog({
  open,
  onOpenChange,
  status,
  onStatusChange,
  requestVersion,
}: Props) {
  const [licenseKey, setLicenseKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const request = ++requestVersion.current
    void getYoreBotAccessStatus()
      .then((next) => {
        if (!cancelled && requestVersion.current === request) {
          onStatusChange(next)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [onStatusChange, open, requestVersion])

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
    const request = ++requestVersion.current
    setBusy(true)
    setMessage('')
    try {
      const next = await restoreYoreBotAccess(licenseKey)
      if (requestVersion.current === request) {
        onStatusChange(next)
        setLicenseKey('')
        setMessage('Full access restored.')
      }
    } catch {
      if (requestVersion.current === request) {
        setMessage('Access could not be restored. Check the key and connection.')
      }
    } finally {
      setBusy(false)
    }
  }

  const forget = async () => {
    if (busy) return
    const request = ++requestVersion.current
    setBusy(true)
    setMessage('')
    try {
      const next = await forgetYoreBotAccess()
      if (requestVersion.current === request) {
        onStatusChange(next)
        setLicenseKey('')
        setMessage('Saved access forgotten.')
      }
    } catch {
      if (requestVersion.current === request) {
        setMessage('Saved access could not be forgotten.')
      }
    } finally {
      setBusy(false)
    }
  }

  const retry = async () => {
    if (!status.hasSavedKey || busy) return
    const request = ++requestVersion.current
    setBusy(true)
    setMessage('')
    try {
      const next = await refreshSavedYoreBotAccess()
      if (requestVersion.current === request) {
        onStatusChange(next)
        setMessage(
          next.fullAccess
            ? 'Full access restored.'
            : 'Access could not be verified. Check your connection or membership.'
        )
      }
    } catch {
      if (requestVersion.current === request) {
        setMessage(
          'Access could not be verified. Check your connection or membership.'
        )
      }
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

        {!status.fullAccess && !status.hasSavedKey && (
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
        )}

        {!status.fullAccess && !status.hasSavedKey && (
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
              Saved securely on this computer and sent only to Gumroad to
              verify access.
            </p>
          </div>
        )}

        {!status.fullAccess && status.hasSavedKey && (
          <Button
            type="button"
            variant="outline"
            disabled={!status.paidControlsAvailable || busy}
            onClick={() => void retry()}
          >
            Retry access
          </Button>
        )}

        {!status.paidControlsAvailable && (
          <p className="text-sm text-muted-foreground">
            Paid access is not ready in this build. Free use still works.
          </p>
        )}

        {(status.manageUrl || status.hasSavedKey) && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {status.manageUrl && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void openHosted(status.manageUrl)}
              >
                Manage membership
              </Button>
            )}
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
