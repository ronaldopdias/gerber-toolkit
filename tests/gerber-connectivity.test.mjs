import assert from 'node:assert/strict'
import test from 'node:test'

import { GerberCircuitJsonConnectivity } from '../src/convergence/GerberCircuitJsonConnectivity.mjs'

/**
 * Builds one straight bottom-layer trace on a named net.
 * @param {string} id Trace id.
 * @param {string} sourceTraceId Source trace id.
 * @param {number[][]} points Route points as [x, y] pairs.
 * @returns {object} pcb_trace element.
 */
function trace(id, sourceTraceId, points) {
    return {
        type: 'pcb_trace',
        pcb_trace_id: id,
        source_trace_id: sourceTraceId,
        route: points.map(([x, y]) => ({
            route_type: 'wire',
            x,
            y,
            width: 0.5,
            layer: 'bottom'
        }))
    }
}

/**
 * Builds one bottom-layer pad.
 * @param {string} id Pad id.
 * @param {number} x Center X.
 * @param {number} y Center Y.
 * @returns {object} pcb_smtpad element.
 */
function pad(id, x, y) {
    return {
        type: 'pcb_smtpad',
        pcb_smtpad_id: id,
        x,
        y,
        width: 0.6,
        height: 0.6,
        layer: 'bottom'
    }
}

test('connectivity names pads that share copper with a named trace', () => {
    const model = [
        { type: 'source_net', source_net_id: 'n1', name: 'VBUS' },
        {
            type: 'source_trace',
            source_trace_id: 't1',
            connected_source_net_ids: ['n1']
        },
        trace('pt1', 't1', [
            [0, 0],
            [5, 0]
        ]),
        pad('padA', 0, 0),
        pad('padB', 5, 0)
    ]
    const nets = GerberCircuitJsonConnectivity.assignPadNets(model)
    assert.equal(nets.get('padA'), 'VBUS')
    assert.equal(nets.get('padB'), 'VBUS')
})

test('connectivity separates pads that do not share copper', () => {
    const model = [
        { type: 'source_net', source_net_id: 'n1', name: 'VBUS' },
        {
            type: 'source_trace',
            source_trace_id: 't1',
            connected_source_net_ids: ['n1']
        },
        trace('pt1', 't1', [
            [0, 0],
            [5, 0]
        ]),
        pad('padA', 0, 0),
        pad('isolated', 100, 100)
    ]
    const nets = GerberCircuitJsonConnectivity.assignPadNets(model)
    assert.equal(nets.get('padA'), 'VBUS')
    assert.notEqual(nets.get('isolated'), 'VBUS')
    assert.match(nets.get('isolated'), /^Net_\d+$/)
})

test('connectivity never emits the N/C placeholder as a real name', () => {
    const model = [
        { type: 'source_net', source_net_id: 'nc', name: 'N/C' },
        {
            type: 'source_trace',
            source_trace_id: 't1',
            connected_source_net_ids: ['nc']
        },
        trace('pt1', 't1', [
            [0, 0],
            [5, 0]
        ]),
        pad('padA', 0, 0)
    ]
    const nets = GerberCircuitJsonConnectivity.assignPadNets(model)
    assert.match(nets.get('padA'), /^Net_\d+$/)
})

test('connectivity keeps unrelated nets on separate pads', () => {
    const model = [
        { type: 'source_net', source_net_id: 'g', name: 'GND' },
        { type: 'source_net', source_net_id: 'v', name: '3V3' },
        {
            type: 'source_trace',
            source_trace_id: 'tg',
            connected_source_net_ids: ['g']
        },
        {
            type: 'source_trace',
            source_trace_id: 'tv',
            connected_source_net_ids: ['v']
        },
        trace('ptg', 'tg', [
            [0, 0],
            [5, 0]
        ]),
        trace('ptv', 'tv', [
            [0, 50],
            [5, 50]
        ]),
        pad('padG', 0, 0),
        pad('padV', 5, 50)
    ]
    const nets = GerberCircuitJsonConnectivity.assignPadNets(model)
    assert.equal(nets.get('padG'), 'GND')
    assert.equal(nets.get('padV'), '3V3')
})

test('connectivity tolerates an empty model', () => {
    assert.equal(GerberCircuitJsonConnectivity.assignPadNets([]).size, 0)
})

test('connectivity net-tags a pour that a via ties to a named net', () => {
    // A bottom pad on GND sits under a top pour; the pour should inherit GND
    // through the via (the shared pad location).
    const model = [
        { type: 'source_net', source_net_id: 'g', name: 'GND' },
        {
            type: 'source_trace',
            source_trace_id: 'tg',
            connected_source_net_ids: ['g']
        },
        trace('ptg', 'tg', [
            [0, 0],
            [6, 0]
        ]),
        pad('padG', 3, 0),
        {
            type: 'pcb_copper_pour',
            pcb_copper_pour_id: 'topPour',
            layer: 'top',
            brep_shape: {
                outer_ring: {
                    vertices: [
                        { x: 0, y: -2 },
                        { x: 6, y: -2 },
                        { x: 6, y: 2 },
                        { x: 0, y: 2 }
                    ]
                }
            }
        }
    ]
    const pourNets = GerberCircuitJsonConnectivity.assignPourNets(model)
    assert.equal(pourNets.get('topPour'), 'GND')
})
