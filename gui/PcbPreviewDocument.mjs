/**
 * Wraps a rendered PCB SVG fragment in a self-contained HTML document for the
 * sandboxed preview iframe.
 *
 * The toolkit's {@link PcbSvgRenderer} emits semantic classes under the
 * `pcb-svg--app-palette` contract and ships no colors of its own: the
 * consuming application owns the palette. The preview iframe uses `sandbox=""`
 * (an opaque origin with no scripts), so it cannot pull the application
 * stylesheet or any external resource. This wrapper therefore inlines both the
 * sizing rules and an app palette so the SVG renders identically wherever it is
 * embedded, without a single network request.
 */
export class PcbPreviewDocument {
    /**
     * App palette and sizing for the CircuitJSON PCB class vocabulary.
     *
     * Colors reuse the toolkit's `--pcb-*` custom properties and values so the
     * preview matches the renderer's intended appearance. Rules are keyed to
     * semantic roles (board, copper surface/subsurface, tracks, pads, vias,
     * zones, silkscreen, labels), never to any specific document.
     * @type {string}
     */
    static #STYLE = [
        ':root{color-scheme:light;',
        '--pcb-board-fill:#d8e8e4;--pcb-board-stroke:#0f746c;',
        '--pcb-surface-track-color:rgba(199,82,45,0.92);',
        '--pcb-copper-solid-fill:rgba(196,118,70,0.68);',
        '--pcb-subsurface-track-color:rgba(15,116,108,0.56);',
        '--pcb-subsurface-fill:rgba(15,116,108,0.07);',
        '--pcb-via-ring-fill:rgba(232,236,233,0.92);',
        '--pcb-via-hole-fill:#0f746c;',
        '--pcb-silkscreen-color:rgba(66,93,112,0.9);',
        '--pcb-label-color:#0f2b28;}',
        'html,body{margin:0;height:100%;}',
        'body{box-sizing:border-box;padding:12px;background:#f5f7f7;}',
        // Fill the frame and let the viewBox default preserveAspectRatio
        // ("xMidYMid meet") scale the whole board to fit and centre it, so
        // portrait boards are not clipped by the frame height.
        '.pcb-svg{display:block;width:100%;height:100%;}',
        '.pcb-board{fill:var(--pcb-board-fill);stroke:var(--pcb-board-stroke);',
        'stroke-width:.2;vector-effect:non-scaling-stroke;}',
        '.pcb-track{stroke-linecap:round;stroke-linejoin:round;}',
        '.pcb-copper--surface .pcb-track{fill:none;',
        'stroke:var(--pcb-surface-track-color);}',
        '.pcb-copper--surface .pcb-pad,.pcb-copper--surface .pcb-zone{',
        'fill:var(--pcb-copper-solid-fill);stroke:none;}',
        '.pcb-copper--subsurface .pcb-track{fill:none;',
        'stroke:var(--pcb-subsurface-track-color);}',
        '.pcb-copper--subsurface .pcb-pad,.pcb-copper--subsurface .pcb-zone{',
        'fill:var(--pcb-subsurface-fill);stroke:none;}',
        '.pcb-via{fill:var(--pcb-via-ring-fill);',
        'stroke:var(--pcb-surface-track-color);stroke-width:.05;}',
        '.pcb-via__hole{fill:var(--pcb-via-hole-fill);stroke:none;}',
        '.pcb-silkscreen,.pcb-silkscreen-line{fill:none;',
        'stroke:var(--pcb-silkscreen-color);}',
        '.pcb-silkscreen-text{fill:var(--pcb-silkscreen-color);stroke:none;}',
        // Reference designators and other labels ship without a font-size and
        // otherwise fall back to the 16-unit SVG default, dwarfing small
        // boards. Size all text to roughly a millimetre, then let the specific
        // trace-length labels opt into a larger size.
        'text{font-size:1px;fill:var(--pcb-label-color);}',
        '.pcb-trace-length-label{font-size:2.4px;}',
        // The diagnostics layer is an internal QA overlay, not board geometry;
        // the preview shows the board itself.
        '.pcb-diagnostics,.pcb-diagnostic-marker{display:none;}'
    ].join('')

    /**
     * Wraps one SVG fragment in a complete, standalone HTML preview document.
     * @param {string} svgMarkup SVG markup from the PCB renderer.
     * @returns {string} A full HTML document safe to assign to an iframe srcdoc.
     */
    static render(svgMarkup) {
        return [
            '<!doctype html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width,initial-scale=1">',
            '<title>PCB preview</title>',
            `<style>${PcbPreviewDocument.#STYLE}</style>`,
            '</head>',
            '<body>',
            svgMarkup ?? '',
            '</body>',
            '</html>'
        ].join('')
    }
}
