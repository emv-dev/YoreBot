import { describe, expect, it } from 'vitest'
import {
  selectPinnedModelForHardware,
  YOREBOT_PINNED_MODELS,
} from './yorebot-models'

describe('YoreBot pinned model selection', () => {
  it('selects the largest pinned model that existing fit logic marks ok', () => {
    expect(
      selectPinnedModelForHardware({ total_memory: 32 * 1024 })?.id
    ).toBe('Qwen3.8-27B-Q4_K_M')
    expect(
      selectPinnedModelForHardware({ total_memory: 16 * 1024 })?.id
    ).toBe('Qwen3.5-9B-Q4_K_M')
  })

  it('fails closed when memory is unknown or no pinned model is ok', () => {
    expect(selectPinnedModelForHardware({})).toBeUndefined()
    expect(
      selectPinnedModelForHardware({ total_memory: 4 * 1024 })
    ).toBeUndefined()
  })

  it('pins immutable urls, sizes, and sha256 hashes', () => {
    for (const model of YOREBOT_PINNED_MODELS) {
      expect(model.url).toContain(`/resolve/${model.revision}/`)
      expect(model.url.endsWith(`/${model.filename}`)).toBe(true)
      expect(model.sizeBytes).toBeGreaterThan(0)
      expect(model.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(model.url).not.toContain('/resolve/main/')
    }
  })
})
