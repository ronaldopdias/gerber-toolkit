import assert from 'node:assert/strict'
import test from 'node:test'

import { ProjectLoader } from '../src/index.mjs'

/**
 * Encodes a text fixture as an ArrayBuffer.
 * @param {string} text Fixture text.
 * @returns {ArrayBuffer}
 */
function bytes(text) {
    return new TextEncoder().encode(text).buffer
}

/**
 * Loads a package whose plated through-holes are a gerber-format drill file.
 * @returns {Promise<object[]>} Canonical model.
 */
async function loadDrilledModel() {
    const copper = [
        '%FSLAX34Y34*%',
        '%MOMM*%',
        '%TF.FileFunction,Copper,L1,Top*%',
        '%ADD10C,1.000*%',
        'D10*',
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
        'X0300000Y000000D01*',
        'X0300000Y0200000D01*',
        'X000000Y0200000D01*',
        'X000000Y000000D01*',
        'G37*',
        'M02*'
    ].join('\n')
    const drill = [
        '%FSLAX34Y34*%',
        '%MOMM*%',
        '%TF.FileFunction,Plated,1,2,PTH,Drill*%',
        '%TA.AperFunction,ViaDrill*%',
        '%ADD10C,0.400*%',
        'D10*',
        'X0100000Y0100000D03*',
        'X0200000Y0100000D03*',
        'M02*'
    ].join('\n')
    const project = await ProjectLoader.loadAsync(
        [
            { name: 'board-F_Cu.gtl', data: bytes(copper) },
            { name: 'board-Edge_Cuts.gm1', data: bytes(outline) },
            { name: 'board-PTH.gbr', data: bytes(drill) }
        ],
        { worker: false }
    )
    return project.documents[0].model
}

test('gerber-format drill flashes project to plated holes', async () => {
    const model = await loadDrilledModel()
    const holes = model.filter(
        (element) => element.type === 'pcb_plated_hole'
    )
    assert.equal(holes.length, 2)
    for (const hole of holes) {
        assert.equal(hole.shape, 'circle')
        assert.ok(Math.abs(hole.hole_diameter - 0.4) < 1e-6)
        assert.deepEqual(hole.layers, ['top', 'bottom'])
    }
})

test('plated holes sit at the drilled coordinates', async () => {
    const model = await loadDrilledModel()
    const centres = model
        .filter((element) => element.type === 'pcb_plated_hole')
        .map((hole) => `${hole.x.toFixed(1)},${hole.y.toFixed(1)}`)
        .sort()
    assert.deepEqual(centres, ['10.0,10.0', '20.0,10.0'])
})
