import assert from 'node:assert/strict'
import test from 'node:test'

import polygonClipping from 'polygon-clipping'

import { GerberCircuitJsonPolygonUnion } from '../src/convergence/GerberCircuitJsonPolygonUnion.mjs'

/**
 * Creates one unclosed rectangular MultiPolygon operand.
 * @param {number} left Minimum X coordinate.
 * @param {number} bottom Minimum Y coordinate.
 * @param {number} right Maximum X coordinate.
 * @param {number} top Maximum Y coordinate.
 * @returns {number[][][][]} Rectangular MultiPolygon.
 */
function rectangle(left, bottom, right, top) {
    return [
        [
            [
                [left, bottom],
                [right, bottom],
                [right, top],
                [left, top]
            ]
        ]
    ]
}

/**
 * Returns one ring's unsigned area.
 * @param {number[][]} ring Polygon ring.
 * @returns {number} Ring area.
 */
function ringArea(ring) {
    let doubledArea = 0
    for (let index = 0; index < ring.length; index += 1) {
        const current = ring[index]
        const next = ring[(index + 1) % ring.length]
        doubledArea += current[0] * next[1] - next[0] * current[1]
    }
    return Math.abs(doubledArea) / 2
}

/**
 * Returns a MultiPolygon's area with inner rings subtracted.
 * @param {number[][][][]} geometry MultiPolygon geometry.
 * @returns {number} Geometry area.
 */
function geometryArea(geometry) {
    return geometry.reduce(
        (total, polygon) =>
            total +
            ringArea(polygon[0]) -
            polygon.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0),
        0
    )
}

test('partitionOverlapping keeps transitive bounds intersections together', () => {
    const operands = [
        rectangle(0, 0, 2, 2),
        rectangle(4, 0, 6, 2),
        rectangle(2, 1, 4, 1.5),
        rectangle(20, 20, 21, 21)
    ]

    const components =
        GerberCircuitJsonPolygonUnion.partitionOverlapping(operands)

    assert.deepEqual(components, [operands.slice(0, 3), [operands[3]]])
})

test('partitionOverlapping returns separated components in operand order', () => {
    const operands = [
        rectangle(0, 10, 10, 11),
        rectangle(1, 0, 2, 1),
        rectangle(3, 0, 4, 1)
    ]

    const components =
        GerberCircuitJsonPolygonUnion.partitionOverlapping(operands)

    assert.deepEqual(
        components,
        operands.map((operand) => [operand])
    )
})

test('union normalizes large disjoint batches without changing their area', () => {
    const operands = Array.from({ length: 300 }, (_, index) =>
        rectangle(index * 2, 0, index * 2 + 1, 1)
    )
    const expected = polygonClipping.union(...operands)

    const actual = GerberCircuitJsonPolygonUnion.union(operands)

    assert.equal(actual.length, operands.length)
    assert.equal(geometryArea(actual), geometryArea(expected))
    for (const polygon of actual) {
        for (const ring of polygon) {
            assert.deepEqual(ring[0], ring.at(-1))
        }
    }
})

test('partitionOverlapping falls back before a dense sweep becomes quadratic', () => {
    const operands = Array.from({ length: 600 }, (_, index) =>
        rectangle(0, index * 2, 1000, index * 2 + 1)
    )

    const components =
        GerberCircuitJsonPolygonUnion.partitionOverlapping(operands)

    assert.deepEqual(components, [operands])
})

test('union preserves malformed nested-empty geometry errors in large batches', () => {
    const operands = Array.from({ length: 257 }, (_, index) =>
        rectangle(index * 2, 0, index * 2 + 1, 1)
    )
    operands.splice(128, 0, [[]])

    assert.throws(
        () => GerberCircuitJsonPolygonUnion.union(operands),
        /Input geometry is not a valid Polygon or MultiPolygon/u
    )
})

test('union merges overlapping operands carrying sub-epsilon coordinate noise', () => {
    // Vertices that should coincide but differ by floating-point rounding are
    // what trip polygon-clipping's sweep line on real fabrication data. The
    // union of two overlapping rectangles must still collapse to the exact
    // merged region regardless of that noise.
    const noise = 1e-13
    const left = rectangle(0, 0, 10, 10)
    const right = rectangle(5 + noise, 0 - noise, 15, 10)

    const merged = GerberCircuitJsonPolygonUnion.union([left, right])

    assert.equal(merged.length, 1)
    assert.ok(Math.abs(geometryArea(merged) - 150) < 1e-3)
})

test('union stays correct when snapping is exercised across a large batch', () => {
    // A column of abutting rectangles with per-vertex noise exercises the
    // batched union path; the result is one tall bar of the expected area.
    const operands = Array.from({ length: 400 }, (_, index) => {
        const jitter = (index % 2 === 0 ? 1 : -1) * 1e-12
        return rectangle(0, index + jitter, 10, index + 1 + jitter)
    })

    const merged = GerberCircuitJsonPolygonUnion.union(operands)

    assert.ok(Math.abs(geometryArea(merged) - 4000) < 1e-1)
})
