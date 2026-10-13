import { describe, expect, it } from 'vitest'
import { CALENDAR_COLORS, EVENT_COLORS, calendarColor, contrastRatio, eventColor, textColorOn } from './colors'

const HEX = /^#[0-9a-f]{6}$/

describe('the palettes', () => {
    it('name the 11 event colours by id', () => {
        expect(Object.keys(EVENT_COLORS)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
        expect(Object.values(EVENT_COLORS).map((color) => color.name)).toEqual([
            'Lavender', 'Sage', 'Grape', 'Flamingo', 'Banana', 'Tangerine', 'Peacock', 'Graphite', 'Blueberry', 'Basil', 'Tomato',
        ])
        for (const color of Object.values(EVENT_COLORS)) expect(color.background).toMatch(HEX)
    })

    it('hold 24 calendar colours with distinct names and classic values', () => {
        expect(CALENDAR_COLORS).toHaveLength(24)
        expect(new Set(CALENDAR_COLORS.map((color) => color.name)).size).toBe(24)
        expect(new Set(CALENDAR_COLORS.map((color) => color.old)).size).toBe(24)
        for (const color of CALENDAR_COLORS) {
            expect(color.old).toMatch(HEX)
            expect(color.background).toMatch(HEX)
        }
    })

    it('give a colour that both palettes name the same modern value', () => {
        for (const event of Object.values(EVENT_COLORS)) {
            expect(CALENDAR_COLORS.find((color) => color.name === event.name)?.background).toBe(event.background)
        }
    })
})

describe('calendarColor', () => {
    it('shows a classic value as its modern colour', () => {
        expect(calendarColor({ backgroundColor: '#9fe1e7' })).toBe('#039be5')
        expect(calendarColor({ backgroundColor: '#AC725E', colorId: '1' })).toBe('#795548')
        expect(calendarColor({ backgroundColor: '#cca6ac' })).toBe('#ad1457')
    })

    it('keeps a colour the person picked as it is', () => {
        expect(calendarColor({ backgroundColor: '#123456', colorId: '14' })).toBe('#123456')
        expect(calendarColor({ backgroundColor: '#ABCDEF' })).toBe('#ABCDEF')
        expect(calendarColor({ backgroundColor: '#039be5' })).toBe('#039be5')
    })

    it('falls back to the colour id, then to Peacock', () => {
        expect(calendarColor({ colorId: '8' })).toBe('#0b8043')
        expect(calendarColor({ colorId: '99' })).toBe('#039be5')
        expect(calendarColor({})).toBe('#039be5')
    })
})

describe('eventColor', () => {
    const labels = [
        { id: 'garden', name: 'Garden', color: '#7c54c0' },
        { id: 'kitchen', name: 'Kitchen' },
    ]

    it('takes the colour of a label the calendar defines', () => {
        expect(eventColor({ eventLabelId: 'garden', colorId: '8' }, '#039be5', labels)).toBe('#7c54c0')
    })

    it('reads a label colour under the name Google gives it', () => {
        const googleShaped = [{ id: 'shed', name: 'Shed', backgroundColor: '#ab234c' }]
        expect(eventColor({ eventLabelId: 'shed' }, '#039be5', googleShaped)).toBe('#ab234c')
    })

    it('falls back to the colour id for an unknown label or one with no colour', () => {
        expect(eventColor({ eventLabelId: 'shed', colorId: '11' }, '#039be5', labels)).toBe('#d50000')
        expect(eventColor({ eventLabelId: 'kitchen', colorId: '5' }, '#039be5', labels)).toBe('#f6bf26')
        expect(eventColor({ eventLabelId: 'garden', colorId: '5' }, '#039be5')).toBe('#f6bf26')
    })

    it('falls back to the calendar colour', () => {
        expect(eventColor({}, '#795548')).toBe('#795548')
        expect(eventColor({ colorId: '99' }, '#795548')).toBe('#795548')
        expect(eventColor({ eventLabelId: 'shed' }, '#795548', labels)).toBe('#795548')
    })
})

describe('contrastRatio', () => {
    it('runs from 1 for the same colour to 21 for black on white', () => {
        expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
        expect(contrastRatio('#000', '#FFF')).toBeCloseTo(21, 5)
        expect(contrastRatio('#3f51b5', '#3F51B5')).toBe(1)
    })

    it('is the same both ways round', () => {
        expect(contrastRatio('#f6bf26', '#1f1f1f')).toBe(contrastRatio('#1f1f1f', '#f6bf26'))
    })

    it('matches known WCAG values', () => {
        // #767676 is the lightest grey that passes 4.5:1 on white.
        expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
        expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
    })

    it('gives NaN for a value that is not a colour', () => {
        expect(contrastRatio('green', '#ffffff')).toBeNaN()
        expect(contrastRatio('#12345', '#ffffff')).toBeNaN()
    })
})

describe('textColorOn', () => {
    it('puts dark text on light colours and white text on dark ones', () => {
        expect(textColorOn('#ffffff')).toBe('#1f1f1f')
        expect(textColorOn('#f6bf26')).toBe('#1f1f1f')
        expect(textColorOn('#fbe983')).toBe('#1f1f1f')
        expect(textColorOn('#000')).toBe('#ffffff')
        expect(textColorOn('#3f51b5')).toBe('#ffffff')
        expect(textColorOn('#d50000')).toBe('#ffffff')
        expect(textColorOn('#616161')).toBe('#ffffff')
    })

    it('picks the colour with the higher ratio for every palette colour', () => {
        const backgrounds = [...CALENDAR_COLORS.flatMap((color) => [color.old, color.background]), ...Object.values(EVENT_COLORS).map((color) => color.background)]
        for (const background of backgrounds) {
            const chosen = textColorOn(background)
            const other = chosen === '#ffffff' ? '#1f1f1f' : '#ffffff'
            expect(contrastRatio(background, chosen)).toBeGreaterThanOrEqual(contrastRatio(background, other))
            // White and #1f1f1f always leave one of them above 4:1.
            expect(contrastRatio(background, chosen)).toBeGreaterThan(4)
        }
    })

    it('gives dark text for a background it cannot read', () => {
        expect(textColorOn('transparent')).toBe('#1f1f1f')
    })
})
