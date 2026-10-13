/**
 * A pop-up shown in the page's top layer through the Popover API, so the Pane or panel it belongs
 * to can never clip it, whatever their overflow, transform or containment. EtherPK's panes clip what
 * overflows them, which hid an event's details drawn beside an event near the Pane's edge.
 *
 * `auto` pop-ups close on Escape and on a click outside them, as the browser does for any
 * `popover="auto"`, and say so through `onclose`. `manual` ones close only when their owner takes
 * them away. Focus goes to the element marked `data-autofocus` inside, if there is one.
 */
import type { Attachment } from 'svelte/attachments'

export function popover(onclose: () => void, mode: 'auto' | 'manual' = 'auto'): Attachment<HTMLElement> {
    return (element) => {
        element.setAttribute('popover', mode)
        element.showPopover()
        const toggled = (event: Event) => {
            if ((event as ToggleEvent).newState === 'closed') onclose()
        }
        element.addEventListener('toggle', toggled)
        element.querySelector<HTMLElement>('[data-autofocus]')?.focus()
        return () => {
            element.removeEventListener('toggle', toggled)
            if (element.matches(':popover-open')) element.hidePopover()
        }
    }
}
