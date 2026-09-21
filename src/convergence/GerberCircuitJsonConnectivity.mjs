import { GerberCircuitJsonPolygonUnion } from './GerberCircuitJsonPolygonUnion.mjs'

/**
 * Derives per-pad net assignments from copper geometry.
 *
 * Bare Gerber packages rarely tie their flashed pads to a netlist, but the
 * copper itself encodes connectivity: pads, traces, and pours that touch are
 * galvanically one net. This class unions the copper per layer so each disjoint
 * region becomes one connected component, then labels every pad with the real
 * net name carried by any trace or pour in its component (falling back to a
 * stable synthetic `Net_N`). The result lets a boardview highlight every pad on
 * the same copper even when the source never named the net.
 *
 * Pads are named per layer from same-layer copper ({@link assignPadNets}).
 * Pours, which appear where a layer projects as filled copper instead of
 * traces, are named across layers ({@link assignPourNets}): each pad doubles as
 * a through-hole via that carries its net to the pour sitting over it.
 * Coordinates are treated in the document's own units.
 */
export class GerberCircuitJsonConnectivity {
    /**
     * Assigns a net name to every SMD pad from copper connectivity.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {Map<string, string>} Pad id to net name.
     */
    static assignPadNets(document) {
        const model = GerberCircuitJsonConnectivity.#model(document)
        const traceNet = GerberCircuitJsonConnectivity.#traceNetNames(model)
        const netNameBySource =
            GerberCircuitJsonConnectivity.#sourceNetNames(model)
        const layers = GerberCircuitJsonConnectivity.#collectByLayer(
            model,
            traceNet,
            netNameBySource
        )
        const assignment = new Map()
        let syntheticCounter = 0
        for (const layer of layers.values()) {
            syntheticCounter = GerberCircuitJsonConnectivity.#assignLayer(
                layer,
                assignment,
                syntheticCounter
            )
        }
        return assignment
    }

    /**
     * Assigns a net name to copper pours from cross-layer connectivity.
     *
     * A copper layer that projects as filled pours instead of traces carries no
     * trace-borne net names of its own, but on a through-hole board its copper
     * reaches the routed side through vias. Each pad doubles as a via, so its
     * net (from {@link assignPadNets}) seeds the pour component sitting over it;
     * unioning the pours per layer then spreads that net across every pour in
     * the same connected copper region. Named pours seed directly.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {Map<string, string>} Pour id to net name.
     */
    static assignPourNets(document) {
        const model = GerberCircuitJsonConnectivity.#model(document)
        const padNet = GerberCircuitJsonConnectivity.assignPadNets(model)
        const netNameBySource =
            GerberCircuitJsonConnectivity.#sourceNetNames(model)
        const vias = []
        for (const element of model) {
            if (element.type !== 'pcb_smtpad') continue
            const name = padNet.get(element.pcb_smtpad_id)
            if (GerberCircuitJsonConnectivity.#isRealNet(name)) {
                vias.push({ x: Number(element.x), y: Number(element.y), name })
            }
        }
        const byLayer = new Map()
        for (const element of model) {
            if (element.type !== 'pcb_copper_pour') continue
            const vertices =
                element.brep_shape?.outer_ring?.vertices ??
                element.shape?.outer_ring?.vertices
            if (!Array.isArray(vertices) || vertices.length < 3) continue
            const ring = vertices.map((vertex) => [
                Number(vertex.x),
                Number(vertex.y)
            ])
            const key = element.layer ?? 'top'
            if (!byLayer.has(key)) byLayer.set(key, [])
            const named = netNameBySource.get(element.source_net_id)
            byLayer.get(key).push({
                id: element.pcb_copper_pour_id,
                ring,
                name: GerberCircuitJsonConnectivity.#isRealNet(named)
                    ? named
                    : null
            })
        }
        const assignment = new Map()
        for (const pours of byLayer.values()) {
            GerberCircuitJsonConnectivity.#assignPourLayer(
                pours,
                vias,
                assignment
            )
        }
        return assignment
    }

    /**
     * Unions one layer's pours and labels each with a seeded net.
     * @param {{ id: string, ring: number[][], name: string|null }[]} pours Pours.
     * @param {{ x: number, y: number, name: string }[]} vias Via seed points.
     * @param {Map<string, string>} assignment Pour id to net accumulator.
     * @returns {void}
     */
    static #assignPourLayer(pours, vias, assignment) {
        const operands = pours.map((pour) => [[pour.ring]])
        let components = []
        try {
            components = GerberCircuitJsonPolygonUnion.union(operands)
        } catch {
            components = []
        }
        const boxes = components.map((polygon) =>
            GerberCircuitJsonConnectivity.#bounds(polygon[0])
        )
        const componentAt = (point) =>
            GerberCircuitJsonConnectivity.#componentAt(point, components, boxes)
        const names = new Map()
        const seed = (point, name) => {
            const component = componentAt(point)
            if (component >= 0 && !names.has(component)) {
                names.set(component, name)
            }
        }
        for (const pour of pours) {
            if (pour.name) {
                seed(
                    GerberCircuitJsonConnectivity.#centroid(pour.ring),
                    pour.name
                )
            }
        }
        for (const via of vias) {
            seed([via.x, via.y], via.name)
        }
        for (const pour of pours) {
            const component = componentAt(
                GerberCircuitJsonConnectivity.#centroid(pour.ring)
            )
            const name =
                (component >= 0 ? names.get(component) : null) ?? pour.name
            if (name) assignment.set(pour.id, name)
        }
    }

    /**
     * Returns the centroid of a ring.
     * @param {number[][]} ring Polygon ring.
     * @returns {number[]} Centroid point.
     */
    static #centroid(ring) {
        let sumX = 0
        let sumY = 0
        for (const point of ring) {
            sumX += point[0]
            sumY += point[1]
        }
        return [sumX / ring.length, sumY / ring.length]
    }

    /**
     * Resolves the CircuitJSON model array from any accepted input shape.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {object[]} Model element array.
     */
    static #model(document) {
        if (Array.isArray(document)) return document
        if (Array.isArray(document?.model)) return document.model
        return []
    }

    /**
     * Returns whether one net name is a usable, non-placeholder label.
     * @param {unknown} name Candidate net name.
     * @returns {boolean} True when the name is real.
     */
    static #isRealNet(name) {
        return (
            typeof name === 'string' &&
            name.trim() !== '' &&
            name.toUpperCase() !== 'N/C'
        )
    }

    /**
     * Maps source net ids to their names.
     * @param {object[]} model Model element array.
     * @returns {Map<string, string>} Net name by source net id.
     */
    static #sourceNetNames(model) {
        const map = new Map()
        for (const element of model) {
            if (element.type === 'source_net') {
                map.set(element.source_net_id, element.name ?? '')
            }
        }
        return map
    }

    /**
     * Maps source trace ids to a real net name.
     * @param {object[]} model Model element array.
     * @returns {Map<string, string>} Net name by source trace id.
     */
    static #traceNetNames(model) {
        const netNameBySource =
            GerberCircuitJsonConnectivity.#sourceNetNames(model)
        const map = new Map()
        for (const element of model) {
            if (element.type !== 'source_trace') continue
            const name = netNameBySource.get(
                element.connected_source_net_ids?.[0]
            )
            if (GerberCircuitJsonConnectivity.#isRealNet(name)) {
                map.set(element.source_trace_id, name)
            }
        }
        return map
    }

    /**
     * Builds per-layer copper operands, name tags, and pad references.
     * @param {object[]} model Model element array.
     * @param {Map<string, string>} traceNet Net name by source trace id.
     * @param {Map<string, string>} netNameBySource Net name by source net id.
     * @returns {Map<string, { operands: number[][][][][], tags: (string|null)[], samples: (number[]|null)[], pads: object[] }>} Layer buckets.
     */
    static #collectByLayer(model, traceNet, netNameBySource) {
        const layers = new Map()
        const bucket = (layer) => {
            const key = layer ?? 'top'
            if (!layers.has(key)) {
                layers.set(key, {
                    operands: [],
                    tags: [],
                    samples: [],
                    pads: []
                })
            }
            return layers.get(key)
        }
        for (const element of model) {
            if (element.type === 'pcb_smtpad') {
                const layer = bucket(element.layer)
                layer.pads.push(element)
                layer.operands.push(
                    GerberCircuitJsonConnectivity.#padPolygon(element)
                )
                layer.tags.push(null)
                layer.samples.push([Number(element.x), Number(element.y)])
            } else if (element.type === 'pcb_trace') {
                GerberCircuitJsonConnectivity.#addTrace(
                    element,
                    traceNet,
                    bucket
                )
            } else if (element.type === 'pcb_copper_pour') {
                GerberCircuitJsonConnectivity.#addPour(
                    element,
                    netNameBySource,
                    bucket
                )
            }
        }
        return layers
    }

    /**
     * Adds one trace's stroked segments to its layer bucket.
     * @param {object} trace Trace element.
     * @param {Map<string, string>} traceNet Net name by source trace id.
     * @param {(layer: string) => object} bucket Layer bucket accessor.
     * @returns {void}
     */
    static #addTrace(trace, traceNet, bucket) {
        const route = Array.isArray(trace.route) ? trace.route : []
        const name = traceNet.get(trace.source_trace_id) ?? null
        for (let index = 0; index + 1 < route.length; index += 1) {
            const start = route[index]
            const end = route[index + 1]
            const layer = bucket(start.layer)
            layer.operands.push(
                GerberCircuitJsonConnectivity.#segmentPolygon(
                    start,
                    end,
                    start.width || 0.15
                )
            )
            layer.tags.push(name)
            layer.samples.push([
                (Number(start.x) + Number(end.x)) / 2,
                (Number(start.y) + Number(end.y)) / 2
            ])
        }
    }

    /**
     * Adds one copper pour outline to its layer bucket.
     * @param {object} pour Copper pour element.
     * @param {Map<string, string>} netNameBySource Net name by source net id.
     * @param {(layer: string) => object} bucket Layer bucket accessor.
     * @returns {void}
     */
    static #addPour(pour, netNameBySource, bucket) {
        const vertices =
            pour.brep_shape?.outer_ring?.vertices ??
            pour.shape?.outer_ring?.vertices
        if (!Array.isArray(vertices) || vertices.length < 3) return
        const ring = vertices.map((vertex) => [
            Number(vertex.x),
            Number(vertex.y)
        ])
        const name = netNameBySource.get(pour.source_net_id)
        const layer = bucket(pour.layer)
        layer.operands.push([[ring]])
        layer.tags.push(
            GerberCircuitJsonConnectivity.#isRealNet(name) ? name : null
        )
        layer.samples.push(
            GerberCircuitJsonConnectivity.#ringInteriorPoint(ring)
        )
    }

    /**
     * Unions one layer's copper and labels its pads in place.
     * @param {{ operands: number[][][][][], tags: (string|null)[], samples: (number[]|null)[], pads: object[] }} layer Layer bucket.
     * @param {Map<string, string>} assignment Pad id to net name accumulator.
     * @param {number} syntheticCounter Running synthetic net counter.
     * @returns {number} Updated synthetic counter.
     */
    static #assignLayer(layer, assignment, syntheticCounter) {
        if (layer.pads.length === 0) return syntheticCounter
        let components = []
        try {
            components = GerberCircuitJsonPolygonUnion.union(layer.operands)
        } catch {
            components = []
        }
        const boxes = components.map((polygon) =>
            GerberCircuitJsonConnectivity.#bounds(polygon[0])
        )
        const componentAt = (point) =>
            GerberCircuitJsonConnectivity.#componentAt(point, components, boxes)
        const names = new Map()
        for (let index = 0; index < layer.operands.length; index += 1) {
            const tag = layer.tags[index]
            const sample = layer.samples[index]
            if (!tag || !sample) continue
            const component = componentAt(sample)
            if (component >= 0 && !names.has(component)) {
                names.set(component, tag)
            }
        }
        let counter = syntheticCounter
        for (const pad of layer.pads) {
            const component = componentAt([Number(pad.x), Number(pad.y)])
            if (component < 0) {
                counter += 1
                assignment.set(pad.pcb_smtpad_id, `Net_${counter}`)
                continue
            }
            let name = names.get(component)
            if (!name) {
                counter += 1
                name = `Net_${counter}`
                names.set(component, name)
            }
            assignment.set(pad.pcb_smtpad_id, name)
        }
        return counter
    }

    /**
     * Finds the index of the component polygon containing one point.
     * @param {number[]} point Query point.
     * @param {number[][][][]} components Component polygons.
     * @param {({ minX: number, minY: number, maxX: number, maxY: number }|null)[]} boxes Component bounds.
     * @returns {number} Component index or -1.
     */
    static #componentAt(point, components, boxes) {
        for (let index = 0; index < components.length; index += 1) {
            const box = boxes[index]
            if (
                box === null ||
                point[0] < box.minX ||
                point[0] > box.maxX ||
                point[1] < box.minY ||
                point[1] > box.maxY
            ) {
                continue
            }
            if (
                GerberCircuitJsonConnectivity.#pointInRing(
                    point,
                    components[index][0]
                )
            ) {
                return index
            }
        }
        return -1
    }

    /**
     * Builds a pad rectangle polygon.
     * @param {object} pad Pad element.
     * @returns {number[][][][]} MultiPolygon for the pad.
     */
    static #padPolygon(pad) {
        const halfWidth = (Number(pad.width) || 0.2) / 2
        const halfHeight = (Number(pad.height) || 0.2) / 2
        const x = Number(pad.x)
        const y = Number(pad.y)
        return [
            [
                [
                    [x - halfWidth, y - halfHeight],
                    [x + halfWidth, y - halfHeight],
                    [x + halfWidth, y + halfHeight],
                    [x - halfWidth, y + halfHeight]
                ]
            ]
        ]
    }

    /**
     * Builds a stroked rectangle polygon for one trace segment.
     * @param {object} start Segment start point.
     * @param {object} end Segment end point.
     * @param {number} width Stroke width.
     * @returns {number[][][][]} MultiPolygon for the segment.
     */
    static #segmentPolygon(start, end, width) {
        const ax = Number(start.x)
        const ay = Number(start.y)
        const bx = Number(end.x)
        const by = Number(end.y)
        const dx = bx - ax
        const dy = by - ay
        const length = Math.hypot(dx, dy) || 1e-9
        const ux = dx / length
        const uy = dy / length
        const half = width / 2
        const px = -uy * half
        const py = ux * half
        // Extend each end by a half-width so abutting segments overlap and merge.
        const ex = ux * half
        const ey = uy * half
        return [
            [
                [
                    [ax - ex + px, ay - ey + py],
                    [bx + ex + px, by + ey + py],
                    [bx + ex - px, by + ey - py],
                    [ax - ex - px, ay - ey - py]
                ]
            ]
        ]
    }

    /**
     * Returns a point on the interior side of a ring's first edge.
     * @param {number[][]} ring Polygon ring.
     * @returns {number[]|null} Interior-biased sample point.
     */
    static #ringInteriorPoint(ring) {
        if (ring.length < 3) return null
        const centroidX =
            ring.reduce((sum, point) => sum + point[0], 0) / ring.length
        const centroidY =
            ring.reduce((sum, point) => sum + point[1], 0) / ring.length
        return [centroidX, centroidY]
    }

    /**
     * Computes the bounding box of a ring.
     * @param {number[][]} ring Polygon ring.
     * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null} Bounds.
     */
    static #bounds(ring) {
        if (!Array.isArray(ring) || ring.length === 0) return null
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const point of ring) {
            minX = Math.min(minX, point[0])
            minY = Math.min(minY, point[1])
            maxX = Math.max(maxX, point[0])
            maxY = Math.max(maxY, point[1])
        }
        return { minX, minY, maxX, maxY }
    }

    /**
     * Tests whether one point lies inside a ring (even-odd rule).
     * @param {number[]} point Query point.
     * @param {number[][]} ring Polygon ring.
     * @returns {boolean} True when the point is inside.
     */
    static #pointInRing(point, ring) {
        let inside = false
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0]
            const yi = ring[i][1]
            const xj = ring[j][0]
            const yj = ring[j][1]
            const straddles = yi > point[1] !== yj > point[1]
            if (
                straddles &&
                point[0] <
                    ((xj - xi) * (point[1] - yi)) / (yj - yi || 1e-12) + xi
            ) {
                inside = !inside
            }
        }
        return inside
    }
}
