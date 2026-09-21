import assert from 'node:assert/strict'
import test from 'node:test'

import { ProjectLoader } from '../src/index.mjs'
import { CircuitJsonBoardviewExporter } from '../src/convergence/CircuitJsonBoardviewExporter.mjs'

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
 * Splits BRD2 text into a section's whitespace-delimited data rows.
 * @param {string} text BRD2 document text.
 * @param {string} header Section header prefix (for example 'PINS:').
 * @returns {string[][]} Data rows for the section.
 */
function sectionRows(text, header) {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length)
    const start = lines.findIndex((line) => line.startsWith(header))
    if (start < 0) return []
    const rows = []
    for (let index = start + 1; index < lines.length; index += 1) {
        if (/^[A-Z]+:/.test(lines[index])) break
        rows.push(lines[index].split(/\s+/))
    }
    return rows
}

test('CircuitJsonBoardviewExporter reports availability from placed pads', async () => {
    assert.equal(
        CircuitJsonBoardviewExporter.hasBoardview(
            await loadComponentDocument()
        ),
        true
    )
    assert.equal(
        CircuitJsonBoardviewExporter.hasBoardview(await loadPlainDocument()),
        false
    )
})

test('CircuitJsonBoardviewExporter emits the OpenBoardView BRD2 sections', async () => {
    const text = CircuitJsonBoardviewExporter.export(
        await loadComponentDocument()
    )
    assert.match(text, /^0\nBRDOUT:/)
    for (const header of ['BRDOUT:', 'NETS:', 'PARTS:', 'PINS:', 'NAILS:']) {
        assert.ok(text.includes(header), `missing ${header}`)
    }
})

test('CircuitJsonBoardviewExporter section counts match their headers', async () => {
    const text = CircuitJsonBoardviewExporter.export(
        await loadComponentDocument()
    )
    const lines = text.split('\n').map((line) => line.trim())
    for (const header of ['BRDOUT:', 'NETS:', 'PARTS:', 'PINS:', 'NAILS:']) {
        const line = lines.find((row) => row.startsWith(header))
        const declared = Number(line.split(/\s+/)[1])
        assert.equal(sectionRows(text, header).length, declared)
    }
})

test('CircuitJsonBoardviewExporter names nets and references them from pins', async () => {
    const text = CircuitJsonBoardviewExporter.export(
        await loadComponentDocument()
    )
    const nets = new Map(
        sectionRows(text, 'NETS:').map((row) => [Number(row[0]), row[1]])
    )
    assert.ok([...nets.values()].includes('GND'))
    assert.ok([...nets.values()].includes('VCC'))
    const pinNets = sectionRows(text, 'PINS:').map((row) =>
        nets.get(Number(row[2]))
    )
    assert.deepEqual(new Set(pinNets), new Set(['GND', 'VCC']))
    assert.ok(sectionRows(text, 'PARTS:').some((row) => row[0] === 'U1'))
})

test('CircuitJsonBoardviewExporter keeps outline points within the reported bound', async () => {
    const text = CircuitJsonBoardviewExporter.export(
        await loadComponentDocument()
    )
    const header = text
        .split('\n')
        .find((line) => line.startsWith('BRDOUT:'))
        .split(/\s+/)
    const maxX = Number(header[2])
    const maxY = Number(header[3])
    for (const [x, y] of sectionRows(text, 'BRDOUT:')) {
        assert.ok(Number(x) >= 0 && Number(x) <= maxX)
        assert.ok(Number(y) >= 0 && Number(y) <= maxY)
    }
})

test('CircuitJsonBoardviewExporter decodes escaped part names', () => {
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
            y: 1,
            layer: 'top'
        }
    ]
    const parts = sectionRows(
        CircuitJsonBoardviewExporter.export(model),
        'PARTS:'
    )
    assert.equal(parts[0][0], 'REF**')
})
