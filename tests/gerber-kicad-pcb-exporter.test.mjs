import assert from 'node:assert/strict'
import test from 'node:test'

import { ProjectLoader } from '../src/index.mjs'
import { CircuitJsonKicadPcbExporter } from '../src/convergence/CircuitJsonKicadPcbExporter.mjs'

/**
 * Encodes a text fixture as an ArrayBuffer.
 * @param {string} text Fixture text.
 * @returns {ArrayBuffer}
 */
function bytes(text) {
    return new TextEncoder().encode(text).buffer
}

/**
 * Loads one X2 copper package with a trace, a pad, and a named net.
 * @returns {Promise<object>} Canonical document envelope.
 */
async function loadCopperDocument() {
    const copper = [
        '%FSLAX34Y34*%',
        '%MOMM*%',
        '%TF.FileFunction,Copper,L1,Top*%',
        '%ADD10C,0.200*%',
        '%ADD11C,1.000*%',
        'D10*',
        '%TO.N,GND*%',
        'X0100000Y0100000D02*',
        'X0400000Y0100000D01*',
        'D11*',
        '%TO.C,U1*%',
        '%TO.P,U1,1*%',
        'X0100000Y0100000D03*',
        'M02*'
    ].join('\n')
    const outline = [
        '%FSLAX34Y34*%',
        '%MOMM*%',
        '%ADD10C,0.100*%',
        'D10*',
        'G36*',
        'X000000Y000000D02*',
        'X0500000Y000000D01*',
        'X0500000Y0300000D01*',
        'X000000Y0300000D01*',
        'X000000Y000000D01*',
        'G37*',
        'M02*'
    ].join('\n')
    const project = await ProjectLoader.loadAsync(
        [
            { name: 'board-F_Cu.gtl', data: bytes(copper) },
            { name: 'board-Edge_Cuts.gm1', data: bytes(outline) }
        ],
        { worker: false }
    )
    return project.documents[0]
}

test('CircuitJsonKicadPcbExporter reports copper availability', async () => {
    assert.equal(
        CircuitJsonKicadPcbExporter.hasCopper(await loadCopperDocument()),
        true
    )
    assert.equal(CircuitJsonKicadPcbExporter.hasCopper([]), false)
})

test('CircuitJsonKicadPcbExporter emits a balanced kicad_pcb with copper', async () => {
    const text = CircuitJsonKicadPcbExporter.export(await loadCopperDocument())
    assert.match(text, /^\(kicad_pcb\n/)
    assert.ok(text.includes('(layers'))
    assert.ok(text.includes('"B.Cu"') || text.includes('"F.Cu"'))
    // Copper geometry must be present as track segments.
    assert.ok(/\(segment /.test(text))
    // Balanced parentheses (a valid s-expression).
    let balance = 0
    for (const character of text) {
        if (character === '(') balance += 1
        else if (character === ')') balance -= 1
        assert.ok(balance >= 0)
    }
    assert.equal(balance, 0)
})

test('CircuitJsonKicadPcbExporter tags copper with a net table', async () => {
    const text = CircuitJsonKicadPcbExporter.export(await loadCopperDocument())
    assert.match(text, /\(net 0 ""\)/)
    assert.ok(/\(net \d+ "GND"\)/.test(text))
})

test('CircuitJsonKicadPcbExporter declares a two-copper-layer stackup', async () => {
    const text = CircuitJsonKicadPcbExporter.export(await loadCopperDocument())
    const signalLayers = (text.match(/\(\d+ "[^"]+" signal\)/g) || []).length
    assert.equal(signalLayers, 2)
    assert.ok(text.includes('(stackup'))
    assert.ok(text.includes('"F.Cu" (type "copper")'))
    assert.ok(text.includes('"B.Cu" (type "copper")'))
})

test('CircuitJsonKicadPcbExporter sizes circular pads from their radius', () => {
    const model = [
        { type: 'pcb_board', outline: [] },
        {
            type: 'pcb_smtpad',
            pcb_smtpad_id: 'c',
            x: 0,
            y: 0,
            layer: 'bottom',
            shape: 'circle',
            radius: 0.45
        },
        {
            type: 'pcb_smtpad',
            pcb_smtpad_id: 'r',
            x: 1,
            y: 1,
            layer: 'bottom',
            shape: 'rect',
            width: 3,
            height: 2
        }
    ]
    const text = CircuitJsonKicadPcbExporter.export(model)
    // Circle radius 0.45 -> diameter 0.9, not the 0.2 placeholder.
    assert.ok(text.includes('smd circle (at 0 0) (size 0.9 0.9)'))
    assert.ok(text.includes('smd rect (at 0 0) (size 3 2)'))
    assert.ok(!text.includes('(size 0.2 0.2)'))
})

test('CircuitJsonKicadPcbExporter strokes pours as segments only on trace-less layers', () => {
    const ring = {
        outer_ring: {
            vertices: [
                { x: 0, y: 0 },
                { x: 4, y: 0 },
                { x: 4, y: 4 },
                { x: 0, y: 4 }
            ]
        }
    }
    const model = [
        { type: 'pcb_board', outline: [] },
        // Bottom has a real trace, so its pour stays a fill (no segments).
        {
            type: 'pcb_trace',
            pcb_trace_id: 't',
            route: [
                { x: 0, y: 0, width: 0.2, layer: 'bottom' },
                { x: 4, y: 0, width: 0.2, layer: 'bottom' }
            ]
        },
        {
            type: 'pcb_copper_pour',
            pcb_copper_pour_id: 'b',
            layer: 'bottom',
            brep_shape: ring
        },
        // Top has only a pour, so it is stroked into segments to stay visible.
        {
            type: 'pcb_copper_pour',
            pcb_copper_pour_id: 'f',
            layer: 'top',
            brep_shape: ring
        }
    ]
    const text = CircuitJsonKicadPcbExporter.export(model)
    assert.ok(/\(segment [^\n]*\(layer "F\.Cu"\)/.test(text))
    // The only B.Cu segment is the real trace, not a pour outline.
    const bottomSegments = (
        text.match(/\(segment [^\n]*\(layer "B\.Cu"\)/g) || []
    ).length
    assert.equal(bottomSegments, 1)
})

test('CircuitJsonKicadPcbExporter draws pours as filled graphics, not zones', () => {
    const model = [
        { type: 'pcb_board', outline: [] },
        {
            type: 'pcb_copper_pour',
            pcb_copper_pour_id: 'pour0',
            layer: 'bottom',
            brep_shape: {
                outer_ring: {
                    vertices: [
                        { x: 0, y: 0 },
                        { x: 0, y: 0 },
                        { x: 5, y: 0 },
                        { x: 5, y: 5 },
                        { x: 0, y: 5 }
                    ]
                }
            }
        }
    ]
    const text = CircuitJsonKicadPcbExporter.export(model)
    assert.ok(text.includes('(gr_poly '))
    assert.ok(!text.includes('(zone '))
})
