/**
 * Event descriptions. Google Calendar's editor writes a little HTML (`b`, `i`, `u`, `br`, lists and
 * links, and sometimes `span`, `div` or `p`). Other clients write plain text with newlines.
 *
 * The page enforces Trusted Types, so a description is never handed to `innerHTML`, `DOMParser` or
 * `createContextualFragment`. It is read by the tolerant tokenizer below into a small tree of the
 * few things a description can hold, and that tree is built into DOM with `createElement` and
 * `createTextNode` only. Anything else the source holds is unwrapped to its text or dropped, so
 * nothing in a description can run or reach outside its own links.
 */

export type DescriptionTag = 'b' | 'i' | 'u' | 'ul' | 'ol' | 'li' | 'p' | 'a'

export type DescriptionNode =
    | { kind: 'text'; text: string }
    | { kind: 'break' }
    | { kind: 'element'; tag: DescriptionTag; href?: string; children: DescriptionNode[] }

type ElementNode = Extract<DescriptionNode, { kind: 'element' }>
type TextNode = Extract<DescriptionNode, { kind: 'text' }>

/** What a source tag becomes: one of the description's elements, a line break, its content alone, or nothing. */
type TagRole = { kind: 'element'; tag: DescriptionTag } | { kind: 'break' } | { kind: 'unwrap' } | { kind: 'drop' }

/**
 * Source tags kept as one of the description's elements. Block elements that a browser puts on a
 * line of their own (`div`, headings, quotes, table rows) read as paragraphs, so their lines stay
 * apart rather than running together.
 */
const ELEMENT_TAGS: Record<string, DescriptionTag> = {
    b: 'b',
    strong: 'b',
    i: 'i',
    em: 'i',
    u: 'u',
    ul: 'ul',
    ol: 'ol',
    li: 'li',
    a: 'a',
    p: 'p',
    div: 'p',
    h1: 'p',
    h2: 'p',
    h3: 'p',
    h4: 'p',
    h5: 'p',
    h6: 'p',
    blockquote: 'p',
    pre: 'p',
    section: 'p',
    article: 'p',
    header: 'p',
    footer: 'p',
    main: 'p',
    aside: 'p',
    nav: 'p',
    address: 'p',
    figure: 'p',
    figcaption: 'p',
    table: 'p',
    tr: 'p',
    dl: 'p',
    dt: 'p',
    dd: 'p',
    center: 'p',
}

/** Tags that end a line. A horizontal rule has no content to keep, so it reads as a line end. */
const BREAK_TAGS = new Set(['br', 'hr'])

/** Tags whose content is not part of what a reader sees, and is dropped with them. */
const DROPPED_TAGS = new Set(['script', 'style', 'head', 'title', 'template', 'noscript', 'iframe', 'object'])

/** Further tags that mark a source as HTML rather than plain text, though they are unwrapped. */
const OTHER_HTML_TAGS = ['span', 'font', 'html', 'body', 'img', 'td', 'th', 'tbody', 'thead', 'tfoot', 'sup', 'sub', 's', 'strike', 'del', 'ins', 'small', 'big', 'code', 'mark', 'meta', 'link', 'wbr', 'tt', 'label', 'caption']

const KNOWN_TAGS = new Set([...Object.keys(ELEMENT_TAGS), ...BREAK_TAGS, ...DROPPED_TAGS, ...OTHER_HTML_TAGS])

/** Bold, italic and underline, which a browser carries on past a misnested end tag. */
const FORMATTING_TAGS = new Set<DescriptionTag>(['b', 'i', 'u'])

/** The elements that start and end lines of their own. */
const BLOCK_TAGS = new Set<DescriptionTag>(['p', 'ul', 'ol', 'li'])

function roleOf(name: string): TagRole {
    const tag = ELEMENT_TAGS[name]
    if (tag) return { kind: 'element', tag }
    if (BREAK_TAGS.has(name)) return { kind: 'break' }
    if (DROPPED_TAGS.has(name)) return { kind: 'drop' }
    return { kind: 'unwrap' }
}

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    AMP: '&',
    lt: '<',
    LT: '<',
    gt: '>',
    GT: '>',
    quot: '"',
    QUOT: '"',
    apos: "'",
    nbsp: '\u00a0',
    copy: '\u00a9',
    reg: '\u00ae',
    trade: '\u2122',
    hellip: '\u2026',
    ndash: '\u2013',
    mdash: '\u2014',
    lsquo: '\u2018',
    rsquo: '\u2019',
    ldquo: '\u201c',
    rdquo: '\u201d',
    bull: '\u2022',
    middot: '\u00b7',
    laquo: '\u00ab',
    raquo: '\u00bb',
    euro: '\u20ac',
    pound: '\u00a3',
    deg: '\u00b0',
    times: '\u00d7',
}

/** A numeric character reference's character. Zero, surrogates and values past Unicode become U+FFFD, as in HTML. */
function codePointText(code: number): string {
    if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd'
    return String.fromCodePoint(code)
}

/** Decodes character references that end in a semicolon. An unknown name is left as it was written. */
function decodeEntities(text: string): string {
    if (!text.includes('&')) return text
    return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
        if (body[0] !== '#') return NAMED_ENTITIES[body] ?? whole
        const hex = body[1] === 'x' || body[1] === 'X'
        return codePointText(hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10))
    })
}

function escapeText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;')
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A link target that is safe to follow: web and email addresses only. Browsers ignore tabs and line
 * breaks inside a URL and spaces and control characters around it, so those are removed before the
 * scheme is checked. Anything else (`javascript:`, `data:`, a relative path) gives null.
 */
function safeHref(raw: string | null | undefined): string | null {
    if (!raw) return null
    const href = raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
    return /^(https?|mailto):/i.test(href) ? href : null
}

type Token =
    | { type: 'text'; text: string }
    | { type: 'open'; name: string; attributes: Map<string, string>; selfClosing: boolean }
    | { type: 'close'; name: string }

interface ReadTag {
    name: string
    attributes: Map<string, string>
    selfClosing: boolean
    /** The index just past the tag's `>`. */
    end: number
}

/**
 * Reads a tag's name and attributes from just after its `<` (or `</`). Gives null when the tag never
 * closes, so the `<` can be read as text instead.
 */
function readTag(source: string, start: number): ReadTag | null {
    let index = start
    while (index < source.length && !/[\s/>]/.test(source[index])) index++
    const name = source.slice(start, index).toLowerCase()
    const attributes = new Map<string, string>()
    let selfClosing = false
    while (index < source.length) {
        const char = source[index]
        if (char === '>') return { name, attributes, selfClosing, end: index + 1 }
        if (/\s/.test(char)) {
            index++
            continue
        }
        if (char === '/') {
            selfClosing = true
            index++
            continue
        }
        selfClosing = false
        const nameStart = index
        while (index < source.length && !/[\s/>=]/.test(source[index])) index++
        const attributeName = source.slice(nameStart, index).toLowerCase()
        while (index < source.length && /\s/.test(source[index])) index++
        let value = ''
        if (source[index] === '=') {
            index++
            while (index < source.length && /\s/.test(source[index])) index++
            const quote = source[index]
            if (quote === '"' || quote === "'") {
                const close = source.indexOf(quote, index + 1)
                if (close < 0) return null
                value = source.slice(index + 1, close)
                index = close + 1
            } else {
                const valueStart = index
                while (index < source.length && !/[\s>]/.test(source[index])) index++
                value = source.slice(valueStart, index)
            }
        }
        if (attributeName !== '' && !attributes.has(attributeName)) attributes.set(attributeName, decodeEntities(value))
    }
    return null
}

/**
 * Where the content of a dropped element ends: just past its end tag, or the end of the source when
 * it has none, as a browser reads an unclosed `<script>`. A `<head>` also ends where `<body>` starts,
 * since HTML lets a document leave `</head>` out.
 */
function skipDropped(source: string, lower: string, name: string, from: number): number {
    const close = lower.indexOf(`</${name}`, from)
    const body = name === 'head' ? lower.indexOf('<body', from) : -1
    if (body >= 0 && (close < 0 || body < close)) return body
    if (close < 0) return source.length
    const end = source.indexOf('>', close)
    return end < 0 ? source.length : end + 1
}

/** Splits HTML into text, start tags and end tags. Comments, doctypes and dropped elements leave nothing. */
function tokenize(source: string): Token[] {
    const tokens: Token[] = []
    let lower: string | null = null
    let index = 0
    let textStart = 0
    const flushText = (end: number): void => {
        if (end > textStart) tokens.push({ type: 'text', text: decodeEntities(source.slice(textStart, end)) })
    }
    while (index < source.length) {
        const open = source.indexOf('<', index)
        if (open < 0) break
        if (source.startsWith('<!--', open)) {
            flushText(open)
            const end = source.indexOf('-->', open + 4)
            index = textStart = end < 0 ? source.length : end + 3
            continue
        }
        const next = source[open + 1] ?? ''
        if (next === '!' || next === '?') {
            flushText(open)
            const end = source.indexOf('>', open)
            index = textStart = end < 0 ? source.length : end + 1
            continue
        }
        const closing = next === '/'
        const nameStart = closing ? open + 2 : open + 1
        const tag = /[a-zA-Z]/.test(source[nameStart] ?? '') ? readTag(source, nameStart) : null
        if (!tag) {
            // A `<` that starts no tag, as in `a < b`, is text.
            index = open + 1
            continue
        }
        flushText(open)
        index = textStart = tag.end
        if (closing) {
            tokens.push({ type: 'close', name: tag.name })
        } else if (DROPPED_TAGS.has(tag.name)) {
            if (!tag.selfClosing) {
                lower ??= source.toLowerCase()
                index = textStart = skipDropped(source, lower, tag.name, tag.end)
            }
        } else {
            tokens.push({ type: 'open', name: tag.name, attributes: tag.attributes, selfClosing: tag.selfClosing })
        }
    }
    flushText(source.length)
    return tokens
}

interface OpenElement {
    node: ElementNode
    /** The tag as written, which tells a `<p>` from a `<div>` for the implied end of a paragraph. */
    source: string
}

/**
 * Builds the tree from tokens, tolerating what browsers tolerate: an end tag with nothing to close is
 * ignored, an element left open closes at the end, a new list item closes the last one, a block
 * closes an open `<p>`, a link closes an open link, and bold, italic or underline closed out of
 * order carries on after the element that closed it.
 */
function buildTree(tokens: readonly Token[]): DescriptionNode[] {
    const root: DescriptionNode[] = []
    const stack: OpenElement[] = []
    const current = (): DescriptionNode[] => (stack.length > 0 ? stack[stack.length - 1].node.children : root)

    /** The innermost open element with a tag, looking no further out than an element that `stopAt` names. */
    const findOpen = (tag: DescriptionTag, stopAt: ReadonlySet<DescriptionTag>): number => {
        for (let index = stack.length - 1; index >= 0; index--) {
            const open = stack[index].node.tag
            if (open === tag) return index
            if (stopAt.has(open)) return -1
        }
        return -1
    }

    const close = (index: number): void => {
        const closed = stack.splice(index)
        if (!FORMATTING_TAGS.has(closed[0].node.tag)) return
        for (const inner of closed.slice(1)) {
            if (!FORMATTING_TAGS.has(inner.node.tag)) continue
            const reopened: ElementNode = { kind: 'element', tag: inner.node.tag, children: [] }
            current().push(reopened)
            stack.push({ node: reopened, source: inner.source })
        }
    }

    const NOTHING = new Set<DescriptionTag>()
    const LISTS = new Set<DescriptionTag>(['ul', 'ol'])

    for (const token of tokens) {
        if (token.type === 'text') {
            current().push({ kind: 'text', text: token.text })
            continue
        }
        const role = roleOf(token.name)
        if (token.type === 'close') {
            // Browsers read a stray `</br>` as a line break.
            if (token.name === 'br') current().push({ kind: 'break' })
            if (role.kind !== 'element') continue
            const { tag } = role
            // Inline formatting does not close across a block, and a list item not across a list.
            const stopAt = FORMATTING_TAGS.has(tag) || tag === 'a' ? BLOCK_TAGS : tag === 'li' ? LISTS : NOTHING
            const index = findOpen(tag, stopAt)
            if (index >= 0) close(index)
            continue
        }
        if (role.kind === 'break') {
            current().push({ kind: 'break' })
            continue
        }
        if (role.kind !== 'element') continue
        const { tag } = role
        let href: string | null = null
        if (tag === 'a') {
            const open = findOpen('a', NOTHING)
            if (open >= 0) close(open)
            href = safeHref(token.attributes.get('href'))
            // A link to anything but the web or email keeps its text and loses the link.
            if (href === null) continue
        }
        if (tag === 'li') {
            const open = findOpen('li', LISTS)
            if (open >= 0) close(open)
        }
        if (BLOCK_TAGS.has(tag)) {
            // A block starts a new line, so it ends a `<p>` left open around it.
            for (let index = stack.length - 1; index >= 0; index--) {
                if (FORMATTING_TAGS.has(stack[index].node.tag) || stack[index].node.tag === 'a') continue
                if (stack[index].source === 'p') stack.splice(index)
                break
            }
        }
        const node: ElementNode = href === null ? { kind: 'element', tag, children: [] } : { kind: 'element', tag, href, children: [] }
        current().push(node)
        if (!token.selfClosing) stack.push({ node, source: token.name })
    }
    return root
}

interface WhitespaceState {
    /** Nothing has been written on the current line yet. */
    atLineStart: boolean
    /** The last text written on the current line, whose trailing space a line end removes. */
    last: TextNode | null
}

function endLine(state: WhitespaceState): void {
    if (state.last?.text.endsWith(' ')) state.last.text = state.last.text.slice(0, -1)
    state.last = null
    state.atLineStart = true
}

/**
 * Collapses whitespace as a browser lays out HTML text: each run of spaces, tabs and newlines becomes
 * one space, and a space at the start or end of a line, or after another space, goes. A no-break
 * space is kept. The text nodes are copies, so the tree given is not changed.
 */
function collapseWhitespace(nodes: readonly DescriptionNode[], state: WhitespaceState): DescriptionNode[] {
    const result: DescriptionNode[] = []
    for (const node of nodes) {
        if (node.kind === 'text') {
            let text = node.text.replace(/[ \t\n\r\f]+/g, ' ')
            if (text.startsWith(' ') && (state.atLineStart || state.last?.text.endsWith(' '))) text = text.slice(1)
            if (text === '') continue
            const copy: TextNode = { kind: 'text', text }
            result.push(copy)
            state.atLineStart = false
            state.last = copy
        } else if (node.kind === 'break') {
            endLine(state)
            result.push(node)
        } else if (BLOCK_TAGS.has(node.tag)) {
            endLine(state)
            const children = collapseWhitespace(node.children, state)
            endLine(state)
            result.push({ ...node, children })
        } else {
            result.push({ ...node, children: collapseWhitespace(node.children, state) })
        }
    }
    return result
}

/**
 * Drops what shows nothing (empty text, and formatting, links, paragraphs and lists left empty) and
 * joins neighbouring text, so equal descriptions always build equal trees. A list item stays even
 * when empty, since it still shows its bullet.
 */
function tidy(nodes: readonly DescriptionNode[]): DescriptionNode[] {
    const result: DescriptionNode[] = []
    for (const node of nodes) {
        if (node.kind === 'text') {
            if (node.text === '') continue
            const previous = result[result.length - 1]
            if (previous?.kind === 'text') result[result.length - 1] = { kind: 'text', text: previous.text + node.text }
            else result.push(node)
            continue
        }
        if (node.kind === 'break') {
            result.push(node)
            continue
        }
        const children = tidy(node.children)
        if (children.length === 0 && node.tag !== 'li') continue
        result.push({ ...node, children })
    }
    return result
}

/** A web address in text. It ends at whitespace, a quote, an angle bracket or a control character. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"\u0000-\u001f\u007f]+/gi

/**
 * A URL found in text, without punctuation that ends the sentence around it: a trailing full stop,
 * comma or quote, and a closing bracket the URL did not open.
 */
function trimUrl(url: string): string {
    let trimmed = url
    for (;;) {
        const last = trimmed[trimmed.length - 1]
        const count = (char: string): number => trimmed.split(char).length - 1
        if ('.,;:!?\'"*'.includes(last)) trimmed = trimmed.slice(0, -1)
        else if (last === ')' && count('(') < count(')')) trimmed = trimmed.slice(0, -1)
        else if (last === ']' && count('[') < count(']')) trimmed = trimmed.slice(0, -1)
        else if (last === '}' && count('{') < count('}')) trimmed = trimmed.slice(0, -1)
        else return trimmed
    }
}

/** Text with each web address in it made a link. */
function linkifyText(text: string): DescriptionNode[] {
    const nodes: DescriptionNode[] = []
    let last = 0
    for (const match of text.matchAll(URL_PATTERN)) {
        const url = trimUrl(match[0])
        if (!/^https?:\/\/[^/?#]/i.test(url)) continue
        const start = match.index
        if (start > last) nodes.push({ kind: 'text', text: text.slice(last, start) })
        nodes.push({ kind: 'element', tag: 'a', href: url, children: [{ kind: 'text', text: url }] })
        last = start + url.length
    }
    if (last < text.length) nodes.push({ kind: 'text', text: text.slice(last) })
    return nodes
}

/** Makes links of the web addresses in a tree's text, outside the links it already has. */
function linkify(nodes: readonly DescriptionNode[]): DescriptionNode[] {
    return nodes.flatMap((node): DescriptionNode[] => {
        if (node.kind === 'text') return linkifyText(node.text)
        if (node.kind === 'break' || node.tag === 'a') return [node]
        return [{ ...node, children: linkify(node.children) }]
    })
}

function isBlock(node: DescriptionNode): node is ElementNode {
    return node.kind === 'element' && BLOCK_TAGS.has(node.tag)
}

/**
 * Moves blocks out of inline elements, carrying the inline element into each block instead:
 * `<b><div>Garden</div></b>` becomes a paragraph holding bold `Garden`, and a link around a list
 * becomes a link in each list item. A browser shows both the same, and with blocks only ever inside
 * blocks, every line a paragraph or list makes is one the HTML writer can see and keep.
 */
function liftBlocks(nodes: readonly DescriptionNode[]): DescriptionNode[] {
    const result: DescriptionNode[] = []
    for (const node of nodes) {
        if (node.kind !== 'element') {
            result.push(node)
            continue
        }
        const children = liftBlocks(node.children)
        if (BLOCK_TAGS.has(node.tag) || !children.some(isBlock)) {
            result.push({ ...node, children })
            continue
        }
        let run: DescriptionNode[] = []
        const flush = (): void => {
            if (run.length > 0) result.push({ ...node, children: run })
            run = []
        }
        for (const child of children) {
            if (!isBlock(child)) {
                run.push(child)
                continue
            }
            flush()
            // The block's own content goes back through, as it may hold blocks of its own.
            result.push({ ...child, children: liftBlocks([{ ...node, children: child.children }]) })
        }
        flush()
    }
    return result
}

/** The steps every HTML tree goes through, from the source or from the editor alike. */
function finish(nodes: readonly DescriptionNode[]): DescriptionNode[] {
    const state: WhitespaceState = { atLineStart: true, last: null }
    const collapsed = collapseWhitespace(liftBlocks(nodes), state)
    endLine(state)
    return linkify(tidy(collapsed))
}

/** A plain-text description: each line ends with a break, and web addresses become links. */
function parsePlainText(source: string): DescriptionNode[] {
    const nodes: DescriptionNode[] = []
    decodeEntities(source)
        .split(/\r\n|\r|\n/)
        .forEach((line, index) => {
            if (index > 0) nodes.push({ kind: 'break' })
            if (line !== '') nodes.push(...linkifyText(line))
        })
    return nodes
}

/** Whether a source holds any HTML: a comment or a tag with an HTML name, so `Garden <shed@example.com>` stays text. */
function looksLikeHtml(source: string): boolean {
    if (source.includes('<!--')) return true
    for (const match of source.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])[^>]*>/g)) {
        if (KNOWN_TAGS.has(match[1].toLowerCase())) return true
    }
    return false
}

/**
 * Reads a description into a tree. A source with no HTML in it is plain text: its line breaks are
 * kept as written, and web addresses become links. Otherwise it is read as a browser would read it,
 * keeping bold, italic, underline, lists, paragraphs, line breaks and web and email links.
 */
export function parseDescription(source: string): DescriptionNode[] {
    if (!looksLikeHtml(source)) return parsePlainText(source)
    return finish(buildTree(tokenize(source)))
}

/** The part of `Document` that building a description needs. A real `Document` is one. */
export type DescriptionDocument = Pick<Document, 'createDocumentFragment' | 'createElement' | 'createTextNode'>

function appendNodes(parent: Node, nodes: readonly DescriptionNode[], doc: DescriptionDocument): void {
    for (const node of nodes) {
        if (node.kind === 'text') {
            parent.appendChild(doc.createTextNode(node.text))
            continue
        }
        if (node.kind === 'break') {
            parent.appendChild(doc.createElement('br'))
            continue
        }
        // The link is checked again here, in case the tree came from somewhere other than this module.
        const href = node.tag === 'a' ? safeHref(node.href) : null
        if (node.tag === 'a' && href === null) {
            appendNodes(parent, node.children, doc)
            continue
        }
        const element = doc.createElement(node.tag)
        if (href !== null) {
            element.setAttribute('href', href)
            element.setAttribute('target', '_blank')
            element.setAttribute('rel', 'noopener noreferrer')
        }
        appendNodes(element, node.children, doc)
        parent.appendChild(element)
    }
}

/** Builds a description as DOM, with `createElement` and `createTextNode` alone. Links open in a new tab. */
export function renderDescription(nodes: readonly DescriptionNode[], doc: DescriptionDocument): DocumentFragment {
    const fragment = doc.createDocumentFragment()
    appendNodes(fragment, nodes, doc)
    return fragment
}

/** Children of a paragraph without the line break that ends it, which a browser shows as no line of its own. */
function withoutClosingBreak(nodes: readonly DescriptionNode[]): readonly DescriptionNode[] {
    return nodes[nodes.length - 1]?.kind === 'break' ? nodes.slice(0, -1) : nodes
}

function serializeNodes(nodes: readonly DescriptionNode[]): string {
    let html = ''
    // Content written on the current line, and whether the last thing written was a paragraph.
    let lineOpen = false
    let afterParagraph = false
    for (const node of nodes) {
        if (node.kind === 'element' && node.tag === 'p') {
            if (lineOpen || afterParagraph) html += '<br>'
            const inner = serializeNodes(withoutClosingBreak(node.children))
            html += inner
            // A paragraph that ends with a list already ends its line.
            afterParagraph = !/<\/(ul|ol)>$/.test(inner)
            lineOpen = false
            continue
        }
        // An element with nothing in it shows nothing and reads back as nothing, so it is not
        // written. A list item is the exception, since it still shows its bullet.
        const inner = node.kind === 'element' ? serializeNodes(node.children) : ''
        if (node.kind === 'element' && inner === '' && node.tag !== 'li') continue
        if (node.kind === 'element' && (node.tag === 'ul' || node.tag === 'ol' || node.tag === 'li')) {
            html += `<${node.tag}>${inner}</${node.tag}>`
            lineOpen = false
            afterParagraph = false
            continue
        }
        if (afterParagraph) html += '<br>'
        afterParagraph = false
        if (node.kind === 'break') {
            html += '<br>'
            lineOpen = false
            continue
        }
        lineOpen = true
        if (node.kind === 'text') html += escapeText(node.text)
        else if (node.tag === 'a') {
            const href = safeHref(node.href)
            html += href === null ? inner : `<a href="${escapeAttribute(href)}">${inner}</a>`
        } else html += `<${node.tag}>${inner}</${node.tag}>`
    }
    return html
}

/**
 * Writes a description as the HTML Google Calendar's editor writes: `b`, `i`, `u`, `br`, `ul`, `ol`,
 * `li` and `a href`. A paragraph becomes its content, with a line break between it and what is
 * around it. Reading the result back gives the tree written, for any tree read from HTML without
 * paragraphs. A tree with paragraphs reads back with line breaks in their place.
 */
export function serializeDescription(nodes: readonly DescriptionNode[]): string {
    return serializeNodes(nodes)
}

/** A node of the editor's DOM, as far as reading it back needs. A DOM `Node` is one. */
export interface EditableNode {
    readonly nodeType: number
    readonly nodeName: string
    readonly textContent: string | null
    readonly childNodes: ArrayLike<EditableNode>
    getAttribute?(name: string): string | null
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3

function collectEditable(nodes: ArrayLike<EditableNode>): DescriptionNode[] {
    const result: DescriptionNode[] = []
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]
        if (node.nodeType === TEXT_NODE) {
            result.push({ kind: 'text', text: node.textContent ?? '' })
            continue
        }
        if (node.nodeType !== ELEMENT_NODE) continue
        const role = roleOf(node.nodeName.toLowerCase())
        if (role.kind === 'drop') continue
        if (role.kind === 'break') {
            result.push({ kind: 'break' })
            continue
        }
        const children = collectEditable(node.childNodes)
        if (role.kind === 'unwrap') {
            result.push(...children)
            continue
        }
        if (role.tag === 'a') {
            const href = safeHref(node.getAttribute?.('href'))
            if (href === null) result.push(...children)
            else result.push({ kind: 'element', tag: 'a', href, children })
            continue
        }
        result.push({ kind: 'element', tag: role.tag, children })
    }
    return result
}

/**
 * Reads the rich-text field back into a tree, so it can be saved. The field's DOM is walked node by
 * node and mapped as HTML is: the `div` a browser makes for each new line reads as a paragraph,
 * `strong` as bold, and so on. Whitespace collapses as the field shows it, so the field should use
 * normal white-space, where the browser writes runs of spaces as no-break spaces.
 */
export function nodesFromEditable(root: { readonly childNodes: ArrayLike<EditableNode> }): DescriptionNode[] {
    return finish(collectEditable(root.childNodes))
}

/**
 * A description as plain text, for the Journal Panel and for screen readers: line breaks as
 * newlines, each paragraph and list item on its own line, at most one empty line in a row, and
 * no-break spaces as plain spaces.
 */
export function descriptionText(source: string): string {
    let text = ''
    const startLine = (): void => {
        if (text !== '' && !text.endsWith('\n')) text += '\n'
    }
    const walk = (nodes: readonly DescriptionNode[]): void => {
        for (const node of nodes) {
            if (node.kind === 'text') text += node.text
            else if (node.kind === 'break') text += '\n'
            else if (BLOCK_TAGS.has(node.tag)) {
                startLine()
                walk(node.children)
                startLine()
            } else walk(node.children)
        }
    }
    walk(parseDescription(source))
    return text
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}
