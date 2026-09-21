import { GerberCircuitJsonConnectivity } from './GerberCircuitJsonConnectivity.mjs'

/**
 * Exports a canonical CircuitJSON document to a KiCad PCB (`.kicad_pcb`) file.
 *
 * Unlike the pads-and-nets boardview formats, `.kicad_pcb` carries copper
 * geometry, so tools that read it (KiCad, BVSense, and other repair viewers)
 * can render the actual traces and pours. This exporter emits the board outline
 * on `Edge.Cuts`, every trace as a copper track segment, every pour as a filled
 * graphic polygon, and every pad as a single-pad footprint. Traces and pads are
 * tagged with nets derived from copper connectivity so the copper is both
 * visible and net-aware.
 *
 * Coordinates are millimetres with the Y axis negated into KiCad's downward
 * convention. Bottom-layer copper maps to `B.Cu` and top-layer copper to `F.Cu`.
 */
export class CircuitJsonKicadPcbExporter {
    /**
     * Renders one CircuitJSON document as KiCad PCB text.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {string} `.kicad_pcb` s-expression text.
     */
    static export(document) {
        const model = CircuitJsonKicadPcbExporter.#model(document)
        const nets = CircuitJsonKicadPcbExporter.#netTable(model)
        const uuid = CircuitJsonKicadPcbExporter.#uuidFactory()
        const body = [
            CircuitJsonKicadPcbExporter.#header(nets),
            CircuitJsonKicadPcbExporter.#outline(model, uuid),
            CircuitJsonKicadPcbExporter.#segments(model, nets, uuid),
            CircuitJsonKicadPcbExporter.#pours(model, uuid),
            CircuitJsonKicadPcbExporter.#footprints(model, nets, uuid)
        ]
            .filter((section) => section.length)
            .join('\n')
        return `(kicad_pcb\n${body}\n)\n`
    }

    /**
     * Reports whether one document carries copper a KiCad PCB can show.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {boolean} True when copper geometry exists.
     */
    static hasCopper(document) {
        return CircuitJsonKicadPcbExporter.#model(document).some(
            (element) =>
                element.type === 'pcb_trace' ||
                element.type === 'pcb_smtpad' ||
                element.type === 'pcb_copper_pour'
        )
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
     * Builds the net-name-to-id table and the resolvers each element uses.
     * @param {object[]} model Model element array.
     * @returns {{ order: [string, number][], idFor: (name: string) => number, trace: (trace: object) => string, pour: (pour: object) => string, pad: (pad: object) => string }} Net table.
     */
    static #netTable(model) {
        const netNameBySource = new Map()
        for (const element of model) {
            if (element.type === 'source_net') {
                netNameBySource.set(element.source_net_id, element.name ?? '')
            }
        }
        const traceNames = new Map()
        for (const element of model) {
            if (element.type !== 'source_trace') continue
            const name = netNameBySource.get(
                element.connected_source_net_ids?.[0]
            )
            if (CircuitJsonKicadPcbExporter.#isRealNet(name)) {
                traceNames.set(element.source_trace_id, name)
            }
        }
        const padNames = GerberCircuitJsonConnectivity.assignPadNets(model)
        const ids = new Map([['', 0]])
        const register = (name) => {
            if (
                CircuitJsonKicadPcbExporter.#isRealNet(name) &&
                !ids.has(name)
            ) {
                ids.set(name, ids.size)
            }
        }
        const traceNameOf = (trace) =>
            traceNames.get(trace.source_trace_id) ?? ''
        const pourNameOf = (pour) => {
            const name = netNameBySource.get(pour.source_net_id)
            return CircuitJsonKicadPcbExporter.#isRealNet(name) ? name : ''
        }
        const padNameOf = (pad) => padNames.get(pad.pcb_smtpad_id) ?? ''
        for (const element of model) {
            if (element.type === 'pcb_trace') register(traceNameOf(element))
            else if (element.type === 'pcb_copper_pour')
                register(pourNameOf(element))
            else if (element.type === 'pcb_smtpad') register(padNameOf(element))
        }
        const idFor = (name) => ids.get(name) ?? 0
        return {
            order: [...ids.entries()].sort((left, right) => left[1] - right[1]),
            idFor,
            trace: (trace) => traceNameOf(trace),
            pour: (pour) => pourNameOf(pour),
            pad: (pad) => padNameOf(pad)
        }
    }

    /**
     * Builds the file header: version, layers, and net declarations.
     * @param {object} nets Net table.
     * @returns {string} Header text.
     */
    static #header(nets) {
        const netLines = nets.order
            .map(
                ([name, id]) =>
                    `  (net ${id} "${CircuitJsonKicadPcbExporter.#escape(name)}")`
            )
            .join('\n')
        return [
            '  (version 20221018)',
            '  (generator "gerber-toolkit")',
            '  (general (thickness 1.6))',
            '  (paper "A4")',
            '  (layers',
            '    (0 "F.Cu" signal)',
            '    (31 "B.Cu" signal)',
            '    (44 "Edge.Cuts" user)',
            '  )',
            '  (setup (pad_to_mask_clearance 0))',
            netLines
        ].join('\n')
    }

    /**
     * Emits the board outline as Edge.Cuts line segments.
     * @param {object[]} model Model element array.
     * @param {() => string} uuid UUID factory.
     * @returns {string} Outline text.
     */
    static #outline(model, uuid) {
        const board = model.find((element) => element.type === 'pcb_board')
        const points = board?.outline ?? []
        if (points.length < 2) return ''
        const lines = []
        for (let index = 0; index < points.length; index += 1) {
            const start = points[index]
            const end = points[(index + 1) % points.length]
            lines.push(
                `  (gr_line (start ${CircuitJsonKicadPcbExporter.#xy(start)}) (end ${CircuitJsonKicadPcbExporter.#xy(end)}) (layer "Edge.Cuts") (width 0.1) (uuid "${uuid()}"))`
            )
        }
        return lines.join('\n')
    }

    /**
     * Emits every trace as copper track segments.
     * @param {object[]} model Model element array.
     * @param {object} nets Net table.
     * @param {() => string} uuid UUID factory.
     * @returns {string} Segment text.
     */
    static #segments(model, nets, uuid) {
        const lines = []
        for (const element of model) {
            if (element.type !== 'pcb_trace') continue
            const netId = nets.idFor(nets.trace(element))
            const route = Array.isArray(element.route) ? element.route : []
            for (let index = 0; index + 1 < route.length; index += 1) {
                const start = route[index]
                const end = route[index + 1]
                const layer = CircuitJsonKicadPcbExporter.#layer(start.layer)
                lines.push(
                    `  (segment (start ${CircuitJsonKicadPcbExporter.#xy(start)}) (end ${CircuitJsonKicadPcbExporter.#xy(end)}) (width ${CircuitJsonKicadPcbExporter.#round(start.width || 0.15)}) (layer "${layer}") (net ${netId}) (uuid "${uuid()}"))`
                )
            }
        }
        return lines.join('\n')
    }

    /**
     * Emits every copper pour as a filled graphic polygon.
     *
     * Pours are drawn as `gr_poly` rather than KiCad zones: a zone forces a
     * fill recomputation that hangs or crashes on the many small, degenerate
     * pour rings that come out of Gerber projection, whereas a filled graphic
     * just renders the copper shape. Rings are cleaned of repeated points and
     * skipped when fewer than three distinct vertices remain.
     * @param {object[]} model Model element array.
     * @param {() => string} uuid UUID factory.
     * @returns {string} Pour graphic text.
     */
    static #pours(model, uuid) {
        const lines = []
        for (const element of model) {
            if (element.type !== 'pcb_copper_pour') continue
            const vertices =
                element.brep_shape?.outer_ring?.vertices ??
                element.shape?.outer_ring?.vertices
            const ring = CircuitJsonKicadPcbExporter.#cleanRing(vertices)
            if (ring.length < 3) continue
            const layer = CircuitJsonKicadPcbExporter.#layer(element.layer)
            const pts = ring
                .map(
                    (vertex) =>
                        `(xy ${CircuitJsonKicadPcbExporter.#xy(vertex)})`
                )
                .join(' ')
            lines.push(
                `  (gr_poly (pts ${pts}) (layer "${layer}") (width 0) (fill solid) (uuid "${uuid()}"))`
            )
        }
        return lines.join('\n')
    }

    /**
     * Removes repeated consecutive vertices from one ring.
     * @param {{ x: number, y: number }[]} vertices Ring vertices.
     * @returns {{ x: number, y: number }[]} Cleaned vertices.
     */
    static #cleanRing(vertices) {
        if (!Array.isArray(vertices)) return []
        const cleaned = []
        for (const vertex of vertices) {
            const previous = cleaned[cleaned.length - 1]
            if (
                !previous ||
                Math.abs(previous.x - vertex.x) > 1e-6 ||
                Math.abs(previous.y - vertex.y) > 1e-6
            ) {
                cleaned.push({ x: Number(vertex.x), y: Number(vertex.y) })
            }
        }
        const first = cleaned[0]
        const last = cleaned[cleaned.length - 1]
        if (
            cleaned.length > 1 &&
            first &&
            Math.abs(first.x - last.x) <= 1e-6 &&
            Math.abs(first.y - last.y) <= 1e-6
        ) {
            cleaned.pop()
        }
        return cleaned
    }

    /**
     * Emits every pad as a one-pad footprint tagged with its net.
     * @param {object[]} model Model element array.
     * @param {object} nets Net table.
     * @param {() => string} uuid UUID factory.
     * @returns {string} Footprint text.
     */
    static #footprints(model, nets, uuid) {
        const lines = []
        let index = 0
        for (const element of model) {
            if (element.type !== 'pcb_smtpad') continue
            index += 1
            const layer = CircuitJsonKicadPcbExporter.#layer(element.layer)
            const name = nets.pad(element)
            const netId = nets.idFor(name)
            const shape = element.shape === 'circle' ? 'circle' : 'rect'
            const width = CircuitJsonKicadPcbExporter.#round(
                element.width || 0.2
            )
            const height = CircuitJsonKicadPcbExporter.#round(
                element.height || element.width || 0.2
            )
            lines.push(
                [
                    `  (footprint "gerber-toolkit:pad${index}" (layer "${layer}") (at ${CircuitJsonKicadPcbExporter.#xy(element)}) (uuid "${uuid()}")`,
                    `    (attr smd)`,
                    `    (pad "1" smd ${shape} (at 0 0) (size ${width} ${height}) (layers "${layer}") (net ${netId} "${CircuitJsonKicadPcbExporter.#escape(name)}") (uuid "${uuid()}"))`,
                    `  )`
                ].join('\n')
            )
        }
        return lines.join('\n')
    }

    /**
     * Maps a CircuitJSON layer name to a KiCad copper layer.
     * @param {string} layer CircuitJSON layer name.
     * @returns {string} KiCad layer name.
     */
    static #layer(layer) {
        return layer === 'top' ? 'F.Cu' : 'B.Cu'
    }

    /**
     * Formats one point as KiCad `x y` millimetres with a negated Y axis.
     * @param {{ x: number, y: number }} point Point with mm coordinates.
     * @returns {string} Formatted coordinate pair.
     */
    static #xy(point) {
        return `${CircuitJsonKicadPcbExporter.#round(Number(point.x))} ${CircuitJsonKicadPcbExporter.#round(-Number(point.y))}`
    }

    /**
     * Rounds one value to KiCad's six-decimal resolution.
     * @param {number} value Millimetre value.
     * @returns {number} Rounded value.
     */
    static #round(value) {
        return Math.round(value * 1e6) / 1e6
    }

    /**
     * Escapes a string for a KiCad quoted token.
     * @param {string} value Raw string.
     * @returns {string} Escaped string.
     */
    static #escape(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    }

    /**
     * Builds a deterministic UUID factory for unique element ids.
     * @returns {() => string} UUID generator.
     */
    static #uuidFactory() {
        let counter = 0
        return () => {
            counter += 1
            const hex = counter.toString(16).padStart(12, '0')
            return `00000000-0000-0000-0000-${hex}`
        }
    }
}
