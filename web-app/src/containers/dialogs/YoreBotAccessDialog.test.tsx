import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import YoreBotAccessDialog from '@/containers/dialogs/YoreBotAccessDialog'
import type { YoreBotAccessStatus } from '@/services/yorebot-access'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  refresh: vi.fn(),
  restore: vi.fn(),
  forget: vi.fn(),
  openUrl: vi.fn(),
}))

vi.mock('@/services/yorebot-access', () => ({
  getYoreBotAccessStatus: mocks.getStatus,
  refreshSavedYoreBotAccess: mocks.refresh,
  restoreYoreBotAccess: mocks.restore,
  forgetYoreBotAccess: mocks.forget,
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: mocks.openUrl,
}))

const freeStatus: YoreBotAccessStatus = {
  fullAccess: false,
  hasSavedKey: false,
  paidControlsAvailable: true,
  monthlyCheckoutUrl:
    'https://yorebot.gumroad.com/l/access?monthly=true&wanted=true',
  yearlyCheckoutUrl:
    'https://yorebot.gumroad.com/l/access?yearly=true&wanted=true',
  manageUrl: 'https://gumroad.com/library',
}

const fullStatus: YoreBotAccessStatus = {
  ...freeStatus,
  fullAccess: true,
  hasSavedKey: true,
}

describe('YoreBotAccessDialog', () => {
  beforeEach(() => {
    mocks.getStatus.mockReset().mockResolvedValue(freeStatus)
    mocks.refresh.mockReset().mockResolvedValue(fullStatus)
    mocks.restore.mockReset().mockResolvedValue(fullStatus)
    mocks.forget.mockReset().mockResolvedValue(freeStatus)
    mocks.openUrl.mockReset().mockResolvedValue(undefined)
  })

  it('keeps the complete customer flow on one plain-language screen', async () => {
    const onStatusChange = vi.fn()
    render(
      <YoreBotAccessDialog
        open
        onOpenChange={vi.fn()}
        status={freeStatus}
        onStatusChange={onStatusChange}
        requestVersion={{ current: 0 }}
      />
    )

    expect(screen.getByRole('heading', { name: 'Access' })).toBeInTheDocument()
    expect(screen.getByText('Free')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Try 7 days - then $20/month',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '$200/year' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Restore access' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Manage membership' })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Access key')).toHaveAttribute(
      'type',
      'password'
    )
    expect(document.body.textContent).not.toMatch(/provider|model/i)
    expect(
      screen.getByText(
        'Saved securely on this computer and sent only to Gumroad to verify access.'
      )
    ).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Try 7 days - then $20/month',
      })
    )
    expect(mocks.openUrl).toHaveBeenCalledWith(
      freeStatus.monthlyCheckoutUrl
    )
  })

  it('restores a masked key and reports full access without echoing it', async () => {
    const onStatusChange = vi.fn()
    const user = userEvent.setup()
    render(
      <YoreBotAccessDialog
        open
        onOpenChange={vi.fn()}
        status={freeStatus}
        onStatusChange={onStatusChange}
        requestVersion={{ current: 0 }}
      />
    )

    const input = screen.getByLabelText('Access key')
    await user.type(input, 'SECRET-LICENSE-123')
    await user.click(screen.getByRole('button', { name: 'Restore access' }))

    expect(mocks.restore).toHaveBeenCalledWith('SECRET-LICENSE-123')
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(fullStatus))
    expect(screen.getByText('Full access restored.')).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(document.body.textContent).not.toContain('SECRET-LICENSE-123')
  })

  it('fails closed without build configuration while free use remains visible', () => {
    render(
      <YoreBotAccessDialog
        open
        onOpenChange={vi.fn()}
        status={{
          ...freeStatus,
          paidControlsAvailable: false,
          monthlyCheckoutUrl: null,
          yearlyCheckoutUrl: null,
          manageUrl: null,
        }}
        onStatusChange={vi.fn()}
        requestVersion={{ current: 0 }}
      />
    )

    expect(
      screen.getByRole('button', {
        name: 'Try 7 days - then $20/month',
      })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: '$200/year' })).toBeDisabled()
    expect(screen.getByLabelText('Access key')).toBeDisabled()
    expect(screen.getByText('Free use still works.', { exact: false })).toBeInTheDocument()
  })

  it('offers manage and forget paths for restored access', async () => {
    const onStatusChange = vi.fn()
    render(
      <YoreBotAccessDialog
        open
        onOpenChange={vi.fn()}
        status={fullStatus}
        onStatusChange={onStatusChange}
        requestVersion={{ current: 0 }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Manage membership' }))
    expect(mocks.openUrl).toHaveBeenCalledWith(fullStatus.manageUrl)
    expect(
      screen.queryByRole('button', { name: 'Try 7 days - then $20/month' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '$200/year' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Restore access' })
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Access key')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Retry access' })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Forget saved access' }))
    await waitFor(() => expect(mocks.forget).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(freeStatus))
  })

  it('keeps membership management available while access is free', () => {
    render(
      <YoreBotAccessDialog
        open
        onOpenChange={vi.fn()}
        status={freeStatus}
        onStatusChange={vi.fn()}
        requestVersion={{ current: 0 }}
      />
    )

    expect(
      screen.getByRole('button', { name: 'Manage membership' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Forget saved access' })
    ).not.toBeInTheDocument()
  })

  it('prevents another purchase while a saved key awaits verification', async () => {
    const savedFreeStatus = {
      ...freeStatus,
      hasSavedKey: true,
    }
    const onStatusChange = vi.fn()
    const user = userEvent.setup()
    render(
      <YoreBotAccessDialog
        open
        onOpenChange={vi.fn()}
        status={savedFreeStatus}
        onStatusChange={onStatusChange}
        requestVersion={{ current: 0 }}
      />
    )

    expect(
      screen.queryByRole('button', { name: 'Try 7 days - then $20/month' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '$200/year' })
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Access key')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Manage membership' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Forget saved access' })
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry access' }))
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(fullStatus))
  })

  it('keeps Forget available when build configuration is missing', () => {
    render(
      <YoreBotAccessDialog
        open
        onOpenChange={vi.fn()}
        status={{
          ...freeStatus,
          hasSavedKey: true,
          paidControlsAvailable: false,
          monthlyCheckoutUrl: null,
          yearlyCheckoutUrl: null,
          manageUrl: null,
        }}
        onStatusChange={vi.fn()}
        requestVersion={{ current: 0 }}
      />
    )

    expect(
      screen.getByRole('button', { name: 'Forget saved access' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry access' })).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Manage membership' })
    ).not.toBeInTheDocument()
  })

  it('does not let an older status response overwrite a completed forget', async () => {
    let resolveStatus: (status: YoreBotAccessStatus) => void = () => {}
    mocks.getStatus.mockReturnValue(
      new Promise<YoreBotAccessStatus>((resolve) => {
        resolveStatus = resolve
      })
    )
    const onStatusChange = vi.fn()
    render(
      <YoreBotAccessDialog
        open
        onOpenChange={vi.fn()}
        status={fullStatus}
        onStatusChange={onStatusChange}
        requestVersion={{ current: 0 }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Forget saved access' }))
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(freeStatus))
    await act(async () => {
      resolveStatus(fullStatus)
      await Promise.resolve()
    })

    expect(onStatusChange).toHaveBeenLastCalledWith(freeStatus)
  })
})
