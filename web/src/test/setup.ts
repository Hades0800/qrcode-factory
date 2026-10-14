import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// jsdom 沒有這兩個，元件會用到
window.confirm = vi.fn(() => true)
window.open = vi.fn()
