import assert from 'node:assert/strict'
import test from 'node:test'

import { ProjectLoader } from '../src/index.mjs'
import { ConversionService } from '../gui/ConversionService.mjs'
import { unzipSync } from 'fflate'

/**
 * Encodes a text fixture as an ArrayBuffer.
 * @param {string} text Fixture text.
 * @returns {ArrayBuffer}
 */
function bytes(text) {
    return new TextEncoder().encode(text).buffer
}

/**
 * Loads one synthetic fabrication project and returns its document.
 * @param {object[]} entries Project entries.
 * @returns {Promise<object>} Canonical document envelope.
 */
async function loadDocument(entries) {
    const project = await ProjectLoader.loadAsync(entries, { worker: false })
    return project.documents[0]
}

/**
 * Builds one plain copper/outline/drill fabrication package without X2
 * component metadata.
 * @param {object[]} entries Extra entries merged into the package.
 * @returns {Promise<object>} Canonical document envelope.
 */
async function loadPlainDocument(entries = []) {
    const copper = [
        '%FSLAX34Y34*%',
        '%MOMM*%',
        '%ADD10C,0.200*%',
        'D10*',
        'X000000Y000000D02*',
        'X0500000Y000000D01*',
        'X0500000Y0300000D01*',
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
    const drill = [
        'M48',
        'METRIC',
        'T1C0.800',
        '%',
        'T1',
        'X10.0Y10.0',
        'M30',
        ''
    ].join('\n')
    return loadDocument([
        { name: 'sample-F_Cu.gtl', data: bytes(copper) },
        { name: 'sample-Edge_Cuts.gm1', data: bytes(outline) },
        { name: 'sample-PTH.drl', data: bytes(drill) },
        ...entries
    ])
}

/**
 * Builds one X2 Gerber package that carries explicit component ownership.
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
    return loadDocument([
        { name: 'board-F_Cu.gtl', data: bytes(top) },
        { name: 'board-Edge_Cuts.gm1', data: bytes(outline) }
    ])
}

test('ConversionService lists every supported conversion target', async () => {
    const document = await loadPlainDocument()
    const rows = ConversionService.listTargets(document)
    assert.deepEqual(
        rows.map((row) => row.id),
        [
            'circuitjson',
            'pcb-svg',
            'pcb-layers-svg-zip',
            'bom-html',
            'scene3d-json',
            'pick-place-csv',
            'fabrication-notes-json',
            'routing-dsn',
            'boardview-brd',
            'kicad-pcb'
        ]
    )
    for (const row of rows) {
        assert.ok(row.fileName.length > 0)
        assert.ok(row.mediaType.includes('/'))
    }
})

test('ConversionService reports honest availability for metadata exports', async () => {
    const document = await loadPlainDocument()
    const byId = new Map(
        ConversionService.listTargets(document).map((row) => [row.id, row])
    )
    assert.equal(byId.get('circuitjson').status, 'available')
    assert.equal(byId.get('pcb-svg').status, 'available')
    assert.equal(byId.get('bom-html').status, 'available')
    assert.equal(byId.get('scene3d-json').status, 'available')
    assert.equal(byId.get('pick-place-csv').status, 'unavailable')
    assert.match(byId.get('pick-place-csv').reason, /placement/i)
    assert.equal(byId.get('routing-dsn').status, 'available')
})

test('ConversionService converts the CircuitJSON model', async () => {
    const document = await loadPlainDocument()
    const result = ConversionService.convert(document, 'circuitjson')
    assert.equal(result.ok, true)
    assert.equal(result.fileName, 'fabrication-package.circuit.json')
    const model = JSON.parse(new TextDecoder().decode(result.data))
    assert.ok(Array.isArray(model))
    assert.ok(model.length > 0)
})

test('ConversionService converts the combined PCB SVG', async () => {
    const document = await loadPlainDocument()
    const result = ConversionService.convert(document, 'pcb-svg')
    assert.equal(result.ok, true)
    assert.equal(result.fileName, 'fabrication-package.pcb.svg')
    assert.match(new TextDecoder().decode(result.data), /^<svg/)
})

test('ConversionService converts one SVG per layer as a ZIP archive', async () => {
    const document = await loadPlainDocument()
    const result = ConversionService.convert(document, 'pcb-layers-svg-zip')
    assert.equal(result.ok, true)
    assert.equal(result.mediaType, 'application/zip')
    const entries = unzipSync(result.data)
    const names = Object.keys(entries)
    assert.ok(names.includes('top_copper.svg'))
    for (const name of names) {
        assert.match(new TextDecoder().decode(entries[name]), /^<svg/)
    }
})

test('ConversionService converts the BOM HTML document', async () => {
    const document = await loadPlainDocument()
    const result = ConversionService.convert(document, 'bom-html')
    assert.equal(result.ok, true)
    assert.match(new TextDecoder().decode(result.data), /^</)
})

test('ConversionService converts the 3D scene JSON', async () => {
    const document = await loadPlainDocument()
    const result = ConversionService.convert(document, 'scene3d-json')
    assert.equal(result.ok, true)
    const scene = JSON.parse(new TextDecoder().decode(result.data))
    assert.ok(scene.schema)
    assert.ok(scene.board)
})

test('ConversionService exports manufacturing files when metadata exists', async () => {
    const document = await loadComponentDocument()
    const csv = ConversionService.convert(document, 'pick-place-csv')
    assert.equal(csv.ok, true)
    const csvText = new TextDecoder().decode(csv.data)
    assert.ok(csvText.startsWith('Designator'))
    const dsn = ConversionService.convert(document, 'routing-dsn')
    assert.equal(dsn.ok, true)
    assert.ok(new TextDecoder().decode(dsn.data).length > 0)
})

test('ConversionService reports unavailable manufacturing exports without throwing', async () => {
    const document = await loadPlainDocument()
    const result = ConversionService.convert(document, 'pick-place-csv')
    assert.equal(result.ok, false)
    assert.ok(result.reason.length > 0)
})

test('ConversionService rejects unknown conversion targets', async () => {
    const document = await loadPlainDocument()
    const result = ConversionService.convert(document, 'stl')
    assert.equal(result.ok, false)
    assert.match(result.reason, /Unknown conversion target/)
})

test('ConversionService bundles every available output into one ZIP', async () => {
    const document = await loadPlainDocument()
    const result = ConversionService.bundleAll(document)
    assert.equal(result.ok, true)
    assert.equal(result.mediaType, 'application/zip')
    assert.equal(result.fileName, 'fabrication-package-outputs.zip')
    const entries = unzipSync(result.data)
    const names = Object.keys(entries)
    assert.ok(names.includes('fabrication-package.circuit.json'))
    assert.ok(names.includes('fabrication-package.pcb.svg'))
    assert.ok(names.includes('fabrication-package.bom.html'))
    // Unavailable metadata exports are skipped, not fabricated into the bundle.
    assert.ok(!names.some((name) => name.includes('pick-place')))
    assert.ok(result.included.includes('circuitjson'))
    assert.ok(result.skipped.includes('pick-place-csv'))
})

test('ConversionService bundle includes manufacturing outputs when metadata exists', async () => {
    const document = await loadComponentDocument()
    const result = ConversionService.bundleAll(document)
    assert.equal(result.ok, true)
    const names = Object.keys(unzipSync(result.data))
    assert.ok(names.some((name) => name.endsWith('-pick-place.csv')))
    assert.ok(names.some((name) => name.endsWith('-routing.dsn')))
})

test('ConversionService offers boardview only when component data exists', async () => {
    const plain = ConversionService.listTargets(await loadPlainDocument())
    const plainRow = plain.find((row) => row.id === 'boardview-brd')
    assert.equal(plainRow.status, 'unavailable')
    assert.match(plainRow.reason, /component/i)

    const component = ConversionService.listTargets(
        await loadComponentDocument()
    )
    assert.equal(
        component.find((row) => row.id === 'boardview-brd').status,
        'available'
    )
})

test('ConversionService converts an OpenBoardView .brd boardview file', async () => {
    const document = await loadComponentDocument()
    const result = ConversionService.convert(document, 'boardview-brd')
    assert.equal(result.ok, true)
    assert.ok(result.fileName.endsWith('.brd'))
    const text = new TextDecoder().decode(result.data)
    assert.match(text, /^0\nBRDOUT:/)
    assert.ok(text.includes('U1'))
    assert.ok(text.includes('GND'))
})
