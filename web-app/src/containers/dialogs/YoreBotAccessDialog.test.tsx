import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import YoreBotAccessDialog from '@/containers/dialogs/YoreBotAccessDialog'
import type { YoreBotAccessStatus } from '@/services/yorebot-access'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  restore: vi.fn(),
  forget: vi.fn(),
  openUrl: vi.fn(),
}))

vi.mock('@/services/yorebot-access', () => ({
  getYoreBotAccessStatus: mocks.getStatus,
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
    expect(screen.getByLabelText('Access key')).toHaveAttribute(
      'type',
      'password'
    )
    expect(document.body.textContent).not.toMatch(/provider|model|gumroad/i)

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
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Manage membership' }))
    expect(mocks.openUrl).toHaveBeenCalledWith(fullStatus.manageUrl)

    fireEvent.click(screen.getByRole('button', { name: 'Forget saved access' }))
    await waitFor(() => expect(mocks.forget).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(freeStatus))
  })
})
