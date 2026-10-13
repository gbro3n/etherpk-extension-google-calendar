<script lang="ts">
    /**
     * A custom repeat rule, as Google Calendar's Custom recurrence dialog sets one: every so many
     * days, weeks, months or years; for weeks, on which days; for months, on the date or on the nth
     * weekday; and ending never, on a date, or after so many times.
     */
    import type { RepeatRule } from '../model/recurrence'

    let { rule = $bindable(), start }: { rule: RepeatRule; start: Date } = $props()

    const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
    const dayName = (index: number) => new Date(2026, 0, 4 + index).toLocaleDateString(undefined, { weekday: 'short' })
    const nth = $derived(Math.ceil(start.getDate() / 7))
    const ordinal = ['first', 'second', 'third', 'fourth', 'fifth']

    const ends = $derived(rule.until ? 'on' : rule.count !== undefined ? 'after' : 'never')
    const untilDay = $derived(rule.until ? `${rule.until.slice(0, 4)}-${rule.until.slice(4, 6)}-${rule.until.slice(6, 8)}` : '')

    function set(change: Partial<RepeatRule>) {
        rule = { ...rule, ...change }
    }

    function setFreq(freq: RepeatRule['freq']) {
        const next: RepeatRule = { freq, interval: rule.interval, ...(rule.count !== undefined ? { count: rule.count } : {}), ...(rule.until ? { until: rule.until } : {}) }
        if (freq === 'WEEKLY') next.byDay = [DAYS[start.getDay()]]
        rule = next
    }

    function toggleDay(day: string, on: boolean) {
        const days = new Set(rule.byDay ?? [])
        if (on) days.add(day)
        else days.delete(day)
        // A weekly rule always repeats on at least the day it starts on.
        set({ byDay: days.size > 0 ? DAYS.filter((candidate) => days.has(candidate)) : [DAYS[start.getDay()]] })
    }

    function setEnds(value: string) {
        const { count: _count, until: _until, ...rest } = rule
        if (value === 'after') rule = { ...rest, count: 10 }
        else if (value === 'on') {
            const later = new Date(start.getFullYear(), start.getMonth() + 3, start.getDate())
            rule = { ...rest, until: `${later.getFullYear()}${String(later.getMonth() + 1).padStart(2, '0')}${String(later.getDate()).padStart(2, '0')}` }
        } else rule = rest
    }
</script>

<div class="gc-repeat" data-testid="gc-repeat-editor">
    <label class="gc-repeat__row">
        <span>Every</span>
        <input class="gc-input gc-repeat__number" type="number" min="1" max="999" value={rule.interval} oninput={(event) => set({ interval: Math.max(1, Number(event.currentTarget.value) || 1) })} />
        <select class="gc-select" aria-label="Unit" value={rule.freq} onchange={(event) => setFreq(event.currentTarget.value as RepeatRule['freq'])}>
            <option value="DAILY">{rule.interval === 1 ? 'day' : 'days'}</option>
            <option value="WEEKLY">{rule.interval === 1 ? 'week' : 'weeks'}</option>
            <option value="MONTHLY">{rule.interval === 1 ? 'month' : 'months'}</option>
            <option value="YEARLY">{rule.interval === 1 ? 'year' : 'years'}</option>
        </select>
    </label>

    {#if rule.freq === 'WEEKLY'}
        <fieldset class="gc-repeat__days">
            <legend>On</legend>
            {#each DAYS as day, index (day)}
                <label class="gc-repeat__day">
                    <input type="checkbox" checked={rule.byDay?.includes(day) ?? false} onchange={(event) => toggleDay(day, event.currentTarget.checked)} />
                    {dayName(index)}
                </label>
            {/each}
        </fieldset>
    {:else if rule.freq === 'MONTHLY'}
        <select
            class="gc-select"
            aria-label="On"
            value={rule.byDay ? 'weekday' : 'date'}
            onchange={(event) => {
                const { byDay: _byDay, byMonthDay: _byMonthDay, ...rest } = rule
                rule = event.currentTarget.value === 'weekday' ? { ...rest, byDay: [`${nth}${DAYS[start.getDay()]}`] } : { ...rest, byMonthDay: [start.getDate()] }
            }}
        >
            <option value="date">Monthly on day {start.getDate()}</option>
            <option value="weekday">Monthly on the {ordinal[nth - 1]} {start.toLocaleDateString(undefined, { weekday: 'long' })}</option>
        </select>
    {/if}

    <fieldset class="gc-repeat__ends">
        <legend>Ends</legend>
        <label><input type="radio" name="gc-ends" value="never" checked={ends === 'never'} onchange={() => setEnds('never')} /> Never</label>
        <label class="gc-repeat__row">
            <input type="radio" name="gc-ends" value="on" checked={ends === 'on'} onchange={() => setEnds('on')} /> On
            <input
                class="gc-input"
                type="date"
                aria-label="End date"
                disabled={ends !== 'on'}
                value={untilDay}
                onchange={(event) => event.currentTarget.value && set({ until: event.currentTarget.value.replaceAll('-', '') })}
            />
        </label>
        <label class="gc-repeat__row">
            <input type="radio" name="gc-ends" value="after" checked={ends === 'after'} onchange={() => setEnds('after')} /> After
            <input
                class="gc-input gc-repeat__number"
                type="number"
                min="1"
                max="730"
                aria-label="Occurrences"
                disabled={ends !== 'after'}
                value={rule.count ?? 10}
                oninput={(event) => set({ count: Math.min(730, Math.max(1, Number(event.currentTarget.value) || 1)) })}
            />
            times
        </label>
    </fieldset>
</div>

<style>
    .gc-repeat {
        display: grid;
        gap: 0.75rem;
        padding: 0.75rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.5rem;
        background: var(--gk-surface-1);
    }
    .gc-repeat__row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
    }
    .gc-repeat__number {
        width: 5rem;
    }
    .gc-repeat__days,
    .gc-repeat__ends {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 0.75rem;
        margin: 0;
        padding: 0;
        border: 0;
    }
    .gc-repeat__ends {
        flex-direction: column;
    }
    .gc-repeat legend {
        padding: 0;
        margin-bottom: 0.25rem;
        font-weight: 600;
    }
    .gc-repeat__day {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
    }
</style>
