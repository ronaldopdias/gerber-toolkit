import assert from 'node:assert/strict'
import test from 'node:test'

import { ProjectLoader } from '../src/index.mjs'
import { CircuitJsonBvrExporter } from '../src/convergence/CircuitJsonBvrExporter.mjs'

/**
 * Encodes a text fixture as an ArrayBuffer.
 * @param {string} text Fixture text.
 * @returns {ArrayBuffer}
 */
function bytes(text) {
    return new TextEncoder().encode(text).buffer
}

/**
 * Loads one X2 Gerber package that carries component and net ownership.
 * @returns {Promise<object>} Canonical document envelope.
 */
async function loadComponentDocument() {
    const top = [
        '%FSLAX34Y34*%',
        '%MOMM*%',
        '%TF.FileFunction,Copper,L1,Top*%',
        '%TA.AperFunction,ComponentPad*%',
        '%ADD10C,1.000*%',
        'D10*',
        '%TO.C,U1*%',
        '%TO.P,U1,1*%',
        '%TO.N,GND*%',
        'X0100000Y0100000D03*',
        '%TO.P,U1,2*%',
        '%TO.N,VCC*%',
        'X0300000Y0100000D03*',
        'M02*'
    ].join('\n')
    const outline = [
        '%FSLAX34Y34*%',
        '%MOMM*%',
        '%ADD10C,0.100*%',
        'D10*',
        'G36*',
        'X000000Y000000D02*',
        'X0400000Y000000D01*',
        'X0400000Y0200000D01*',
        'X000000Y0200000D01*',
        'X000000Y000000D01*',
        'G37*',
        'M02*'
    ].join('\n')
    const project = await ProjectLoader.loadAsync(
        [
            { name: 'board-F_Cu.gtl', data: bytes(top) },
            { name: 'board-Edge_Cuts.gm1', data: bytes(outline) }
        ],
        { worker: false }
    )
    return project.documents[0]
}

/**
 * Loads one plain copper/outline package without component metadata.
 * @returns {Promise<object>} Canonical document envelope.
 */
async function loadPlainDocument() {
    const copper = [
        '%FSLAX34Y34*%',
        '%MOMM*%',
        '%ADD10C,0.200*%',
        'D10*',
        'X000000Y000000D02*',
        'X0500000Y000000D01*',
        'M02*'
    ].join('\n')
    const outline = [
        '%FSLAX34Y34*%',
        '%MOMM*%',
        '%ADD10C,0.100*%',
        'D10*',
        'G36*',
        'X000000Y000000D02*',
        'X0600000Y000000D01*',
        'X0600000Y0400000D01*',
        'X000000Y0400000D01*',
        'X000000Y000000D01*',
        'G37*',
        'M02*'
    ].join('\n')
    const project = await ProjectLoader.loadAsync(
        [
            { name: 'plain-F_Cu.gtl', data: bytes(copper) },
            { name: 'plain-Edge_Cuts.gm1', data: bytes(outline) }
        ],
        { worker: false }
    )
    return project.documents[0]
}

/**
 * Splits BVR text into tab-delimited rows within one named section.
 * @param {string} text BVR document text.
 * @param {string} marker Section marker (for example '<<Pin>>').
 * @returns {string[][]} Data rows for the section, excluding the header line.
 */
function sectionRows(text, marker) {
    const lines = text.split('\n')
    const start = lines.indexOf(marker)
    if (start < 0) return []
    const rows = []
    for (let index = start + 2; index < lines.length; index += 1) {
        const line = lines[index]
        if (line.startsWith('<<') || line.trim() === '') break
        rows.push(line.split('\t'))
    }
    return rows
}

test('CircuitJsonBvrExporter reports availability from placed pads', async () => {
    assert.equal(
        CircuitJsonBvrExporter.hasBoardview(await loadComponentDocument()),
        true
    )
    assert.equal(
        CircuitJsonBvrExporter.hasBoardview(await loadPlainDocument()),
        false
    )
})

test('CircuitJsonBvrExporter emits a valid BVRAW_FORMAT_1 header and sections', async () => {
    const text = CircuitJsonBvrExporter.export(await loadComponentDocument())
    assert.match(text, /^BVRAW_FORMAT_1\n/)
    assert.ok(text.includes('<<Layout>>'))
    assert.ok(text.includes('<<Pin>>'))
    assert.ok(text.includes('<<Nail>>'))
})

test('CircuitJsonBvrExporter maps parts, pins, sides, and nets', async () => {
    const text = CircuitJsonBvrExporter.export(await loadComponentDocument())
    const pins = sectionRows(text, '<<Pin>>')
    assert.equal(pins.length, 2)
    for (const pin of pins) {
        assert.equal(pin[0], 'U1')
        assert.equal(pin[1], '(T)')
    }
    const nets = pins.map((pin) => pin[7])
    assert.deepEqual(new Set(nets), new Set(['GND', 'VCC']))
})

test('CircuitJsonBvrExporter emits outline coordinates in mils', async () => {
    const text = CircuitJsonBvrExporter.export(await loadComponentDocument())
    const outline = sectionRows(text, '<<Layout>>')
    assert.ok(outline.length >= 3)
    // The 40 mm wide outline reaches ~1574.8 mils (40 * 39.37).
    const maxX = Math.max(...outline.map((row) => Number(row[0])))
    assert.ok(Math.abs(maxX - 1574.803) < 1)
})

test('CircuitJsonBvrExporter decodes escaped label characters', () => {
    const model = [
        { type: 'pcb_board', outline: [] },
        {
            type: 'source_component',
            source_component_id: 'c0',
            name: 'REF\\u002A\\u002A'
        },
        {
            type: 'pcb_component',
            pcb_component_id: 'p0',
            source_component_id: 'c0',
            layer: 'top'
        },
        {
            type: 'pcb_smtpad',
            pcb_smtpad_id: 'pad0',
            pcb_component_id: 'p0',
            x: 1,
            y: 1
        }
    ]
    const pins = sectionRows(CircuitJsonBvrExporter.export(model), '<<Pin>>')
    assert.equal(pins[0][0], 'REF**')
})

test('CircuitJsonBvrExporter gives unlinked pads their own single-pin parts', () => {
    const model = [
        { type: 'pcb_board', outline: [] },
        { type: 'pcb_smtpad', pcb_smtpad_id: 'a', x: 1, y: 1, layer: 'top' },
        { type: 'pcb_smtpad', pcb_smtpad_id: 'b', x: 2, y: 2, layer: 'bottom' }
    ]
    const pins = sectionRows(CircuitJsonBvrExporter.export(model), '<<Pin>>')
    assert.equal(pins.length, 2)
    assert.notEqual(pins[0][0], pins[1][0])
    assert.equal(pins[1][1], '(B)')
})
