import { useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAgentRun } from '@/hooks/useAgentRun'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isStaleAgentApprovalError,
  resolveAgentApproval,
} from '@/services/agent/tauri'
import type { AgentApprovalResolution } from '@/types/agent'

function previewJson(value: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value, null, 2)
  } catch {
    serialized = String(value)
  }
  return serialized
}

function formatApprovalPreview(tool: string, value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const fields = value as Record<string, unknown>
    if (tool === 'os.fs.mkdir' && typeof fields.path === 'string') {
      return `Create folder: ${fields.path}`
    }
    if (
      tool === 'os.fs.move' &&
      typeof fields.source === 'string' &&
      typeof fields.destination === 'string'
    ) {
      return `Move: ${fields.source} → ${fields.destination}`
    }
  }
  return previewJson(value)
}

export default function AgentApprovalDialog() {
  const { t } = useTranslation('chat')
  const resolvingApprovalIdRef = useRef<string | undefined>(undefined)
  const threadId = useAgentRun((state) =>
    Object.keys(state.runs).find(
      (candidate) => state.runs[candidate].pendingApproval !== undefined
    )
  )
  const run = useAgentRun((state) =>
    threadId ? state.runs[threadId] : undefined
  )
  const approval = run?.pendingApproval
  const preview = useMemo(
    () =>
      approval
        ? formatApprovalPreview(approval.tool, approval.preview)
        : '',
    [approval]
  )

  if (!threadId || !run || !approval) {
    return null
  }

  const resolve = async (decision: AgentApprovalResolution) => {
    if (
      run.approvalResolving ||
      resolvingApprovalIdRef.current === approval.approval_id
    ) {
      return
    }
    resolvingApprovalIdRef.current = approval.approval_id
    useAgentRun.getState().setApprovalResolving(threadId, true)
    try {
      await resolveAgentApproval({
        approval_id: approval.approval_id,
        decision,
      })
      useAgentRun
        .getState()
        .clearPendingApproval(threadId, approval.approval_id)
    } catch (error) {
      if (isStaleAgentApprovalError(error)) {
        useAgentRun
          .getState()
          .clearPendingApproval(threadId, approval.approval_id)
        return
      }
      resolvingApprovalIdRef.current = undefined
      useAgentRun.getState().setApprovalResolving(threadId, false)
      toast.error(t('agentApproval.resolveFailed'))
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void resolve('deny')
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('agentApproval.title')}</DialogTitle>
          <DialogDescription>
            {t('agentApproval.description', { tool: approval.tool })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs font-medium">
              {t('agentApproval.reason')}
            </div>
            <p className="text-sm text-muted-foreground">{approval.reason}</p>
          </div>

          {preview && (
            <div>
              <div className="mb-1 text-xs font-medium">
                {t('agentApproval.preview')}
              </div>
              <pre className="max-h-48 overflow-auto rounded-md border bg-secondary p-2 text-xs whitespace-pre-wrap break-all">
                {preview}
              </pre>
            </div>
          )}

          {approval.affected_resources.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium">
                {t('agentApproval.resources')}
              </div>
              <div className="space-y-1">
                {approval.affected_resources.map((resource, index) => (
                  <div
                    key={`${resource.kind}-${resource.operation}-${index}`}
                    className="rounded-md border px-2 py-1.5 text-xs"
                  >
                    <span className="font-medium">{resource.operation}</span>{' '}
                    <span className="text-muted-foreground">
                      {resource.kind}:{' '}
                      {resource.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {t('agentApproval.timeoutNotice')}
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            disabled={run.approvalResolving}
            onClick={() => void resolve('deny')}
          >
            {t('agentApproval.deny')}
          </Button>
          <Button
            size="sm"
            disabled={run.approvalResolving}
            onClick={() => void resolve('allow_once')}
            autoFocus
          >
            {t('agentApproval.approveOnce')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
