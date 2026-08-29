import { describe, expect, it } from 'vitest'

import { parseAtomicChatDeepLink } from './parse'

describe('parseAtomicChatDeepLink', () => {
  it('rejects YoreBot model import links', () => {
    expect(
      parseAtomicChatDeepLink(
        'yorebot://models/huggingface/owner/model-GGUF'
      )
    ).toBeNull()
  })

  it('rejects non-YoreBot schemes', () => {
    expect(
      parseAtomicChatDeepLink('jan://models/huggingface/owner/model-GGUF')
    ).toBeNull()
  })

  it('rejects incomplete Hugging Face paths', () => {
    expect(
      parseAtomicChatDeepLink('yorebot://models/huggingface/owner')
    ).toBeNull()
  })
})
