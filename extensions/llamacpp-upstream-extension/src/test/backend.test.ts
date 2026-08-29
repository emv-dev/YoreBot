import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getBackendDir,
  getBackendExePath,
  isBackendInstalled,
  fetchRemoteBackends,
  getBackendArchiveName,
  getBackendDownloadUrl,
  PINNED_BACKEND_ARTIFACTS,
} from '../backend'
import { getSystemInfo } from '../hardware'
import { fs, getJanDataFolderPath } from '@janhq/core'

// Mock constants: Hardcode path string directly inside the mock to avoid hoisting issues
const MOCK_JAN_PATH_STRING = '/path/to/jan'

// Mock the core dependencies
vi.mock('@janhq/core', () => ({
  getJanDataFolderPath: vi.fn().mockResolvedValue('/path/to/jan'),
  fs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn().mockResolvedValue([]),
    rm: vi.fn().mockResolvedValue(undefined),
  },
  joinPath: vi.fn(async (paths: string[]) => paths.join('/')),
  events: {
    emit: vi.fn(),
  },
}))
vi.mock('../hardware', () => ({
  getSystemInfo: vi.fn(),
}))

vi.stubGlobal('IS_WINDOWS', false)

describe('Backend functions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Mock getJanDataFolderPath explicitly to a simple path
    vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')

    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'linux',
      cpu: {
        arch: 'x86_64',
        extensions: [],
      },
      gpus: [],
    } as any)

    // Default mock for isBackendInstalled dependencies
    vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
      if (path.includes('build')) return true
      return false
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getBackendArchiveName', () => {
    it('returns only the immutable pinned archive', () => {
      expect(getBackendArchiveName('b10431', 'win-cpu-x64')).toBe(
        'llama-b10431-bin-win-cpu-x64.zip'
      )
      expect(() =>
        getBackendArchiveName('b10432', 'win-cpu-x64')
      ).toThrow('Backend is not pinned for YoreBot')
    })
  })

  describe('getBackendDir and getBackendExePath', () => {
    it('should use the specific backend name for directory path', async () => {
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
        path.includes('build')
      ) // Mock build dir check

      const dir = await getBackendDir('linux-avx2-x64', 'v1.2.3')
      expect(dir).toBe(
        `/path/to/jan/llamacpp-upstream/backends/v1.2.3/linux-avx2-x64`
      )

      const exePath = await getBackendExePath('linux-avx2-x64', 'v1.2.3')
      expect(exePath).toBe(
        `/path/to/jan/llamacpp-upstream/backends/v1.2.3/linux-avx2-x64/build/bin/llama-server`
      )
    })

    it('should use the new common backend name for directory path if it was the asset name', async () => {
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
        path.includes('build')
      ) // Mock build dir check

      const dir = await getBackendDir('win-common_cpus-x64', 'v2.0.0')
      expect(dir).toBe(
        `/path/to/jan/llamacpp-upstream/backends/v2.0.0/win-common_cpus-x64`
      )

      const exePath = await getBackendExePath('win-common_cpus-x64', 'v2.0.0')
      expect(exePath).toBe(
        `/path/to/jan/llamacpp-upstream/backends/v2.0.0/win-common_cpus-x64/build/bin/llama-server`
      )
    })
  })

  describe('isBackendInstalled', () => {
    it('should return true when backend is installed using its specific name', async () => {
      vi.stubGlobal('IS_WINDOWS', false) // Linux/macOS for llama-server
      // Mock both the check for the 'build' directory and the final executable path
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        const expectedExePath = `/path/to/jan/llamacpp-upstream/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
        if (path === expectedExePath) return true
        if (path.endsWith('/build')) return true
        return false
      })

      const result = await isBackendInstalled('win-avx2-x64', 'v1.0.0')
      expect(result).toBe(true)
      // Check that it was called with the final exe path
      expect(fs.existsSync).toHaveBeenCalledWith(
        `/path/to/jan/llamacpp-upstream/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
      )
    })
  })
  describe('isBackendInstalled', () => {
    it('should return true when backend is installed using its specific name', async () => {
      vi.stubGlobal('IS_WINDOWS', false) // Linux/macOS for llama-server
      // Mock both the check for the 'build' directory and the final executable path
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        const expectedExePath = `${MOCK_JAN_PATH_STRING}/llamacpp-upstream/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
        if (path === expectedExePath) return true
        if (path.endsWith('/build')) return true
        return false
      })

      const result = await isBackendInstalled('win-avx2-x64', 'v1.0.0')
      expect(result).toBe(true)
      // Check that it was called with the final exe path
      expect(fs.existsSync).toHaveBeenCalledWith(
        `${MOCK_JAN_PATH_STRING}/llamacpp-upstream/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
      )
    })
  })
})

describe('fetchRemoteBackends (immutable YoreBot catalog)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns only verified CPU and Vulkan pins for Windows x64', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'windows',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)

    const backends = await fetchRemoteBackends()
    expect(backends).toEqual([
      { version: 'b10431', backend: 'win-cpu-x64', order: 0 },
      { version: 'b10431', backend: 'win-vulkan-x64', order: 0 },
    ])
  })

  it('pins every downloadable archive by exact URL, size, and sha256', () => {
    expect(PINNED_BACKEND_ARTIFACTS).toHaveLength(2)
    for (const artifact of PINNED_BACKEND_ARTIFACTS) {
      expect(artifact.url).toBe(
        `https://github.com/ggml-org/llama.cpp/releases/download/${artifact.version}/${artifact.filename}`
      )
      expect(artifact.size).toBeGreaterThan(0)
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(
        getBackendDownloadUrl(artifact.version, artifact.backend)
      ).toBe(artifact.url)
    }
  })

  it.each([
    ['macos', 'arm64'],
    ['linux', 'x86_64'],
    ['windows', 'aarch64'],
  ])('keeps %s %s on its bundled backend', async (os_type, arch) => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type,
      cpu: { arch, extensions: [] },
      gpus: [],
    } as any)

    await expect(fetchRemoteBackends()).resolves.toEqual([])
  })
})
