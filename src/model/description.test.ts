import { describe, expect, it } from 'vitest'
import {
    descriptionText,
    nodesFromEditable,
    parseDescription,
    renderDescription,
    serializeDescription,
    type DescriptionDocument,
    type DescriptionNode,
    type DescriptionTag,
} from './description'

const text = (value: string): DescriptionNode => ({ kind: 'text', text: value })
const br: DescriptionNode = { kind: 'break' }
const el = (tag: DescriptionTag, ...children: DescriptionNode[]): DescriptionNode => ({ kind: 'element', tag, children })
const link = (href: string, ...children: DescriptionNode[]): DescriptionNode => ({ kind: 'element', tag: 'a', href, children })

/**
 * Just enough of the DOM to build into and to read back from. It refuses `innerHTML`, so a test
 * fails if the module ever reaches for it.
 */
class FakeNode {
    childNodes: FakeNode[] = []
    readonly attributes = new Map<string, string>()

    constructor(
        readonly nodeType: number,
        readonly nodeName: string,
        private readonly data: string | null = null,
    ) {}

    get textContent(): string | null {
        return this.nodeType === 3 || this.nodeType === 8 ? this.data : this.childNodes.map((child) => child.textContent ?? '').join('')
    }

    appendChild(child: FakeNode): FakeNode {
        if (child.nodeType === 11) {
            this.childNodes.push(...child.childNodes)
            child.childNodes = []
        } else {
            this.childNodes.push(child)
        }
        return child
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value)
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null
    }

    set innerHTML(_markup: string) {
        throw new Error('innerHTML is refused')
    }
}

const fakeDocument = {
    createDocumentFragment: () => new FakeNode(11, '#document-fragment'),
    createElement: (tag: string) => new FakeNode(1, tag.toUpperCase()),
    createTextNode: (value: string) => new FakeNode(3, '#text', value),
} as unknown as DescriptionDocument

/** A fake node and its children as markup, to compare what was built. */
function markup(node: FakeNode): string {
    return node.childNodes
        .map((child) => {
            if (child.nodeType === 3) return (child.textContent ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            const tag = child.nodeName.toLowerCase()
            const attributes = [...child.attributes].map(([name, value]) => ` ${name}="${value}"`).join('')
            return tag === 'br' ? '<br>' : `<${tag}${attributes}>${markup(child)}</${tag}>`
        })
        .join('')
}

function render(nodes: DescriptionNode[]): FakeNode {
    return renderDescription(nodes, fakeDocument) as unknown as FakeNode
}

/** A hand-made editor DOM node. */
function element(name: string, attributes: Record<string, string>, ...children: FakeNode[]): FakeNode {
    const node = new FakeNode(1, name.toUpperCase())
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
    for (const child of children) node.appendChild(child)
    return node
}

const textNode = (value: string): FakeNode => new FakeNode(3, '#text', value)

describe('parseDescription: plain text', () => {
    it('keeps line breaks as breaks', () => {
        expect(parseDescription('Garden\nwater the beans\r\nKitchen\rShed')).toEqual([text('Garden'), br, text('water the beans'), br, text('Kitchen'), br, text('Shed')])
        expect(parseDescription('Garden\n\nKitchen')).toEqual([text('Garden'), br, br, text('Kitchen')])
    })

    it('keeps spaces as written', () => {
        expect(parseDescription('  water  the beans ')).toEqual([text('  water  the beans ')])
    })

    it('makes web addresses links, leaving sentence punctuation outside', () => {
        expect(parseDescription('See https://example.com/garden.')).toEqual([text('See '), link('https://example.com/garden', text('https://example.com/garden')), text('.')])
        expect(parseDescription('(https://example.com/beans_(green))')).toEqual([
            text('('),
            link('https://example.com/beans_(green)', text('https://example.com/beans_(green)')),
            text(')'),
        ])
        expect(parseDescription('http://example.com, https://example.org')).toEqual([
            link('http://example.com', text('http://example.com')),
            text(', '),
            link('https://example.org', text('https://example.org')),
        ])
    })

    it('leaves an address that is not a web address as text', () => {
        expect(parseDescription('https:// and xhttps://example.com')).toEqual([text('https:// and xhttps://example.com')])
    })

    it('reads angle brackets that make no HTML tag as text', () => {
        expect(parseDescription('Garden <shed@example.com>\n1 < 2 > 0')).toEqual([text('Garden <shed@example.com>'), br, text('1 < 2 > 0')])
    })

    it('decodes character references', () => {
        expect(parseDescription('Fish &amp; chips')).toEqual([text('Fish & chips')])
    })

    it('reads an empty description as nothing', () => {
        expect(parseDescription('')).toEqual([])
    })
})

describe('parseDescription: HTML', () => {
    it('reads what Google Calendar writes', () => {
        expect(parseDescription('Water the <b>beans</b><br>Then the <i>kitchen</i> and <u>shed</u>')).toEqual([
            text('Water the '),
            el('b', text('beans')),
            br,
            text('Then the '),
            el('i', text('kitchen')),
            text(' and '),
            el('u', text('shed')),
        ])
    })

    it('reads strong, em, div and span as bold, italic, a paragraph and their content', () => {
        expect(parseDescription('<strong>Garden</strong> <em>beans</em><div><span>Kitchen</span></div>')).toEqual([
            el('b', text('Garden')),
            text(' '),
            el('i', text('beans')),
            el('p', text('Kitchen')),
        ])
    })

    it('closes tags left open and ignores end tags with nothing to close', () => {
        expect(parseDescription('<b>Garden<i>beans')).toEqual([el('b', text('Garden'), el('i', text('beans')))])
        expect(parseDescription('Garden</b></i> beans</ul></a>')).toEqual([text('Garden beans')])
    })

    it('carries formatting on past an end tag out of order', () => {
        expect(parseDescription('<b>Garden<i>beans</b>peas</i>')).toEqual([el('b', text('Garden'), el('i', text('beans'))), el('i', text('peas'))])
    })

    it('reads nested lists and closes list items left open', () => {
        expect(parseDescription('<ul><li>Garden<ul><li>beans</li><li>peas</ul></li><li>Kitchen</ul><ol><li>one<li>two</ol>')).toEqual([
            el('ul', el('li', text('Garden'), el('ul', el('li', text('beans')), el('li', text('peas')))), el('li', text('Kitchen'))),
            el('ol', el('li', text('one')), el('li', text('two'))),
        ])
    })

    it('does not let formatting close across a list', () => {
        expect(parseDescription('<b>Garden<ul><li>beans</b> peas</li></ul>')).toEqual([el('b', text('Garden')), el('ul', el('li', el('b', text('beans peas'))))])
    })

    it('keeps web and email links, with their address decoded', () => {
        expect(parseDescription('<a href="https://example.com/garden?a=1&amp;b=2" title="Garden">Garden</a>')).toEqual([link('https://example.com/garden?a=1&b=2', text('Garden'))])
        expect(parseDescription("<a href='mailto:shed@example.com'>Shed</a>")).toEqual([link('mailto:shed@example.com', text('Shed'))])
        expect(parseDescription('<a href=HTTP://example.com/beans>beans</a>')).toEqual([link('HTTP://example.com/beans', text('beans'))])
        expect(parseDescription('<a href=" https://example.com/kit\nchen ">Kitchen</a>')).toEqual([link('https://example.com/kitchen', text('Kitchen'))])
    })

    it('drops links that are not web or email addresses and keeps their text', () => {
        for (const href of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,beans', 'vbscript:x', '/garden', '#kitchen', '']) {
            expect(parseDescription(`<a href="${href}">Garden</a> beans`), href).toEqual([text('Garden beans')])
        }
        expect(parseDescription('<a>Garden</a>')).toEqual([text('Garden')])
    })

    it('closes an open link when another starts', () => {
        expect(parseDescription('<a href="https://example.com/a">Garden <a href="https://example.com/b">beans</a></a>')).toEqual([
            link('https://example.com/a', text('Garden ')),
            link('https://example.com/b', text('beans')),
        ])
    })

    it('decodes character references', () => {
        expect(parseDescription('<b>&amp;&lt;&gt;&quot;&#39;&apos;&nbsp;&#123;&#x41;&#x1F;&#0;&unknown;&amp</b>')).toEqual([el('b', text('&<>"\'\'\u00a0{A\u001f\ufffd&unknown;&amp'))])
    })

    it('drops scripts, styles, the head and the title with their content', () => {
        expect(parseDescription('Garden<script>alert("beans")</script> Kitchen<style>b { color: red }</style>')).toEqual([text('Garden Kitchen')])
        expect(parseDescription('<html><head><title>Shed</title><meta charset="utf-8"></head><body>Garden</body></html>')).toEqual([text('Garden')])
        expect(parseDescription('<head><title>Shed</title><body>Garden')).toEqual([text('Garden')])
        expect(parseDescription('Garden<script>alert("beans")')).toEqual([text('Garden')])
        expect(parseDescription('Garden<SCRIPT type="text/javascript">x()</SCRIPT>')).toEqual([text('Garden')])
    })

    it('drops comments and doctypes', () => {
        expect(parseDescription('<!DOCTYPE html><!-- note -->Garden<br><!-- unclosed')).toEqual([text('Garden'), br])
    })

    it('unwraps tags it does not keep', () => {
        expect(parseDescription('<font color="green">Garden</font><img src="beans.png" alt="beans"><sup>2</sup>')).toEqual([text('Garden2')])
    })

    it('reads every way of writing a line break', () => {
        expect(parseDescription('Garden<br/>beans<BR />peas</br>Kitchen<hr>Shed')).toEqual([text('Garden'), br, text('beans'), br, text('peas'), br, text('Kitchen'), br, text('Shed')])
    })

    it('reads headings and other blocks as paragraphs', () => {
        expect(parseDescription('<h2>Garden</h2><blockquote>water the beans</blockquote>')).toEqual([el('p', text('Garden')), el('p', text('water the beans'))])
    })

    it('moves blocks out of bold, italic, underline and links, carrying the formatting into them', () => {
        expect(parseDescription('<b>Garden<div>beans</div>peas</b>')).toEqual([el('b', text('Garden')), el('p', el('b', text('beans'))), el('b', text('peas'))])
        expect(parseDescription('<a href="https://example.com/x"><ul><li>Garden</li><li>beans<ol><li>peas</li></ol></li></ul></a>')).toEqual([
            el(
                'ul',
                el('li', link('https://example.com/x', text('Garden'))),
                el('li', link('https://example.com/x', text('beans')), el('ol', el('li', link('https://example.com/x', text('peas'))))),
            ),
        ])
    })

    it('ends an open paragraph where a block starts', () => {
        expect(parseDescription('<p>Garden<p>Kitchen<ul><li>beans</li></ul>')).toEqual([el('p', text('Garden')), el('p', text('Kitchen')), el('ul', el('li', text('beans')))])
    })

    it('collapses whitespace as a browser does', () => {
        expect(parseDescription('<p>  Garden \n\n  beans  </p>  <p>\tKitchen</p>')).toEqual([el('p', text('Garden beans')), el('p', text('Kitchen'))])
        expect(parseDescription('<b>Garden </b> beans <br>  peas')).toEqual([el('b', text('Garden ')), text('beans'), br, text('peas')])
        expect(parseDescription('<ul>\n  <li> Garden </li>\n  <li>beans</li>\n</ul>')).toEqual([el('ul', el('li', text('Garden')), el('li', text('beans')))])
        expect(parseDescription('<b>a</b>&nbsp;&nbsp;b')).toEqual([el('b', text('a')), text('\u00a0\u00a0b')])
    })

    it('drops what shows nothing and keeps an empty list item', () => {
        expect(parseDescription('<b></b><i> </i>Garden<div></div><ul></ul><ul><li></li></ul>')).toEqual([text('Garden'), el('ul', el('li'))])
    })

    it('reads a < that starts no tag as text', () => {
        expect(parseDescription('<b>1 < 2</b> and <i')).toEqual([el('b', text('1 < 2')), text(' and <i')])
    })

    it('makes web addresses in the text links, but not inside a link', () => {
        expect(parseDescription('Join at https://example.com/garden<br><a href="https://example.com/x">https://example.com/kitchen</a>')).toEqual([
            text('Join at '),
            link('https://example.com/garden', text('https://example.com/garden')),
            br,
            link('https://example.com/x', text('https://example.com/kitchen')),
        ])
    })

    it('joins text split by unwrapped tags', () => {
        expect(parseDescription('<span>https://example.com</span><span>/garden</span>')).toEqual([link('https://example.com/garden', text('https://example.com/garden'))])
    })

    it('reads a tag whose attribute quote never closes as text', () => {
        expect(parseDescription('Garden<br><a href="https://example.com>beans')).toEqual([
            text('Garden'),
            br,
            text('<a href="'),
            link('https://example.com', text('https://example.com')),
            text('>beans'),
        ])
    })
})

describe('renderDescription', () => {
    it('builds the tree as DOM, with links that open in a new tab', () => {
        const fragment = render([el('b', text('Garden')), br, link('https://example.com/beans', text('beans')), el('ul', el('li', el('i', text('peas'))))])
        expect(markup(fragment)).toBe('<b>Garden</b><br><a href="https://example.com/beans" target="_blank" rel="noopener noreferrer">beans</a><ul><li><i>peas</i></li></ul>')
    })

    it('builds text that looks like markup as text', () => {
        const fragment = render(parseDescription('&lt;script&gt;alert(1)&lt;/script&gt; <b>Garden</b>'))
        expect(fragment.childNodes[0].nodeType).toBe(3)
        expect(fragment.childNodes[0].textContent).toBe('<script>alert(1)</script> ')
    })

    it('builds an unsafe link from a hand-made tree as its text alone', () => {
        expect(markup(render([link('javascript:alert(1)', text('Garden'))]))).toBe('Garden')
    })

    it('builds a description read from HTML', () => {
        expect(markup(render(parseDescription('<div>Garden <strong>beans</strong></div><div><a href="mailto:shed@example.com">Shed</a></div>')))).toBe(
            '<p>Garden <b>beans</b></p><p><a href="mailto:shed@example.com" target="_blank" rel="noopener noreferrer">Shed</a></p>',
        )
    })
})

describe('serializeDescription', () => {
    it('writes HTML as Google Calendar writes it', () => {
        expect(serializeDescription([text('Water the '), el('b', text('beans')), br, el('i', text('then')), text(' '), el('u', text('the shed'))])).toBe(
            'Water the <b>beans</b><br><i>then</i> <u>the shed</u>',
        )
        expect(serializeDescription([el('ol', el('li', text('Garden')), el('li', text('Kitchen')))])).toBe('<ol><li>Garden</li><li>Kitchen</li></ol>')
    })

    it('escapes text and attribute values', () => {
        expect(serializeDescription([text('Fish & chips <3 "beans" \u00a0')])).toBe('Fish &amp; chips &lt;3 "beans" &nbsp;')
        expect(serializeDescription([link('https://example.com/?q="beans"&a=<1>', text('Garden'))])).toBe('<a href="https://example.com/?q=&quot;beans&quot;&amp;a=&lt;1&gt;">Garden</a>')
    })

    it('writes an unsafe link from a hand-made tree as its text alone', () => {
        expect(serializeDescription([link('javascript:alert(1)', text('Garden'))])).toBe('Garden')
    })

    it('writes paragraphs as lines, with a break between them and what is around them', () => {
        expect(serializeDescription([el('p', text('Garden')), el('p', text('beans'))])).toBe('Garden<br>beans')
        expect(serializeDescription([text('Garden'), el('p', text('beans')), text('Kitchen')])).toBe('Garden<br>beans<br>Kitchen')
        expect(serializeDescription([text('Garden'), br, el('p', text('beans'))])).toBe('Garden<br>beans')
        expect(serializeDescription([el('ul', el('li', text('beans'))), el('p', text('Garden')), el('ul', el('li', text('peas')))])).toBe('<ul><li>beans</li></ul>Garden<ul><li>peas</li></ul>')
        expect(serializeDescription([el('p', text('Garden'), el('ul', el('li', text('beans')))), el('p', text('Kitchen'))])).toBe('Garden<ul><li>beans</li></ul>Kitchen')
        expect(serializeDescription([el('li', el('p', text('Garden')), el('p', text('beans')))])).toBe('<li>Garden<br>beans</li>')
    })

    it('writes the lines a browser editor makes, empty lines included', () => {
        expect(serializeDescription(parseDescription('Garden<div>beans</div><div><br></div><div>Kitchen</div>'))).toBe('Garden<br>beans<br><br>Kitchen')
        expect(serializeDescription(parseDescription('<div>Garden<br></div><div>Kitchen</div>'))).toBe('Garden<br>Kitchen')
        expect(serializeDescription(parseDescription('<div><br></div><div>Garden</div>'))).toBe('<br>Garden')
    })

    const googleSamples = [
        'Water the <b>beans</b><br>Then the <i>kitchen</i>',
        '<ul><li>Garden<ul><li>beans</li><li>peas</li></ul></li><li><a href="https://example.com/kitchen">Kitchen</a></li></ul>',
        '<ol><li><b><i><u>Shed</u></i></b></li></ol>Water the beans at https://example.com/garden.',
        'Fish &amp; chips&nbsp;&nbsp;&lt;3<br><br>  <span>Garden</span> beans  ',
        '<b>Garden<i>beans</b>peas</i>',
        '<a href="mailto:shed@example.com">Shed</a> <a href="javascript:x">Kitchen</a>',
        'Garden<br>',
        '<li>Garden</li>beans',
    ]

    it.each(googleSamples)('reads back what it writes for %s', (source) => {
        const nodes = parseDescription(source)
        expect(parseDescription(serializeDescription(nodes))).toEqual(nodes)
    })

    /** A small seeded generator, so the random cases are the same on every run. */
    function seeded(seed: number): () => number {
        let state = seed >>> 0
        return () => {
            state = (state + 0x6d2b79f5) >>> 0
            let mixed = state
            mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
            mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
            return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
        }
    }

    const googlePieces = [
        '<b>', '</b>', '<i>', '</i>', '<u>', '</u>', '<strong>', '</strong>', '<em>', '</em>', '<span>', '</span>', '<font>', '</font>',
        '<br>', '<br/>', '<ul>', '</ul>', '<ol>', '</ol>', '<li>', '</li>', '</a>', '<a href="https://example.com/garden?a=1&amp;b=2">',
        '<a href="mailto:shed@example.com">', '<a href="javascript:void(0)">', '<script>beans</script>', '<!-- note -->',
        '<a href=https://example.com/x>', '<a href="x', '<b', '</br>', '<hr>', '<img src=x>', '<', '>',
        ' ', '  ', '\n', '\t', 'Garden', 'beans', 'water the beans', '&amp;', '&lt;', '&gt;', '&nbsp;', '&#39;', '&#x1F;', '"', '1 < 2',
        'https://example.com/kitchen', '(https://example.com/shed)', 'https://', '.', ',',
    ]
    const blockPieces = ['<div>', '</div>', '<p>', '</p>', '<h1>', '</h1>', '<div><br></div>', '<blockquote>', '</blockquote>', '<tr>', '<td>']

    function soup(random: () => number, pieces: readonly string[]): string {
        const length = 1 + Math.floor(random() * 40)
        let source = '<span>'
        for (let index = 0; index < length; index++) source += pieces[Math.floor(random() * pieces.length)]
        return source
    }

    it('reads back what it writes for random HTML without paragraphs', () => {
        const random = seeded(20261012)
        for (let run = 0; run < 2000; run++) {
            const source = soup(random, googlePieces)
            const nodes = parseDescription(source)
            expect(parseDescription(serializeDescription(nodes)), source).toEqual(nodes)
        }
    })

    it('writes the same HTML again once paragraphs have become lines', () => {
        const random = seeded(7)
        for (let run = 0; run < 2000; run++) {
            const source = soup(random, [...googlePieces, ...blockPieces])
            const written = serializeDescription(parseDescription(source))
            const reread = parseDescription(written)
            expect(serializeDescription(reread), source).toBe(written)
            expect(parseDescription(serializeDescription(reread)), source).toEqual(reread)
        }
    })
})

describe('nodesFromEditable', () => {
    it('reads the DOM a browser editor makes', () => {
        const root = element(
            'div',
            {},
            textNode('Garden'),
            element('div', {}, element('b', {}, textNode('beans'))),
            element('div', {}, element('br', {})),
            element('div', {}, element('span', { style: 'color: green' }, textNode('Kitchen'))),
            new FakeNode(8, '#comment', 'note'),
            element('a', { href: 'javascript:alert(1)' }, textNode('shed')),
            textNode(' '),
            element('a', { href: 'https://example.com/peas' }, textNode('peas')),
            element('script', {}, textNode('alert(1)')),
            element('strong', {}, textNode('  water   the beans ')),
        )
        expect(nodesFromEditable(root)).toEqual([
            text('Garden'),
            el('p', el('b', text('beans'))),
            el('p', br),
            el('p', text('Kitchen')),
            text('shed '),
            link('https://example.com/peas', text('peas')),
            el('b', text(' water the beans')),
        ])
    })

    it('reads back what renderDescription built', () => {
        for (const source of ['Water the <b>beans</b><br>Then <i>the <u>kitchen</u></i>', '<ul><li>Garden<ol><li>beans</li></ol></li></ul><div>Shed</div>', 'See https://example.com/garden.']) {
            const nodes = parseDescription(source)
            expect(nodesFromEditable(render(nodes)), source).toEqual(nodes)
        }
    })

    it('makes web addresses typed into the field links', () => {
        expect(nodesFromEditable(element('div', {}, textNode('See https://example.com/garden')))).toEqual([text('See '), link('https://example.com/garden', text('https://example.com/garden'))])
    })

    it('accepts a DOM element', () => {
        // Checked by the type checker only: a real element is an editable root.
        const accepts = (field: HTMLElement): DescriptionNode[] => nodesFromEditable(field)
        expect(typeof accepts).toBe('function')
    })
})

describe('descriptionText', () => {
    it('writes breaks as newlines', () => {
        expect(descriptionText('<b>Water</b> the beans<br>Kitchen')).toBe('Water the beans\nKitchen')
    })

    it('puts paragraphs and list items on lines of their own', () => {
        expect(descriptionText('<p>Garden</p><ul><li>beans</li><li>peas<ol><li>green</li></ol></li></ul><p>Kitchen</p>')).toBe('Garden\nbeans\npeas\ngreen\nKitchen')
        expect(descriptionText('Garden<div>beans</div><div><br></div><div>Kitchen</div>')).toBe('Garden\nbeans\n\nKitchen')
    })

    it('keeps at most one empty line and no spaces at line ends', () => {
        expect(descriptionText('Garden  \n\n\n\nKitchen\n')).toBe('Garden\n\nKitchen')
    })

    it('keeps link text and drops scripts', () => {
        expect(descriptionText('<a href="https://example.com/garden">Garden</a>&nbsp;beans<script>x()</script>')).toBe('Garden beans')
    })

    it('reads an empty description as empty text', () => {
        expect(descriptionText('')).toBe('')
    })
})
