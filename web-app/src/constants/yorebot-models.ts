import { estimateFit, getMemoryBudgetBytes } from '@/lib/model-card'

export type YoreBotPinnedModel = {
  id: string
  baseModel: string
  repository: string
  packager: string
  developer: string
  license: 'Apache-2.0'
  revision: string
  filename: string
  sizeBytes: number
  sha256: string
  url: string
}

const pinnedModel = (
  value: Omit<YoreBotPinnedModel, 'url'>
): YoreBotPinnedModel => ({
  ...value,
  url: `https://huggingface.co/${value.repository}/resolve/${value.revision}/${value.filename}`,
})

export const YOREBOT_PINNED_MODELS: readonly YoreBotPinnedModel[] = [
  pinnedModel({
    id: 'Qwen3.5-9B-Q4_K_M',
    baseModel: 'Qwen/Qwen3.5-9B',
    repository: 'unsloth/Qwen3.5-9B-GGUF',
    packager: 'unsloth',
    developer: 'Qwen',
    license: 'Apache-2.0',
    revision: '3885219b6810b007914f3a7950a8d1b469d598a5',
    filename: 'Qwen3.5-9B-Q4_K_M.gguf',
    sizeBytes: 5_680_522_464,
    sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
  }),
  pinnedModel({
    id: 'Qwen3.8-27B-Q4_K_M',
    baseModel: 'Qwen/Qwen3.8-27B',
    repository: 'ggml-org/Qwen3.8-27B-GGUF',
    packager: 'ggml-org',
    developer: 'Qwen',
    license: 'Apache-2.0',
    revision: '0669b98607d47046c7c2b3f801011d54a08cfccf',
    filename: 'Qwen3.8-27B-Q4_K_M.gguf',
    sizeBytes: 18_973_870_432,
    sha256: '31629f53165ab6a7dad8c9847dcfd1fdf55829dac1e6e748f4a68581b0033d34',
  }),
]

export function selectPinnedModelForHardware(hardware: {
  total_memory?: number
  gpus?: Array<{ total_memory?: number }>
}): YoreBotPinnedModel | undefined {
  const budgetBytes = getMemoryBudgetBytes(hardware)
  if (!budgetBytes) return undefined

  return [...YOREBOT_PINNED_MODELS]
    .sort((left, right) => right.sizeBytes - left.sizeBytes)
    .find((model) => estimateFit(model.sizeBytes, budgetBytes) === 'ok')
}
