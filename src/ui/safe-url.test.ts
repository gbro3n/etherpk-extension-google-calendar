import { describe, expect, it } from 'vitest'

import { safeUrl } from './safe-url'

describe('an address from an event, in a link', () => {
    it('keeps web, phone and mail addresses', () => {
        expect(safeUrl('https://drive.google.com/file/d/seeds/view')).toBe('https://drive.google.com/file/d/seeds/view')
        expect(safeUrl('tel:+44-20-0000-0000')).toBe('tel:+44-20-0000-0000')
        expect(safeUrl('mailto:gardener@example.com')).toBe('mailto:gardener@example.com')
    })

    it('drops any other kind, and what is not an address', () => {
        expect(safeUrl('javascript:alert(1)')).toBeUndefined()
        expect(safeUrl('data:text/html,beans')).toBeUndefined()
        expect(safeUrl('not an address')).toBeUndefined()
        expect(safeUrl(undefined)).toBeUndefined()
    })
})
