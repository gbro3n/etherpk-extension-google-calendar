/**
 * A Svelte component as an extension View or Journal Panel: the `mount(element, props)` both
 * follow. This bundle carries its own Svelte, compiled with it, so it carries its own copy of this
 * rather than borrowing the Client's.
 *
 * A View's props live in one reactive object the component is mounted with, so an `update` (a move
 * to another Pane) reaches the component as an ordinary prop change rather than a remount. A Journal
 * Panel's props are fixed for its life.
 */
import type { JournalPanel, JournalPanelProps, MountedJournalPanel, MountedView, ViewContribution, ViewMountProps } from '@appsoftwareltd/etherpk-extension-api'
import { type Component, mount, unmount } from 'svelte'

export function svelteView<Extra extends object>(component: Component<ViewMountProps & Extra>, extra: Extra): ViewContribution {
    return {
        mount(element: HTMLElement, initial: ViewMountProps): MountedView {
            const props = $state({ ...initial, ...extra })
            const instance = mount(component, { target: element, props })
            return {
                update(next) {
                    Object.assign(props, next)
                },
                destroy() {
                    void unmount(instance)
                },
            }
        },
    }
}

export function sveltePanel<Extra extends object>(id: string, component: Component<JournalPanelProps & Extra>, extra: Extra): JournalPanel {
    return {
        id,
        mount(element: HTMLElement, initial: JournalPanelProps): MountedJournalPanel {
            const instance = mount(component, { target: element, props: { ...initial, ...extra } })
            return {
                destroy() {
                    void unmount(instance)
                },
            }
        },
    }
}
