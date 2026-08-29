import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NavMain } from '../NavMain'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <ul>{children}</ul>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <li>{children}</li>
  ),
  SidebarMenuButton: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('NavMain', () => {
  it('exposes only the new conversation outcome', () => {
    const { rerender } = render(<NavMain mode="chat" />)

    expect(screen.getByText('common:newChat')).toBeInTheDocument()
    expect(screen.queryByText('common:models')).not.toBeInTheDocument()
    expect(screen.queryByText('common:skills')).not.toBeInTheDocument()
    expect(screen.queryByText('common:launch')).not.toBeInTheDocument()
    expect(screen.queryByText('common:projects.new')).not.toBeInTheDocument()

    rerender(<NavMain mode="agent" />)

    expect(screen.getByText('common:newTask')).toBeInTheDocument()
    expect(screen.queryByText('common:newChat')).not.toBeInTheDocument()
  })
})
