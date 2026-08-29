import { memo, useCallback, useState } from 'react'
import { Check, Code2, Copy, Download, X } from 'lucide-react'
import { fs } from '@janhq/core'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { getServiceHub } from '@/hooks/useServiceHub'
import { isPlatformTauri } from '@/lib/platform/utils'

interface HtmlArtifactProps {
  code: string
  className?: string
  fill?: boolean
  showActions?: boolean
  onClose?: () => void
  streaming?: boolean
}

const DEFAULT_FILENAME = 'artifact.html'

export function estimateHtmlProgress(code: string): number {
  if (!code) return 0.04

  const has = (re: RegExp) => re.test(code)
  if (has(/<\/html>/i)) return 1
  if (has(/<\/body>/i)) return 0.95

  let base = 0.06
  let ceil = 0.18
  if (has(/<!doctype|<html[\s>]/i)) {
    base = 0.12
    ceil = 0.3
  }
  if (has(/<head[\s>]/i)) {
    base = 0.22
    ceil = 0.45
  }
  if (has(/<\/head>/i)) {
    base = 0.45
    ceil = 0.6
  }
  if (has(/<body[\s>]/i)) {
    base = 0.6
    ceil = 0.92
  }

  const creep = 1 - 1 / (1 + code.length / 2200)
  return Math.min(ceil, base + (ceil - base) * creep)
}

function HtmlArtifactComponent({
  code,
  className,
  fill = false,
  showActions = true,
  onClose,
  streaming = false,
}: HtmlArtifactProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!navigator?.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy artifact code:', error)
    }
  }, [code])

  const handleDownload = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const path = await getServiceHub()
          .dialog()
          .save({
            defaultPath: DEFAULT_FILENAME,
            filters: [{ name: 'HTML File', extensions: ['html'] }],
          })
        if (path) await fs.writeFileSync(path, code)
        return
      } catch (error) {
        console.error('Failed to save artifact:', error)
        return
      }
    }

    try {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/html' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = DEFAULT_FILENAME
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Failed to download artifact:', error)
    }
  }, [code])

  const CopyIcon = copied ? Check : Copy

  return (
    <div
      className={cn(
        'overflow-hidden border-border bg-background',
        fill ? 'flex h-full w-full flex-col' : 'my-4 w-full rounded-xl border',
        className
      )}
      data-artifact="html"
    >
      <div
        className={cn(
          '@container relative z-30 flex items-center justify-between gap-2 border-border border-b bg-muted/60 px-2 py-1.5',
          IS_WINDOWS && fill && 'pr-[8rem]'
        )}
      >
        <div className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-foreground">
          <Code2 size={14} className="shrink-0" />
          {streaming ? 'Generating HTML…' : 'HTML code'}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {showActions && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs"
                onClick={handleCopy}
                title="Copy code"
              >
                <CopyIcon size={14} className="shrink-0" />
                <span className="hidden @[26rem]:inline">
                  {copied ? 'Copied' : 'Copy'}
                </span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs"
                onClick={handleDownload}
                title="Download as .html"
              >
                <Download size={14} className="shrink-0" />
                <span className="hidden @[26rem]:inline">Download</span>
              </Button>
            </>
          )}
          {onClose && (
            <Button
              size="icon"
              variant="ghost"
              className="ml-1 h-7 w-7 shrink-0"
              onClick={onClose}
              title="Close"
            >
              <X size={14} />
            </Button>
          )}
        </div>
      </div>

      <div className={cn(fill && 'min-h-0 flex-1')}>
        <div
          className={cn(
            'overflow-y-auto overflow-x-hidden',
            fill ? 'h-full' : 'max-h-[440px]'
          )}
        >
          <CodeBlock
            code={code}
            language="html"
            showLineNumbers
            className="[&_code]:whitespace-normal [&_.line]:block [&_.line]:whitespace-pre-wrap [&_.line]:pl-14 [&_.line]:-indent-14 [&_.line]:[overflow-wrap:anywhere]"
          />
        </div>
      </div>
    </div>
  )
}

export const HtmlArtifact = memo(
  HtmlArtifactComponent,
  (prev, next) =>
    prev.code === next.code &&
    prev.className === next.className &&
    prev.streaming === next.streaming
)
