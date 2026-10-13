<script lang="ts">
    /**
     * An event's description, edited with its formatting, as Google Calendar's own editor does: bold,
     * italic, underline, bulleted and numbered lists, links, and removing formatting.
     *
     * The text is drawn into the field with DOM calls (`renderDescription`), never as an HTML string,
     * since the Client enforces Trusted Types. The buttons use the browser's editing commands, and
     * whatever the field holds when the event is saved is read back through the same short list of
     * allowed elements (`nodesFromEditable`), so pasted formatting Google does not keep is left out.
     */
    import { renderDescription, type DescriptionNode } from '../model/description'

    let { initial, root = $bindable(), oninput }: { initial: DescriptionNode[]; root?: HTMLElement; oninput: () => void } = $props()

    let linkOpen = $state(false)
    let linkValue = $state('')
    let linkError = $state<string | null>(null)
    /** Where the caret was when Link was pressed, to put the link there. */
    let saved: Range | null = null

    function command(name: string, value?: string) {
        root?.focus()
        document.execCommand(name, false, value)
        oninput()
    }

    function selection(): Selection | null {
        const node = root?.getRootNode() as (ShadowRoot & { getSelection?: () => Selection | null }) | Document | undefined
        return (node && 'getSelection' in node && typeof node.getSelection === 'function' ? node.getSelection() : null) ?? document.getSelection()
    }

    function startLink() {
        const current = selection()
        saved = current && current.rangeCount > 0 ? current.getRangeAt(0).cloneRange() : null
        linkValue = 'https://'
        linkError = null
        linkOpen = true
    }

    function addLink() {
        const value = linkValue.trim()
        if (!/^(https?:\/\/|mailto:)\S+$/i.test(value)) {
            linkError = 'Enter a web address starting https://, or a mailto: address.'
            return
        }
        root?.focus()
        if (saved) {
            const current = selection()
            current?.removeAllRanges()
            current?.addRange(saved)
        }
        // With nothing selected, the address itself becomes the link's text.
        if (!saved || saved.collapsed) document.execCommand('insertText', false, value)
        if (saved && !saved.collapsed) document.execCommand('createLink', false, value)
        linkOpen = false
        oninput()
    }
</script>

<div class="gc-rich">
    <div class="gc-rich__bar" role="toolbar" aria-label="Formatting">
        <button type="button" class="gc-icon-button" aria-label="Bold" title="Bold" onmousedown={(event) => event.preventDefault()} onclick={() => command('bold')}><b>B</b></button>
        <button type="button" class="gc-icon-button" aria-label="Italic" title="Italic" onmousedown={(event) => event.preventDefault()} onclick={() => command('italic')}><i>I</i></button>
        <button type="button" class="gc-icon-button" aria-label="Underline" title="Underline" onmousedown={(event) => event.preventDefault()} onclick={() => command('underline')}><u>U</u></button>
        <button type="button" class="gc-icon-button" aria-label="Bulleted list" title="Bulleted list" onmousedown={(event) => event.preventDefault()} onclick={() => command('insertUnorderedList')}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 4h8M6 8h8M6 12h8" /><circle cx="2.5" cy="4" r=".75" /><circle cx="2.5" cy="8" r=".75" /><circle cx="2.5" cy="12" r=".75" /></svg>
        </button>
        <button type="button" class="gc-icon-button" aria-label="Numbered list" title="Numbered list" onmousedown={(event) => event.preventDefault()} onclick={() => command('insertOrderedList')}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 4h8M6 8h8M6 12h8M2 3l1-.5V5.5M1.75 10h1.5L1.75 12.5h1.75" /></svg>
        </button>
        <button type="button" class="gc-icon-button" aria-label="Link" title="Link" onmousedown={(event) => event.preventDefault()} onclick={startLink}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" /></svg>
        </button>
        <button type="button" class="gc-icon-button" aria-label="Remove formatting" title="Remove formatting" onmousedown={(event) => event.preventDefault()} onclick={() => command('removeFormat')}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 3h8M8 3l-2 10M3 13l10-10" /></svg>
        </button>
    </div>
    {#if linkOpen}
        <div class="gc-rich__link">
            <input
                class="gc-input"
                aria-label="Link address"
                bind:value={linkValue}
                aria-invalid={linkError !== null}
                {@attach (element) => element.focus()}
                onkeydown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault()
                        addLink()
                    } else if (event.key === 'Escape') {
                        event.stopPropagation()
                        linkOpen = false
                    }
                }}
            />
            <button type="button" class="gc-button" onclick={addLink}>Add link</button>
            <button type="button" class="gc-button" onclick={() => (linkOpen = false)}>Cancel</button>
            {#if linkError}<span class="gc-error">{linkError}</span>{/if}
        </div>
    {/if}
    <div
        class="gc-rich__field"
        contenteditable="true"
        role="textbox"
        aria-multiline="true"
        aria-label="Description"
        tabindex="0"
        data-testid="gc-editor-description"
        bind:this={root}
        {oninput}
        {@attach (element) => element.replaceChildren(renderDescription(initial, element.ownerDocument))}
    ></div>
</div>

<style>
    .gc-rich {
        border: 1px solid var(--gk-border-strong);
        border-radius: 0.5rem;
        background: var(--gk-surface-0);
    }
    .gc-rich:focus-within {
        outline: 2px solid var(--gk-accent);
        outline-offset: 1px;
    }
    .gc-rich__bar {
        display: flex;
        flex-wrap: wrap;
        gap: 0.125rem;
        padding: 0.25rem;
        border-bottom: 1px solid var(--gk-border-soft);
    }
    .gc-rich__link {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem;
        border-bottom: 1px solid var(--gk-border-soft);
    }
    .gc-rich__field {
        min-height: 6rem;
        max-height: 16rem;
        overflow: auto;
        padding: 0.5rem 0.625rem;
        font-size: 0.875rem;
        line-height: 1.5;
        outline: none;
    }
    .gc-rich__field :global(ul),
    .gc-rich__field :global(ol) {
        padding-left: 1.25rem;
    }
    .gc-rich__field :global(a) {
        color: var(--gk-accent);
    }
</style>
