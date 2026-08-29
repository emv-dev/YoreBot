import { getJanDataFolderPath, fs, joinPath } from '@janhq/core'
import { getSystemInfo } from './hardware'
import {
  getLocalInstalledBackendsInternal,
  normalizeFeatures,
  determineSupportedBackends,
  listSupportedBackendsFromRust,
  BackendVersion,
  getSupportedFeaturesFromRust,
  mapOldBackendToNew,
} from '../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index'

const LLAMACPP_DOWNLOAD_BASE =
  'https://github.com/ggml-org/llama.cpp/releases/download'

export type PinnedBackendArtifact = {
  version: 'b10431'
  backend: 'win-cpu-x64' | 'win-vulkan-x64'
  filename: string
  url: string
  size: number
  sha256: string
}

// YoreBot never resolves a mutable runtime manifest. CUDA is intentionally
// absent until its companion cudart archive can be pinned and verified too.
export const PINNED_BACKEND_ARTIFACTS: readonly PinnedBackendArtifact[] = [
  {
    version: 'b10431',
    backend: 'win-cpu-x64',
    filename: 'llama-b10431-bin-win-cpu-x64.zip',
    url: `${LLAMACPP_DOWNLOAD_BASE}/b10431/llama-b10431-bin-win-cpu-x64.zip`,
    size: 18_462_983,
    sha256: 'aa16a2102de8730be6079f67f77997ca549e9a07125563571afb2fb4e810ec2c',
  },
  {
    version: 'b10431',
    backend: 'win-vulkan-x64',
    filename: 'llama-b10431-bin-win-vulkan-x64.zip',
    url: `${LLAMACPP_DOWNLOAD_BASE}/b10431/llama-b10431-bin-win-vulkan-x64.zip`,
    size: 34_570_726,
    sha256: 'c5f8d6a4bd451d90bb2aba3bd705bf1b02125742fc5f45623ad8d5d4444ffbe1',
  },
]

export function getPinnedBackendArtifact(
  version: string,
  backend: string
): PinnedBackendArtifact | null {
  return (
    PINNED_BACKEND_ARTIFACTS.find(
      (artifact) => artifact.version === version && artifact.backend === backend
    ) ?? null
  )
}

export async function getLocalInstalledBackends(): Promise<BackendVersion[]> {
  const janDataFolderPath = await getJanDataFolderPath()
  // Separate root from the turboquant extension to avoid stomping on each
  // other's installed backends.
  const backendDir = await joinPath([
    janDataFolderPath,
    'llamacpp-upstream',
    'backends',
  ])
  return await getLocalInstalledBackendsInternal(backendDir)
}
// folder structure
// <Jan's data folder>/llamacpp-upstream/backends/<backend_version>/<backend_type>

/**
 * Return the immutable YoreBot runtime catalog for this machine.
 *
 * Windows x64 may install the verified CPU or Vulkan package. macOS and Linux
 * stay on the backend bundled with the application until equivalent archive
 * hashes are pinned; no mutable remote manifest is fetched.
 */
export async function fetchRemoteBackends(): Promise<BackendVersion[]> {
  const sysInfo = await getSystemInfo()
  if (sysInfo.os_type !== 'windows') return []
  const arch = sysInfo.cpu.arch.toLowerCase()
  if (arch.includes('arm64') || arch.includes('aarch64')) return []
  return PINNED_BACKEND_ARTIFACTS.map(({ version, backend }) => ({
    version,
    backend,
    order: 0,
  }))
}

/**
 * Builds the download URL for a specific backend version from ggml-org/llama.cpp.
 *
 * Asset naming differs by platform:
 *   - macOS: `llama-{tag}-bin-macos-{arm64,x64}.zip`
 *   - Windows: `llama-{tag}-bin-win-{variant}.zip`
 * Only exact artifacts in `PINNED_BACKEND_ARTIFACTS` are accepted.
 */
export function getBackendDownloadUrl(
  version: string,
  backend: string
): string {
  version = version.replace(/\uFEFF/g, '').trim()
  backend = backend.replace(/\uFEFF/g, '').trim()
  const artifact = getPinnedBackendArtifact(version, backend)
  if (!artifact) {
    throw new Error(`Backend is not pinned for YoreBot: ${version}/${backend}`)
  }
  return artifact.url
}

export function getBackendArchiveName(version: string, backend: string): string {
  version = version.replace(/\uFEFF/g, '').trim()
  backend = backend.replace(/\uFEFF/g, '').trim()
  const artifact = getPinnedBackendArtifact(version, backend)
  if (!artifact) {
    throw new Error(`Backend is not pinned for YoreBot: ${version}/${backend}`)
  }
  return artifact.filename
}

/**
 * Maps an internal backend id (e.g. `win-cuda-13.4-x64`, `linux-vulkan-x64`)
 * to a short human-friendly variant label used by the "Latest <variant>"
 * dropdown entries. Falls back to the raw id for anything unrecognised.
 */
export function friendlyBackendLabel(backend: string): string {
  const id = backend.replace(/\uFEFF/g, '').trim()
  if (id.endsWith('cpu-x64')) return 'CPU'
  if (id.includes('cuda-13')) return 'CUDA 13'
  if (id.includes('cuda-12')) return 'CUDA 12'
  if (id.includes('vulkan')) return 'Vulkan'
  return id
}

/**
 * Maps a Windows CUDA backend variant id (e.g. `win-cuda-13.4-x64`) to
 * the matching cudart asset on the same ggml-org/llama.cpp release.
 *
 * The main `llama-{tag}-bin-win-cuda-{12.4,13.x}-x64.zip` archives ship
 * only the llama-server executable and its direct deps; the CUDA Toolkit
 * runtime DLLs (cudart64_*.dll, cublas64_*.dll, cublasLt64_*.dll, …)
 * live in a sibling `cudart-llama-bin-win-cuda-{12.4,13.x}-x64.zip`.
 * Without those DLLs, `llama-server.exe --list-devices` returns an empty
 * device list on machines that don't have the CUDA Toolkit installed
 * system-wide (GitHub issue AtomicBot-ai/Atomic-Chat#14).
 *
 * ggml-org dropped CUDA 11 release artifacts — the lowest CUDA tier
 * shipped is CUDA 12.4. Hosts whose driver only supports CUDA 11 fall
 * back to the CPU build via runtime driver-version gating.
 */
const WINDOWS_CUDA_BACKEND_RE = /^win-cuda-(12\.\d+|13\.\d+)-x64$/

function matchWindowsCudaBackend(
  backend: string
): string | null {
  const match = WINDOWS_CUDA_BACKEND_RE.exec(backend.replace(/\uFEFF/g, '').trim())
  if (!match) return null
  return match[1]
}

function buildWindowsCudartArchiveName(cudaToolkitVersion: string): string {
  return `cudart-llama-bin-win-cuda-${cudaToolkitVersion}-x64.zip`
}

/**
 * Returns the download URL for the cudart companion archive that must be
 * merged into `<backendDir>/build/bin/` for a Windows CUDA backend, or
 * `null` if `backend` is not one of the Windows CUDA variants.
 */
export function getCudartDownloadUrl(
  version: string,
  backend: string
): string | null {
  const toolkitVersion = matchWindowsCudaBackend(backend)
  if (!toolkitVersion) return null
  const filename = buildWindowsCudartArchiveName(toolkitVersion)
  const cleanVersion = version.replace(/\uFEFF/g, '').trim()
  return `${LLAMACPP_DOWNLOAD_BASE}/${cleanVersion}/${filename}`
}

/**
 * Returns the cudart filename (without URL) for a Windows CUDA backend,
 * or `null` if the backend is not a Windows CUDA variant.
 */
export function getCudartArchiveName(backend: string): string | null {
  const toolkitVersion = matchWindowsCudaBackend(backend)
  if (!toolkitVersion) return null
  return buildWindowsCudartArchiveName(toolkitVersion)
}

/**
 * Returns the CUDA Toolkit version string (e.g. `13.3`) that the Rust
 * `is_cuda_installed` command expects for a given Windows CUDA backend.
 * `null` for non-CUDA backends.
 */
export function getCudaToolkitVersion(backend: string): string | null {
  return matchWindowsCudaBackend(backend)
}

/**
 * Matches a *minor-less* Windows CUDA family id (e.g. `win-cuda-13-x64`,
 * `win-cuda-12-x64`). These are the family ids the Rust matrix
 * (`determine_supported_backends`) and the TS dropdown `staticVariants`
 * emit — the concrete minor (`13.3`, `12.4`) is only known once the
 * ggml-org release stream is queried (ATO-105/ATO-174).
 */
const WIN_CUDA_FAMILY_RE = /^win-cuda-(\d+)-x64$/

/**
 * The CUDA major (`"13"`, `"12"`) of a minor-less family id, or `null` if
 * `backend` is not a minor-less Windows CUDA family id (concrete ids like
 * `win-cuda-13.3-x64` deliberately return `null` here — they need no
 * family resolution).
 */
export function cudaFamilyMajor(backend: string): string | null {
  const m = WIN_CUDA_FAMILY_RE.exec(backend.replace(/\uFEFF/g, '').trim())
  return m ? m[1] : null
}

/**
 * True when `concrete` (e.g. `win-cuda-13.3-x64`) belongs to the minor-less
 * CUDA family `familyBackend` (e.g. `win-cuda-13-x64`). False for a
 * non-family `familyBackend` or a non-matching major.
 */
export function isConcreteOfCudaFamily(
  familyBackend: string,
  concrete: string
): boolean {
  const major = cudaFamilyMajor(familyBackend)
  if (!major) return false
  return new RegExp(`^win-cuda-${major}\\.\\d+-x64$`).test(
    concrete.replace(/\uFEFF/g, '').trim()
  )
}

/**
 * Resolves a minor-less CUDA family id (`win-cuda-13-x64`) to the newest
 * concrete `<tag>/<backend>` of that major in `remote` (e.g.
 * `b9596/win-cuda-13.3-x64`). Picks the highest minor when ggml-org ships
 * more than one. Returns `null` when `familyBackend` is not a family id or
 * no concrete asset of that major is present.
 */
export function resolveCudaFamilyConcrete(
  familyBackend: string,
  remote: BackendVersion[]
): string | null {
  const major = cudaFamilyMajor(familyBackend)
  if (!major) return null
  const concreteRe = new RegExp(`^win-cuda-${major}\\.(\\d+)-x64$`)
  let best: { version: string; backend: string; minor: number } | null = null
  for (const b of remote) {
    const backendName = b.backend.replace(/\uFEFF/g, '').trim()
    const m = concreteRe.exec(backendName)
    if (!m) continue
    const minor = parseInt(m[1], 10)
    if (!best || minor > best.minor) {
      best = { version: b.version, backend: backendName, minor }
    }
  }
  return best ? `${best.version}/${best.backend}` : null
}

export async function listSupportedBackends(): Promise<BackendVersion[]> {
  const sysInfo = await getSystemInfo()
  const osType = sysInfo.os_type
  const arch = sysInfo.cpu.arch

  console.info('[listSupportedBackends] sysInfo:', osType, arch)

  const rawFeatures = await _getSupportedFeatures()
  const features = normalizeFeatures(rawFeatures)

  const supportedBackends = await determineSupportedBackends(
    osType,
    arch,
    features
  )
  console.info('[listSupportedBackends] supportedBackends:', supportedBackends)

  const [localBackendVersions, remoteBackendVersions] = await Promise.all([
    getLocalInstalledBackends(),
    fetchRemoteBackends(),
  ])
  console.info(
    '[listSupportedBackends] local backends:',
    localBackendVersions.length,
    localBackendVersions
  )
  console.info(
    '[listSupportedBackends] remote backends:',
    remoteBackendVersions.length,
    remoteBackendVersions.map((b) => `${b.version}/${b.backend}`)
  )

  const mergedBackends = await listSupportedBackendsFromRust(
    remoteBackendVersions,
    localBackendVersions
  )

  // Hardware-gated backend matrix applies on Windows: the user only sees
  // backends whose driver/Vulkan/CUDA requirements are actually met on
  // this host. macOS keeps the merged list unfiltered (every ggml-org
  // macOS asset is supported on the matching arch).
  if (osType !== 'windows') {
    void supportedBackends
    void mapOldBackendToNew
    return mergedBackends
  }

  const supportedSet = new Set(supportedBackends)
  // CUDA-13 is matched family-wise (ATO-105): ggml-org periodically bumps
  // the toolkit minor (13.1 -> 13.3 -> 13.x) in its release assets, so the
  // supported set carries the minor-less family id `win-cuda-13-x64` (emitted
  // by `determine_supported_backends`) instead of a hardcoded concrete minor.
  // Any concrete `win-cuda-13.<minor>-x64` asset is accepted when the family
  // is supported, and the concrete id (e.g. `win-cuda-13.4-x64`) keeps
  // flowing downstream unchanged so the right asset is downloaded.
  const WIN_CUDA13_CONCRETE_RE = /^win-cuda-13\.\d+-(x64|arm64)$/
  const isSupported = (rawBackend: string, normalizedBackend: string): boolean => {
    if (supportedSet.has(normalizedBackend)) return true
    const m = WIN_CUDA13_CONCRETE_RE.exec(rawBackend)
    if (m) {
      return supportedSet.has(`win-cuda-13-${m[1]}`)
    }
    return false
  }

  const filteredBackends = await Promise.all(
    mergedBackends.map(async (backendInfo) => ({
      backendInfo,
      rawBackend: backendInfo.backend.replace(/\uFEFF/g, '').trim(),
      normalizedBackend: await mapOldBackendToNew(backendInfo.backend),
    }))
  )

  const supportedMergedBackends = filteredBackends
    .filter(({ rawBackend, normalizedBackend }) =>
      isSupported(rawBackend, normalizedBackend)
    )
    .map(({ backendInfo }) => backendInfo)

  console.info(
    '[listSupportedBackends] windows filtered backends:',
    supportedMergedBackends.length,
    supportedMergedBackends.map((b) => `${b.version}/${b.backend}`)
  )

  return supportedMergedBackends
}

export async function getBackendDir(
  backend: string,
  version: string
): Promise<string> {
  const janDataFolderPath = await getJanDataFolderPath()
  const backendDir = await joinPath([
    janDataFolderPath,
    'llamacpp-upstream',
    'backends',
    version.replace(/\uFEFF/g, '').trim(),
    backend.replace(/\uFEFF/g, '').trim(),
  ])
  return backendDir
}

export async function getBackendExePath(
  backend: string,
  version: string
): Promise<string> {
  const exe_name = IS_WINDOWS ? 'llama-server.exe' : 'llama-server'
  const backendDir = await getBackendDir(backend, version)
  let exePath: string
  const buildDir = await joinPath([backendDir, 'build'])
  if (await fs.existsSync(buildDir)) {
    exePath = await joinPath([backendDir, 'build', 'bin', exe_name])
  } else {
    exePath = await joinPath([backendDir, exe_name])
  }
  return exePath
}

export async function isBackendInstalled(
  backend: string,
  version: string
): Promise<boolean> {
  const exePath = await getBackendExePath(backend, version)
  const result = await fs.existsSync(exePath)
  return result
}

/**
 * Compute the set of backend type strings that are equivalent to `backendType`
 * for the purpose of compatibility checking (ATO-233). In particular, ggml-org
 * Linux tarballs carry `ubuntu-*` asset names (e.g. `ubuntu-vulkan-x64`), but
 * the extension stores backends under `linux-*` internal ids
 * (`linux-vulkan-x64`). Backends installed via "Install Backend from File"
 * with an unpatched version of the app may therefore be on disk under the
 * ubuntu name. This helper returns ALL names that should be treated as the
 * same type so `findCompatibleInstalledBackend` can find them.
 */
function backendTypeEquivalents(backendType: string): Set<string> {
  const ids = new Set<string>()
  const bt = backendType.replace(/\uFEFF/g, '').trim()
  ids.add(bt)
  // linux-vulkan-x64 ↔ ubuntu-vulkan-x64
  if (bt === 'linux-vulkan-x64') ids.add('ubuntu-vulkan-x64')
  if (bt === 'linux-vulkan-arm64') ids.add('ubuntu-vulkan-arm64')
  if (bt === 'linux-cpu-x64') ids.add('ubuntu-x64')
  if (bt === 'linux-cpu-arm64') ids.add('ubuntu-arm64')
  // Reverse mappings: when the on-disk name is the ubuntu variant
  if (bt === 'ubuntu-vulkan-x64') ids.add('linux-vulkan-x64')
  if (bt === 'ubuntu-vulkan-arm64') ids.add('linux-vulkan-arm64')
  if (bt === 'ubuntu-x64') ids.add('linux-cpu-x64')
  if (bt === 'ubuntu-arm64') ids.add('linux-cpu-arm64')
  return ids
}

/**
 * Find a working, already-installed backend of the SAME type as `backendType`
 * (e.g. `macos-arm64`), regardless of its release tag. Used as a fallback
 * (ATO-179, AC2) when the model's pinned `version_backend` can't be obtained
 * (download failed / the tag was pruned upstream) but a compatible build is
 * already on disk — so the load degrades to a working backend instead of
 * failing with `BINARY_NOT_FOUND`.
 *
 * "Compatible" is deliberately limited to the identical backend type: every
 * release tag of the same type targets the same platform / GPU variant and is
 * interchangeable. We do NOT cross types here (e.g. cuda → cpu) — that is a
 * feature/perf trade-off that must stay an explicit user choice.
 *
 * ATO-233: also recognises `ubuntu-*` ↔ `linux-*` name equivalents so that
 * backends installed via "Install Backend from File" with ggml-org upstream
 * tarball names are found even if the on-disk directory still uses the old
 * ubuntu name.
 *
 * Returns the newest (by on-disk mtime, via `order`) matching backend, or
 * `null` when none is installed.
 */
export async function findCompatibleInstalledBackend(
  backendType: string
): Promise<BackendVersion | null> {
  const equivalents = backendTypeEquivalents(backendType)
  const installed = await getLocalInstalledBackends()
  const sameType = installed.filter((b) =>
    equivalents.has(b.backend.replace(/\uFEFF/g, '').trim())
  )
  if (sameType.length === 0) return null
  sameType.sort((a, b) => (b.order ?? 0) - (a.order ?? 0))
  return sameType[0]
}

/**
 * Remove orphan / incomplete backend directories from this provider's
 * backends tree (ATO-179, AC3). An "incomplete" directory is one that exists
 * on disk but carries no `llama-server` executable — e.g. an empty stub left
 * by an interrupted/failed download, which would otherwise be mistaken for a
 * usable backend or block a clean re-download.
 *
 * Scoped strictly to `llamacpp-upstream/backends/` so the shared GGUF model
 * tree and the turboquant `llamacpp` backends are never touched. Best-effort:
 * a failure on any single entry is logged by the caller and does not abort the
 * sweep. Returns the list of removed `<version>/<backend>` identifiers.
 */
export async function cleanupIncompleteBackends(): Promise<string[]> {
  const janDataFolderPath = await getJanDataFolderPath()
  const backendsRoot = await joinPath([
    janDataFolderPath,
    'llamacpp-upstream',
    'backends',
  ])

  const removed: string[] = []
  if (!(await fs.existsSync(backendsRoot))) return removed

  const versionDirs: string[] = await fs.readdirSync(backendsRoot)
  for (const version of versionDirs) {
    const versionPath = await joinPath([backendsRoot, version])
    let backendTypes: string[]
    try {
      backendTypes = await fs.readdirSync(versionPath)
    } catch {
      // Not a directory (stray file) — skip; it does not match our layout.
      continue
    }

    for (const backendType of backendTypes) {
      if (await isBackendInstalled(backendType, version)) continue
      const dir = await getBackendDir(backendType, version)
      await fs.rm(dir)
      removed.push(`${version}/${backendType}`)
    }

    // Drop a now-empty version directory.
    try {
      const remaining: string[] = await fs.readdirSync(versionPath)
      if (remaining.length === 0) await fs.rm(versionPath)
    } catch {
      // ignore
    }
  }

  return removed
}

async function _getSupportedFeatures() {
  const sysInfo = await getSystemInfo()
  return await getSupportedFeaturesFromRust(
    sysInfo.os_type,
    sysInfo.cpu.extensions,
    sysInfo.gpus
  )
}
