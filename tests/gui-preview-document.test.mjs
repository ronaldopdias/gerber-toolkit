import assert from 'node:assert/strict'
import test from 'node:test'

import { PcbPreviewDocument } from '../gui/PcbPreviewDocument.mjs'

const SAMPLE_SVG =
    '<svg class="pcb-svg pcb-svg--app-palette" viewBox="0 0 10 10">' +
    '<polygon class="pcb-board" points="0,0 10,0 10,10 0,10"></polygon>' +
    '</svg>'

test('PcbPreviewDocument wraps the SVG in a complete HTML document', () => {
    const html = PcbPreviewDocument.render(SAMPLE_SVG)
    assert.match(html, /^<!doctype html>/i)
    assert.match(html, /<html[ >]/i)
    assert.match(html, /<\/html>\s*$/i)
    assert.ok(html.includes(SAMPLE_SVG))
})

test('PcbPreviewDocument sizes the SVG so it fills the preview frame', () => {
    const html = PcbPreviewDocument.render(SAMPLE_SVG)
    assert.match(html, /\.pcb-svg\s*\{[^}]*width:\s*100%/)
})

test('PcbPreviewDocument supplies an app palette for the core PCB classes', () => {
    const html = PcbPreviewDocument.render(SAMPLE_SVG)
    // The toolkit emits class-only geometry and leaves the palette to the app,
    // so the preview must define fills/strokes for each semantic role.
    for (const selector of [
        '.pcb-board',
        '.pcb-via',
        '.pcb-via__hole',
        '.pcb-copper--surface .pcb-track',
        '.pcb-copper--subsurface .pcb-track'
    ]) {
        assert.ok(
            html.includes(selector),
            `preview stylesheet is missing a rule for ${selector}`
        )
    }
    assert.match(html, /fill:\s*var\(--pcb-board-fill/)
})

test('PcbPreviewDocument is self-contained and loads no external resource', () => {
    const html = PcbPreviewDocument.render(SAMPLE_SVG)
    assert.ok(!/<script/i.test(html), 'preview must not embed scripts')
    assert.ok(
        !/<link\b[^>]*rel=["']?stylesheet/i.test(html),
        'preview must not link an external stylesheet'
    )
    assert.ok(
        !/\bhref=["']https?:/i.test(html) && !/\bsrc=["']https?:/i.test(html),
        'preview must not reference remote resources'
    )
})

test('PcbPreviewDocument tolerates missing SVG markup', () => {
    for (const value of ['', undefined, null]) {
        const html = PcbPreviewDocument.render(value)
        assert.match(html, /^<!doctype html>/i)
        assert.match(html, /<\/html>\s*$/i)
    }
})
