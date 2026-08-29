import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RenderMarkdown } from '../RenderMarkdown'

describe('assistant Markdown egress boundary', () => {
  it('never emits fetch-capable image elements from Markdown or raw HTML', () => {
    const sentinelUrls = [
      'https://sentinel.invalid/markdown.png',
      'http://sentinel.invalid/plain.png',
      '//sentinel.invalid/protocol-relative.png',
      'https://127.0.0.1.attacker.invalid/lookalike.png',
    ]
    const content = [
      'Remote image sentinels must stay inert.',
      ...sentinelUrls.map((url, index) => `![sentinel-${index}](${url})`),
      '<img src="https://sentinel.invalid/raw.png" alt="raw-sentinel">',
    ].join('\n\n')

    const { container } = render(
      <RenderMarkdown
        content={content}
        enableHtmlPreview
        allowRawHtml
        components={{
          img: ({ alt, ...props }) => (
            <img alt={alt ?? ''} data-caller-image="true" {...props} />
          ),
        }}
      />
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.innerHTML).not.toContain('sentinel.invalid')
    for (const alt of [
      'sentinel-0',
      'sentinel-1',
      'sentinel-2',
      'sentinel-3',
      'raw-sentinel',
    ]) {
      expect(container.textContent).toContain(`Image blocked: ${alt}`)
    }
  })

  it('keeps Mermaid remote-image syntax inert', async () => {
    const content = `A diagram must not fetch its image directive.

\`\`\`mermaid
flowchart LR
  A@{ img: "https://sentinel.invalid/mermaid.png" } --> B
\`\`\``

    const { container } = render(<RenderMarkdown content={content} />)

    await waitFor(() => {
      expect(container.textContent).toContain('sentinel.invalid/mermaid.png')
    })
    expect(container.querySelector('img')).toBeNull()
    expect(container.innerHTML).not.toContain('src="https://sentinel.invalid')
  })
})
