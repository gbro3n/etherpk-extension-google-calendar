/**
 * An address from an event, made safe to put in a link: kept only when it is a web, phone or mail
 * address. Events come from other people too (an invitation carries the organiser's attachments
 * and conference details), so an address in one is never trusted to be something a link may open.
 */
const ALLOWED = new Set(['https:', 'http:', 'tel:', 'mailto:'])

export function safeUrl(address: string | undefined): string | undefined {
    if (!address) return undefined
    try {
        return ALLOWED.has(new URL(address).protocol) ? address : undefined
    } catch {
        return undefined
    }
}
