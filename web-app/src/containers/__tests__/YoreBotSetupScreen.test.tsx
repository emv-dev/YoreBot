import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import YoreBotSetupScreen from '@/containers/YoreBotSetupScreen'

const mocks = vi.hoisted(() => {
  const getHardwareInfo = vi.fn()
  const getProviders = vi.fn()
  const pullModel = vi.fn()
  return {
    getHardwareInfo,
    getProviders,
    pullModel,
    serviceHub: {
      hardware: () => ({ getHardwareInfo }),
      providers: () => ({ getProviders }),
      models: () => ({ pullModel }),
    },
    recheckOptimalBackend: vi.fn(),
    downloadRecommendedBackend: vi.fn(),
    selectModelProvider: vi.fn(),
    setProviders: vi.fn(),
    switchToModel: vi.fn(),
    navigate: vi.fn(),
    setOnboardingActive: vi.fn(),
    setLeftPanel: vi.fn(),
  }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@janhq/core', () => ({
  DownloadEvent: { onFileDownloadUpdate: 'onFileDownloadUpdate' },
  events: { on: vi.fn(), off: vi.fn() },
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => mocks.serviceHub,
}))

vi.mock('@/hooks/useBackendUpdater', () => ({
  useBackendUpdater: () => ({
    recheckOptimalBackend: mocks.recheckOptimalBackend,
    downloadRecommendedBackend: mocks.downloadRecommendedBackend,
  }),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({
    selectModelProvider: mocks.selectModelProvider,
    setProviders: mocks.setProviders,
  }),
}))

vi.mock('@/hooks/useModelLoad', () => ({
  useModelLoad: {
    getState: () => ({ setOnboardingActive: mocks.setOnboardingActive }),
  },
}))

vi.mock('@/hooks/useLeftPanel', () => ({
  useLeftPanel: {
    getState: () => ({ setLeftPanel: mocks.setLeftPanel }),
  },
}))

vi.mock('@/utils/switchModel', () => ({
  switchToModel: mocks.switchToModel,
}))

describe('YoreBotSetupScreen unsupported hardware boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.getProviders.mockResolvedValue([])
    mocks.pullModel.mockResolvedValue(undefined)
    mocks.recheckOptimalBackend.mockResolvedValue({
      recommendedBackend: 'b10431/win-cpu-x64',
    })
    mocks.downloadRecommendedBackend.mockResolvedValue(undefined)
    mocks.switchToModel.mockResolvedValue(undefined)
    mocks.navigate.mockResolvedValue(undefined)
  })

  it.each([
    ['unknown memory', {}],
    ['4 GB', { total_memory: 4 * 1024 }],
  ])(
    'rejects %s before any backend or model download',
    async (_name, hardware) => {
      mocks.getHardwareInfo.mockResolvedValue(hardware)

      render(<YoreBotSetupScreen />)

      expect(
        await screen.findByRole('heading', {
          name: 'This computer isn’t supported yet',
        })
      ).toBeInTheDocument()
    expect(mocks.getHardwareInfo).toHaveBeenCalledOnce()
      expect(mocks.recheckOptimalBackend).not.toHaveBeenCalled()
      expect(mocks.downloadRecommendedBackend).not.toHaveBeenCalled()
      expect(mocks.pullModel).not.toHaveBeenCalled()
      expect(mocks.getProviders).not.toHaveBeenCalled()
      expect(mocks.switchToModel).not.toHaveBeenCalled()
      expect(localStorage.length).toBe(0)
    }
  )
})
