import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom persists the document between tests in a file, so an uncleaned tree
// leaks into the next test and makes failures depend on execution order.
afterEach(cleanup)
