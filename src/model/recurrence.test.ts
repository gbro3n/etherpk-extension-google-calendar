import { describe, expect, it } from 'vitest'
import {
    continueSeriesFrom,
    describeRule,
    endSeriesBefore,
    formatRecurrence,
    parseRecurrence,
    presetFor,
    repeatPresets,
    splitExceptions,
    type RepeatRule,
} from './recurrence'

/** A moment as RFC 5545 writes a UTC DATE-TIME, by a route other than the module's own. */
function utcStamp(date: Date): string {
    return date.toISOString().replace(/\.\d{3}/, '').replace(/[-:]/g, '')
}

describe('parseRecurrence', () => {
    it('reads no lines as no rule', () => {
        expect(parseRecurrence(undefined)).toEqual({ rule: null, others: [] })
        expect(parseRecurrence([])).toEqual({ rule: null, others: [] })
    })

    it('reads a weekly rule and keeps the other lines as they were', () => {
        const lines = ['EXDATE;TZID=Europe/London:20261019T090000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'RDATE;VALUE=DATE:20261101', 'EXRULE:FREQ=MONTHLY;BYDAY=1MO']
        expect(parseRecurrence(lines)).toEqual({
            rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'WE'] },
            others: ['EXDATE;TZID=Europe/London:20261019T090000', 'RDATE;VALUE=DATE:20261101', 'EXRULE:FREQ=MONTHLY;BYDAY=1MO'],
        })
    })

    it('reads every part Google Calendar writes', () => {
        const { rule } = parseRecurrence(['RRULE:FREQ=YEARLY;INTERVAL=2;BYMONTH=10,11;BYMONTHDAY=12,-1;BYDAY=+2TU,-1FR;COUNT=5;WKST=SU'])
        expect(rule).toEqual({ freq: 'YEARLY', interval: 2, byMonth: [10, 11], byMonthDay: [12, -1], byDay: ['2TU', '-1FR'], count: 5, weekStart: 'SU' })
    })

    it('reads UNTIL as a date or a UTC time', () => {
        expect(parseRecurrence(['RRULE:FREQ=DAILY;UNTIL=20261201']).rule?.until).toBe('20261201')
        expect(parseRecurrence(['RRULE:FREQ=DAILY;UNTIL=20261201T235959Z']).rule?.until).toBe('20261201T235959Z')
    })

    it('reads the line whatever its case and spacing', () => {
        expect(parseRecurrence(['  rrule:freq=daily;byday=mo  ']).rule).toEqual({ freq: 'DAILY', interval: 1, byDay: ['MO'] })
    })

    it('marks a rule with a part it does not model as unsupported and keeps the line', () => {
        const line = 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'
        const { rule } = parseRecurrence([line])
        expect(rule).toMatchObject({ freq: 'MONTHLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], unsupported: true, source: line })
        expect(formatRecurrence(rule as RepeatRule, ['EXDATE:20261012T080000Z'])).toEqual([line, 'EXDATE:20261012T080000Z'])
    })

    it('marks other rules it cannot read as unsupported', () => {
        for (const line of [
            'RRULE:FREQ=HOURLY;INTERVAL=4',
            'RRULE:INTERVAL=2',
            'RRULE:FREQ=DAILY;INTERVAL=0',
            'RRULE:FREQ=WEEKLY;BYDAY=XX',
            'RRULE:FREQ=MONTHLY;BYMONTHDAY=0',
            'RRULE:FREQ=MONTHLY;BYMONTHDAY=32',
            'RRULE:FREQ=YEARLY;BYMONTH=13',
            'RRULE:FREQ=DAILY;COUNT=ten',
            'RRULE:FREQ=DAILY;UNTIL=1 December',
            'RRULE:FREQ=DAILY;FREQ=WEEKLY',
            'RRULE:FREQ=DAILY;BYHOUR=9',
        ]) {
            const { rule } = parseRecurrence([line])
            expect(rule?.unsupported, line).toBe(true)
            expect(rule?.source, line).toBe(line)
            expect(formatRecurrence(rule as RepeatRule), line).toEqual([line])
        }
    })

    it('keeps the first of several rules, as unsupported, and the rest among the other lines', () => {
        const { rule, others } = parseRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=MO', 'RRULE:FREQ=MONTHLY;BYDAY=1FR'])
        expect(rule).toMatchObject({ freq: 'WEEKLY', unsupported: true, source: 'RRULE:FREQ=WEEKLY;BYDAY=MO' })
        expect(others).toEqual(['RRULE:FREQ=MONTHLY;BYDAY=1FR'])
        expect(formatRecurrence(rule as RepeatRule, others)).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO', 'RRULE:FREQ=MONTHLY;BYDAY=1FR'])
    })
})

describe('formatRecurrence', () => {
    it('writes the RRULE first, then the other lines', () => {
        expect(formatRecurrence({ freq: 'WEEKLY', interval: 1, byDay: ['MO'] }, ['EXDATE;VALUE=DATE:20261012'])).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;VALUE=DATE:20261012'])
    })

    it('leaves out an interval of one', () => {
        expect(formatRecurrence({ freq: 'DAILY', interval: 1 })).toEqual(['RRULE:FREQ=DAILY'])
        expect(formatRecurrence({ freq: 'DAILY', interval: 3 })).toEqual(['RRULE:FREQ=DAILY;INTERVAL=3'])
    })

    const rules: RepeatRule[] = [
        { freq: 'DAILY', interval: 1 },
        { freq: 'DAILY', interval: 2, count: 10 },
        { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] },
        { freq: 'WEEKLY', interval: 2, byDay: ['MO', 'WE'], until: '20261201T235959Z', weekStart: 'SU' },
        { freq: 'MONTHLY', interval: 1, byDay: ['2TU'] },
        { freq: 'MONTHLY', interval: 1, byDay: ['-1FR'], until: '20271231' },
        { freq: 'MONTHLY', interval: 3, byMonthDay: [1, 15, -1] },
        { freq: 'YEARLY', interval: 1, byMonth: [11], byDay: ['4TH'] },
        { freq: 'YEARLY', interval: 1, byMonth: [10], byMonthDay: [12], count: 3 },
    ]

    it.each(rules.map((rule) => [formatRecurrence(rule)[0], rule] as const))('round-trips %s', (_line, rule) => {
        expect(parseRecurrence(formatRecurrence(rule)).rule).toEqual(rule)
    })

    it('reads back what Google writes, whatever order its parts come in', () => {
        for (const line of ['RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20261201T235959Z;BYDAY=MO,TU', 'RRULE:FREQ=MONTHLY;COUNT=5;BYDAY=-1FR', 'RRULE:FREQ=YEARLY']) {
            const { rule } = parseRecurrence([line])
            expect(rule?.unsupported).toBeUndefined()
            expect(parseRecurrence(formatRecurrence(rule as RepeatRule)).rule).toEqual(rule)
        }
    })
})

describe('repeatPresets', () => {
    it('offers both the fourth and the last Monday for Monday 26 October 2026', () => {
        const presets = repeatPresets(new Date(2026, 9, 26, 9))
        expect(presets.map((preset) => [preset.id, preset.label])).toEqual([
            ['none', 'Does not repeat'],
            ['daily', 'Daily'],
            ['weekly', 'Weekly on Monday'],
            ['monthly-nth', 'Monthly on the fourth Monday'],
            ['monthly-last', 'Monthly on the last Monday'],
            ['yearly', 'Annually on 26 October'],
            ['weekdays', 'Every weekday (Monday to Friday)'],
        ])
        expect(presets.find((preset) => preset.id === 'monthly-last')?.rule).toEqual({ freq: 'MONTHLY', interval: 1, byDay: ['-1MO'] })
        expect(presets.find((preset) => preset.id === 'monthly-nth')?.rule).toEqual({ freq: 'MONTHLY', interval: 1, byDay: ['4MO'] })
    })

    it('offers no last weekday for a date outside the last seven days of its month', () => {
        const presets = repeatPresets(new Date(2026, 9, 13))
        expect(presets.map((preset) => preset.label)).toEqual([
            'Does not repeat',
            'Daily',
            'Weekly on Tuesday',
            'Monthly on the second Tuesday',
            'Annually on 13 October',
            'Every weekday (Monday to Friday)',
        ])
    })

    it('offers only the last weekday for the fifth of its weekday in a month', () => {
        const ids = repeatPresets(new Date(2026, 9, 29)).map((preset) => preset.id)
        expect(ids).toContain('monthly-last')
        expect(ids).not.toContain('monthly-nth')
    })

    it('names the day and month in the given locale', () => {
        expect(repeatPresets(new Date(2026, 9, 12), 'en-US').find((preset) => preset.id === 'yearly')?.label).toBe('Annually on October 12')
    })

    it('writes the rules Google Calendar writes', () => {
        const lines = repeatPresets(new Date(2026, 9, 12)).map((preset) => (preset.rule ? formatRecurrence(preset.rule)[0] : null))
        expect(lines).toEqual([null, 'RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'RRULE:FREQ=MONTHLY;BYDAY=2MO', 'RRULE:FREQ=YEARLY', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'])
    })
})

describe('presetFor', () => {
    it('recognises every preset it offers, for every day of a year', () => {
        for (let day = 1; day <= 365; day++) {
            const start = new Date(2026, 0, day, 9)
            for (const preset of repeatPresets(start)) {
                expect(presetFor(preset.rule, start)).toBe(preset.id)
                if (preset.rule) expect(presetFor(parseRecurrence(formatRecurrence(preset.rule)).rule, start)).toBe(preset.id)
            }
        }
    })

    const monday = new Date(2026, 9, 12, 9)
    const read = (line: string): RepeatRule | null => parseRecurrence([line]).rule

    it('matches a choice Google writes in another way', () => {
        expect(presetFor(read('RRULE:FREQ=WEEKLY'), monday)).toBe('weekly')
        expect(presetFor(read('RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO'), monday)).toBe('weekly')
        expect(presetFor(read('RRULE:FREQ=WEEKLY;BYDAY=FR,TH,WE,TU,MO'), monday)).toBe('weekdays')
        expect(presetFor(read('RRULE:FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=12'), monday)).toBe('yearly')
    })

    it('calls anything else custom', () => {
        expect(presetFor(read('RRULE:FREQ=WEEKLY;BYDAY=TU'), monday)).toBe('custom')
        expect(presetFor(read('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'), monday)).toBe('custom')
        expect(presetFor(read('RRULE:FREQ=DAILY;COUNT=5'), monday)).toBe('custom')
        expect(presetFor(read('RRULE:FREQ=DAILY;UNTIL=20261201'), monday)).toBe('custom')
        expect(presetFor(read('RRULE:FREQ=MONTHLY'), monday)).toBe('custom')
        expect(presetFor(read('RRULE:FREQ=MONTHLY;BYDAY=-1MO'), monday)).toBe('custom')
        expect(presetFor(read('RRULE:FREQ=MONTHLY;BYDAY=3MO'), monday)).toBe('custom')
        expect(presetFor(read('RRULE:FREQ=YEARLY;BYMONTH=11'), monday)).toBe('custom')
        expect(presetFor(read('RRULE:FREQ=DAILY;BYSETPOS=1'), monday)).toBe('custom')
    })

    it('calls no rule Does not repeat', () => {
        expect(presetFor(null, monday)).toBe('none')
    })
})

describe('describeRule', () => {
    const monday = new Date(2026, 9, 12, 9)

    it('describes weekly rules', () => {
        expect(describeRule({ freq: 'WEEKLY', interval: 1 }, monday)).toBe('Weekly on Monday')
        expect(describeRule({ freq: 'WEEKLY', interval: 2, byDay: ['WE', 'MO'] }, monday)).toBe('Every 2 weeks on Monday and Wednesday')
        expect(describeRule({ freq: 'WEEKLY', interval: 1, byDay: ['SU', 'MO', 'SA'] }, monday)).toBe('Weekly on Monday, Saturday and Sunday')
        expect(describeRule({ freq: 'WEEKLY', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] }, monday)).toBe('Weekly on weekdays')
    })

    it('describes daily rules and their ends', () => {
        expect(describeRule({ freq: 'DAILY', interval: 1, until: '20261201' }, monday)).toBe('Daily, until 1 December 2026')
        expect(describeRule({ freq: 'DAILY', interval: 3, count: 1 }, monday)).toBe('Every 3 days, once')
        const ended = endSeriesBefore({ freq: 'DAILY', interval: 1 }, new Date(2026, 11, 2, 9), false)
        expect(describeRule(ended, monday)).toBe('Daily, until 2 December 2026')
    })

    it('describes monthly rules', () => {
        expect(describeRule({ freq: 'MONTHLY', interval: 1, count: 5 }, monday)).toBe('Monthly on day 12, 5 times')
        expect(describeRule({ freq: 'MONTHLY', interval: 1, byMonthDay: [1, 15] }, monday)).toBe('Monthly on days 1 and 15')
        expect(describeRule({ freq: 'MONTHLY', interval: 1, byMonthDay: [-1] }, monday)).toBe('Monthly on the last day')
        expect(describeRule({ freq: 'MONTHLY', interval: 1, byDay: ['2TU'] }, monday)).toBe('Monthly on the second Tuesday')
        expect(describeRule({ freq: 'MONTHLY', interval: 2, byDay: ['-1FR'] }, monday)).toBe('Every 2 months on the last Friday')
        expect(describeRule({ freq: 'MONTHLY', interval: 1, byDay: ['-2FR'] }, monday)).toBe('Monthly on the second to last Friday')
    })

    it('describes yearly rules', () => {
        expect(describeRule({ freq: 'YEARLY', interval: 1 }, monday)).toBe('Annually on 12 October')
        expect(describeRule({ freq: 'YEARLY', interval: 1, byMonth: [11], byDay: ['4TH'] }, monday)).toBe('Annually on the fourth Thursday of November')
        expect(describeRule({ freq: 'YEARLY', interval: 2, byMonth: [2], byMonthDay: [29] }, monday)).toBe('Every 2 years on 29 February')
        expect(describeRule({ freq: 'YEARLY', interval: 1 }, monday, 'en-US')).toBe('Annually on October 12')
    })

    it('describes an unsupported rule as set in Google Calendar', () => {
        const { rule } = parseRecurrence(['RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'])
        expect(describeRule(rule as RepeatRule, monday)).toBe('Custom rule set in Google Calendar')
    })
})

describe('endSeriesBefore', () => {
    it('ends a timed series one second before the occurrence, in UTC, and drops COUNT', () => {
        const occurrence = new Date(2026, 9, 26, 9, 0)
        const ended = endSeriesBefore({ freq: 'WEEKLY', interval: 1, byDay: ['MO'], count: 10 }, occurrence, false)
        expect(ended).toEqual({ freq: 'WEEKLY', interval: 1, byDay: ['MO'], until: utcStamp(new Date(occurrence.getTime() - 1000)) })
        expect(ended.until).toMatch(/^\d{8}T\d{6}Z$/)
    })

    it('writes the UTC time Google needs', () => {
        const ended = endSeriesBefore({ freq: 'DAILY', interval: 1 }, new Date(Date.UTC(2026, 9, 26, 9, 0)), false)
        expect(formatRecurrence(ended)).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261026T085959Z'])
    })

    it('ends an all-day series on the day before, as a date', () => {
        expect(endSeriesBefore({ freq: 'DAILY', interval: 1, until: '20271231' }, new Date(2026, 9, 26), true).until).toBe('20261025')
        expect(endSeriesBefore({ freq: 'MONTHLY', interval: 1 }, new Date(2026, 10, 1), true).until).toBe('20261031')
        expect(endSeriesBefore({ freq: 'YEARLY', interval: 1 }, new Date(2027, 0, 1), true).until).toBe('20261231')
    })

    it('does not change the rule it is given', () => {
        const rule: RepeatRule = { freq: 'DAILY', interval: 1, count: 4 }
        endSeriesBefore(rule, new Date(2026, 9, 26), true)
        expect(rule).toEqual({ freq: 'DAILY', interval: 1, count: 4 })
    })

    it('ends an unsupported rule by rewriting its line', () => {
        const { rule } = parseRecurrence(['RRULE:FREQ=MONTHLY;COUNT=12;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'])
        const ended = endSeriesBefore(rule as RepeatRule, new Date(2026, 9, 26), true)
        expect(formatRecurrence(ended)).toEqual(['RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;UNTIL=20261025'])
        const { rule: dated } = parseRecurrence(['RRULE:FREQ=MONTHLY;UNTIL=20271231;BYSETPOS=-1;BYDAY=FR'])
        expect(formatRecurrence(endSeriesBefore(dated as RepeatRule, new Date(2026, 9, 26), true))).toEqual(['RRULE:FREQ=MONTHLY;UNTIL=20261025;BYSETPOS=-1;BYDAY=FR'])
    })
})

describe('continueSeriesFrom', () => {
    it('keeps the times not yet used', () => {
        expect(continueSeriesFrom({ freq: 'DAILY', interval: 1, count: 10 }, 4)).toEqual({ freq: 'DAILY', interval: 1, count: 6 })
    })

    it('keeps at least one time', () => {
        expect(continueSeriesFrom({ freq: 'DAILY', interval: 1, count: 10 }, 12).count).toBe(1)
        expect(continueSeriesFrom({ freq: 'DAILY', interval: 1, count: 10 }, 10).count).toBe(1)
    })

    it('leaves a rule that ends on a date, or never, unchanged', () => {
        expect(continueSeriesFrom({ freq: 'WEEKLY', interval: 1, until: '20261201' }, 4)).toEqual({ freq: 'WEEKLY', interval: 1, until: '20261201' })
        expect(continueSeriesFrom({ freq: 'WEEKLY', interval: 1 }, 4)).toEqual({ freq: 'WEEKLY', interval: 1 })
    })

    it('rewrites the count in an unsupported rule', () => {
        const { rule } = parseRecurrence(['RRULE:FREQ=MONTHLY;COUNT=12;BYSETPOS=-1;BYDAY=FR'])
        expect(formatRecurrence(continueSeriesFrom(rule as RepeatRule, 5))).toEqual(['RRULE:FREQ=MONTHLY;COUNT=7;BYSETPOS=-1;BYDAY=FR'])
    })
})

describe('splitExceptions', () => {
    // 09:00 in London on Monday 12 October 2026, which is 08:00 UTC.
    const at = new Date(Date.UTC(2026, 9, 12, 8, 0))

    it('splits a list of zoned times at the occurrence, the occurrence itself going forward', () => {
        const split = splitExceptions(['EXDATE;TZID=Europe/London:20261005T090000,20261012T090000,20261019T090000'], at)
        expect(split).toEqual({
            before: ['EXDATE;TZID=Europe/London:20261005T090000'],
            after: ['EXDATE;TZID=Europe/London:20261012T090000,20261019T090000'],
        })
    })

    it('reads a zoned time in its own zone', () => {
        // 04:00 in New York is 08:00 UTC in October.
        expect(splitExceptions(['EXDATE;TZID=America/New_York:20261012T035959'], at)).toEqual({ before: ['EXDATE;TZID=America/New_York:20261012T035959'], after: [] })
        expect(splitExceptions(['EXDATE;TZID=America/New_York:20261012T040000'], at)).toEqual({ before: [], after: ['EXDATE;TZID=America/New_York:20261012T040000'] })
        expect(splitExceptions(['EXDATE;TZID="Europe/London":20261012T085959'], at).before).toHaveLength(1)
    })

    it('reads a zoned time after the zone changes its clocks', () => {
        // 09:00 in London on 26 October 2026 is 09:00 UTC, the clocks having gone back.
        const after = new Date(Date.UTC(2026, 9, 26, 9, 0))
        expect(splitExceptions(['EXDATE;TZID=Europe/London:20261026T090000'], after).after).toHaveLength(1)
        expect(splitExceptions(['EXDATE;TZID=Europe/London:20261026T090000'], new Date(after.getTime() + 1000)).before).toHaveLength(1)
    })

    it('splits dates at the local day of an all-day occurrence', () => {
        const split = splitExceptions(['EXDATE;VALUE=DATE:20261010,20261012,20261014', 'RDATE;VALUE=DATE:20261001'], new Date(2026, 9, 12))
        expect(split).toEqual({
            before: ['EXDATE;VALUE=DATE:20261010', 'RDATE;VALUE=DATE:20261001'],
            after: ['EXDATE;VALUE=DATE:20261012,20261014'],
        })
    })

    it('reads UTC and local times', () => {
        expect(splitExceptions(['EXDATE:20261012T075959Z,20261012T080000Z'], at)).toEqual({ before: ['EXDATE:20261012T075959Z'], after: ['EXDATE:20261012T080000Z'] })
        expect(splitExceptions(['EXDATE:20261012T090000'], new Date(2026, 9, 12, 9)).after).toEqual(['EXDATE:20261012T090000'])
    })

    it('reads a period by its start', () => {
        expect(splitExceptions(['RDATE;VALUE=PERIOD:20261020T090000Z/20261020T100000Z'], at).after).toEqual(['RDATE;VALUE=PERIOD:20261020T090000Z/20261020T100000Z'])
    })

    it('keeps a value it cannot read with the old series', () => {
        expect(splitExceptions(['EXDATE;TZID=Garden/Shed:20261019T090000', 'EXDATE:soon'], at)).toEqual({ before: ['EXDATE;TZID=Garden/Shed:20261019T090000', 'EXDATE:soon'], after: [] })
    })

    it('gives a pattern line to both series', () => {
        expect(splitExceptions(['EXRULE:FREQ=MONTHLY;BYDAY=1MO'], at)).toEqual({ before: ['EXRULE:FREQ=MONTHLY;BYDAY=1MO'], after: ['EXRULE:FREQ=MONTHLY;BYDAY=1MO'] })
    })
})
