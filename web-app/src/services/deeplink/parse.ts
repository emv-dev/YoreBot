export type AtomicChatDeepLinkTarget = {
  provider: 'huggingface'
  repo: string
  modelId: string
}

export function parseAtomicChatDeepLink(
  deeplink: string
): AtomicChatDeepLinkTarget | null {
  void deeplink
  // The consumer MVP chooses one verified local model automatically. Model
  // import links would reintroduce a hidden model/provider selection surface.
  return null
}
