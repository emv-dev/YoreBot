import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentApprovalDialog from '@/containers/dialogs/AgentApprovalDialog'
import { useAgentRun } from '@/hooks/useAgentRun'

const { resolveAgentApproval } = vi.hoisted(() => ({
  resolveAgentApproval: vi.fn(),
}))

vi.mock('@/services/agent/tauri', () => ({
  resolveAgentApproval,
  isStaleAgentApprovalError: (error: unknown) =>
    String(error).includes('approval is not pending'),
}))

function openApproval({
  canRemember = true,
  tool = 'os.fs.write',
  reason = 'Write a file',
  preview = { path: '/workspace/a.txt' },
}: {
  canRemember?: boolean
  tool?: string
  reason?: string
  preview?: unknown
} = {}): void {
  useAgentRun.getState().startRun('thread-1', 'run-1')
  useAgentRun.getState().applyEvent('thread-1', {
    type: 'approval_requested',
    run_id: 'run-1',
    approval_id: 'approval-1',
    tool,
    reason,
    preview,
    affected_resources: [
      { kind: 'path', value: '/workspace/a.txt', operation: 'write' },
    ],
    can_remember: canRemember,
  })
}

describe('AgentApprovalDialog', () => {
  beforeEach(() => {
    useAgentRun.getState().clearAll()
    resolveAgentApproval.mockReset()
    resolveAgentApproval.mockResolvedValue(undefined)
    openApproval()
  })

  it('offers only deny and approve once', () => {
    const { container } = render(<AgentApprovalDialog />)

    expect(container.querySelector('.text-amber-500')).toBeNull()
    expect(
      screen.getByRole('button', { name: /approveOnce/i })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /alwaysAllow/i })
    ).not.toBeInTheDocument()
  })

  it('approves once and guards against a double click', async () => {
    let finish: (() => void) | undefined
    resolveAgentApproval.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const user = userEvent.setup()
    render(<AgentApprovalDialog />)
    const approve = screen.getByRole('button', { name: /approveOnce/i })

    await user.dblClick(approve)

    expect(resolveAgentApproval).toHaveBeenCalledTimes(1)
    expect(resolveAgentApproval).toHaveBeenCalledWith({
      approval_id: 'approval-1',
      decision: 'allow_once',
    })
    expect(approve).toBeDisabled()
    finish?.()
    await waitFor(() =>
      expect(
        useAgentRun.getState().getRun('thread-1').pendingApproval
      ).toBeUndefined()
    )
  })

  it('denies when the dialog is closed', async () => {
    render(<AgentApprovalDialog />)

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() =>
      expect(resolveAgentApproval).toHaveBeenCalledWith({
        approval_id: 'approval-1',
        decision: 'deny',
      })
    )
  })

  it('does not expose remembered approvals', () => {
    useAgentRun.getState().clearAll()
    openApproval({ canRemember: false })

    render(<AgentApprovalDialog />)

    expect(
      screen.queryByRole('button', { name: /alwaysAllow/i })
    ).not.toBeInTheDocument()
  })

  it('shows an exact plain-language folder preview', () => {
    const path = `/Downloads/${'receipts-'.repeat(40)}2026`
    useAgentRun.getState().clearAll()
    openApproval({
      tool: 'os.fs.mkdir',
      reason: 'Create a folder',
      preview: { path },
    })

    render(<AgentApprovalDialog />)

    expect(document.querySelector('pre')?.textContent).toBe(
      `Create folder: ${path}`
    )
  })

  it('shows exact plain-language source and destination paths for a move', () => {
    const source = `/Downloads/${'quarterly-report-'.repeat(30)}final.pdf`
    const destination = `/Downloads/Documents/${'quarterly-report-'.repeat(30)}final.pdf`
    useAgentRun.getState().clearAll()
    openApproval({
      tool: 'os.fs.move',
      reason: 'Move a file',
      preview: { source, destination },
    })

    render(<AgentApprovalDialog />)

    expect(document.querySelector('pre')?.textContent).toBe(
      `Move: ${source} → ${destination}`
    )
  })

  it('keeps structured JSON for other guarded tools', () => {
    const preview = {
      path: '/workspace/a.txt',
      content: 'exact consequential content',
    }
    useAgentRun.getState().clearAll()
    openApproval({ preview })

    render(<AgentApprovalDialog />)

    expect(document.querySelector('pre')?.textContent).toBe(
      JSON.stringify(preview, null, 2)
    )
  })

  it('treats a stale approval resolution as a benign race', async () => {
    resolveAgentApproval.mockRejectedValue(
      new Error('approval is not pending: approval-1')
    )
    const user = userEvent.setup()
    render(<AgentApprovalDialog />)

    await user.click(screen.getByRole('button', { name: /deny/i }))

    await waitFor(() =>
      expect(
        useAgentRun.getState().getRun('thread-1').pendingApproval
      ).toBeUndefined()
    )
  })

  it('does not clear a newer approval when an older resolution finishes', async () => {
    let finish: (() => void) | undefined
    resolveAgentApproval.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const user = userEvent.setup()
    render(<AgentApprovalDialog />)

    await user.click(screen.getByRole('button', { name: /approveOnce/i }))
    await act(async () => {
      useAgentRun.getState().applyEvent('thread-1', {
        type: 'approval_requested',
        run_id: 'run-1',
        approval_id: 'approval-2',
        tool: 'os.fs.write',
        reason: 'Write another file',
        preview: { path: '/workspace/b.txt' },
        affected_resources: [
          { kind: 'path', value: '/workspace/b.txt', operation: 'write' },
        ],
        can_remember: true,
      })
      finish?.()
    })

    await waitFor(() =>
      expect(
        useAgentRun.getState().getRun('thread-1').pendingApproval?.approval_id
      ).toBe('approval-2')
    )
  })
})
