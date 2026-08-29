import { beforeEach, describe, expect, it, vi } from 'vitest'

const engines = vi.hoisted(() => {
  const makeEngine = () => ({
    list: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue([]),
    isToolSupported: vi.fn().mockResolvedValue(false),
  })
  return new Map([
    ['llamacpp-upstream', makeEngine()],
    ['llamacpp', makeEngine()],
    ['mlx', makeEngine()],
  ])
})
const tauriFetch = vi.hoisted(() => vi.fn())

vi.mock('@janhq/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@janhq/core')>()
  return {
    ...actual,
    EngineManager: {
      instance: vi.fn(() => ({ engines })),
    },
  }
})

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: tauriFetch }))

describe('YoreBot automatic egress boundary', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('imports the production route tree without fetching hidden registries or catalogs', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 503 }))

    await import('@/routeTree.gen')
    const [providers, recommendations, catalog] = await Promise.all([
      import('@/stores/provider-registry-store'),
      import('@/stores/recommended-models-registry-store'),
      import('@/stores/model-catalog-store'),
    ])
    await Promise.all([
      providers.useProviderRegistryStore.getState().refresh({ force: true }),
      recommendations.useRecommendedModelsRegistryStore
        .getState()
        .refresh({ force: true }),
      catalog.useModelCatalogStore.getState().refresh({ force: true }),
    ])
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(tauriFetch).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  }, 20_000)

  it('startup exposes only the pinned local llama.cpp runtime provider', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 503 }))
    const { TauriProvidersService } = await import('../providers/tauri')

    const providers = await new TauriProvidersService().getProviders()

    expect(providers.map((provider) => provider.provider)).toEqual([
      'llamacpp-upstream',
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(tauriFetch).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
