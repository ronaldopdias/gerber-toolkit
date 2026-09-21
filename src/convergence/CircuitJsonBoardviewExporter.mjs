import { GerberCircuitJsonConnectivity } from './GerberCircuitJsonConnectivity.mjs'

// Millimetres to mils (thousandths of an inch); boardview coordinates are mils.
const MM_TO_MIL = 39.37007874015748

/**
 * Exports a canonical CircuitJSON document to the OpenBoardView / FlexBV BRD2
 * boardview format (the `BRDOUT:` / `NETS:` / `PARTS:` / `PINS:` ASCII form
 * that OpenBoardView reads natively).
 *
 * The format is space-delimited and section-oriented. Coordinates are emitted
 * in mils, normalised so the board sits in the first quadrant with `BRDOUT`
 * reporting the top-right bound (the parser requires every outline point to
 * fall within it). Pins reference nets by integer id from the `NETS` table.
 * Bottom-side pins and parts are stored so the parser's own bottom-side Y flip
 * lands them back in registration with the outline. Pins are ordered by part,
 * and each part records the index of its first pin.
 *
 * Net names come from copper connectivity (see
 * {@link GerberCircuitJsonConnectivity}); reference designators and pin names
 * come from component metadata when the source carries it.
 */
export class CircuitJsonBoardviewExporter {
    /**
     * Renders one CircuitJSON document as OpenBoardView BRD2 text.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {string} BRD2 boardview text.
     */
    static export(document) {
        const model = CircuitJsonBoardviewExporter.#model(document)
        const parts = CircuitJsonBoardviewExporter.#buildParts(model)
        const bounds = CircuitJsonBoardviewExporter.#bounds(model, parts)
        const outline = CircuitJsonBoardviewExporter.#outline(model, bounds)
        const nets = CircuitJsonBoardviewExporter.#netTable(parts)
        const lines = ['0']
        CircuitJsonBoardviewExporter.#appendOutline(lines, outline, bounds)
        CircuitJsonBoardviewExporter.#appendNets(lines, nets)
        CircuitJsonBoardviewExporter.#appendParts(lines, parts, bounds)
        CircuitJsonBoardviewExporter.#appendPins(lines, parts, nets, bounds)
        lines.push('NAILS: 0')
        return lines.join('\n') + '\n'
    }

    /**
     * Reports whether one document carries the pad data a boardview needs.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {boolean} True when at least one placed pad exists.
     */
    static hasBoardview(document) {
        return CircuitJsonBoardviewExporter.#model(document).some(
            (element) => element.type === 'pcb_smtpad'
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
     * Builds the ordered part list, each with its pads, side, and net names.
     * @param {object[]} model Model element array.
     * @returns {{ name: string, side: number, pads: { x: number, y: number, width: number, height: number, net: string }[] }[]} Parts.
     */
    static #buildParts(model) {
        const padNet = GerberCircuitJsonConnectivity.assignPadNets(model)
        const portNet = CircuitJsonBoardviewExporter.#portNets(model)
        const pcbPort = new Map()
        for (const element of model) {
            if (element.type === 'pcb_port') {
                pcbPort.set(element.pcb_port_id, element.source_port_id)
            }
        }
        const componentMeta = CircuitJsonBoardviewExporter.#componentMeta(model)
        const grouped = new Map()
        const looseParts = []
        for (const element of model) {
            if (element.type !== 'pcb_smtpad') continue
            const net =
                portNet.get(pcbPort.get(element.pcb_port_id)) ||
                padNet.get(element.pcb_smtpad_id) ||
                'UNCONNECTED'
            const pad = {
                x: Number(element.x),
                y: Number(element.y),
                width: Number(element.width) || 0.2,
                height: Number(element.height) || 0.2,
                net
            }
            const meta = componentMeta.get(element.pcb_component_id)
            if (meta) {
                if (!grouped.has(element.pcb_component_id)) {
                    const part = { name: meta.name, side: meta.side, pads: [] }
                    grouped.set(element.pcb_component_id, part)
                }
                grouped.get(element.pcb_component_id).pads.push(pad)
            } else {
                looseParts.push({
                    name: `PAD_${looseParts.length + 1}`,
                    side: element.layer === 'bottom' ? 2 : 1,
                    pads: [pad]
                })
            }
        }
        return [...grouped.values(), ...looseParts]
    }

    /**
     * Maps source port ids to a real net name from source traces.
     * @param {object[]} model Model element array.
     * @returns {Map<string, string>} Net name by source port id.
     */
    static #portNets(model) {
        const netName = new Map()
        for (const element of model) {
            if (element.type === 'source_net') {
                netName.set(element.source_net_id, element.name ?? '')
            }
        }
        const portNet = new Map()
        for (const element of model) {
            if (element.type !== 'source_trace') continue
            const name = netName.get(element.connected_source_net_ids?.[0])
            if (!CircuitJsonBoardviewExporter.#isRealNet(name)) continue
            for (const portId of element.connected_source_port_ids ?? []) {
                if (!portNet.has(portId)) portNet.set(portId, name)
            }
        }
        return portNet
    }

    /**
     * Builds component metadata (unique name and side) keyed by component id.
     * @param {object[]} model Model element array.
     * @returns {Map<string, { name: string, side: number }>} Component metadata.
     */
    static #componentMeta(model) {
        const sourceName = new Map()
        for (const element of model) {
            if (element.type === 'source_component') {
                sourceName.set(
                    element.source_component_id,
                    CircuitJsonBoardviewExporter.#unescape(
                        element.name ?? element.display_name ?? ''
                    )
                )
            }
        }
        const used = new Map()
        const meta = new Map()
        for (const element of model) {
            if (element.type !== 'pcb_component') continue
            const base =
                sourceName.get(element.source_component_id) ||
                element.pcb_component_id
            const seen = used.get(base) ?? 0
            used.set(base, seen + 1)
            meta.set(element.pcb_component_id, {
                name: seen === 0 ? base : `${base}_${seen + 1}`,
                side: element.layer === 'bottom' ? 2 : 1
            })
        }
        return meta
    }

    /**
     * Computes the board bounds in mils over the outline and all pads.
     * @param {object[]} model Model element array.
     * @param {object[]} parts Prepared parts.
     * @returns {{ minX: number, minY: number, maxX: number, maxY: number, width: number, height: number }} Bounds in mils.
     */
    static #bounds(model, parts) {
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        const extend = (x, y) => {
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
        }
        const board = model.find((element) => element.type === 'pcb_board')
        for (const point of board?.outline ?? []) {
            extend(
                CircuitJsonBoardviewExporter.#mil(point.x),
                CircuitJsonBoardviewExporter.#mil(point.y)
            )
        }
        for (const part of parts) {
            for (const pad of part.pads) {
                extend(
                    CircuitJsonBoardviewExporter.#mil(pad.x),
                    CircuitJsonBoardviewExporter.#mil(pad.y)
                )
            }
        }
        if (!Number.isFinite(minX)) {
            minX = 0
            minY = 0
            maxX = 0
            maxY = 0
        }
        return {
            minX,
            minY,
            maxX,
            maxY,
            width: Math.round(maxX - minX),
            height: Math.round(maxY - minY)
        }
    }

    /**
     * Returns the board outline points in mils, or a bounding rectangle.
     * @param {object[]} model Model element array.
     * @param {object} bounds Board bounds.
     * @returns {{ x: number, y: number }[]} Outline points in mils.
     */
    static #outline(model, bounds) {
        const board = model.find((element) => element.type === 'pcb_board')
        const points = (board?.outline ?? []).map((point) => ({
            x: CircuitJsonBoardviewExporter.#mil(point.x),
            y: CircuitJsonBoardviewExporter.#mil(point.y)
        }))
        if (points.length >= 3) return points
        return [
            { x: bounds.minX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.maxY },
            { x: bounds.minX, y: bounds.maxY }
        ]
    }

    /**
     * Assigns integer ids to every distinct net name used by pins.
     * @param {object[]} parts Prepared parts.
     * @returns {Map<string, number>} Net id by net name.
     */
    static #netTable(parts) {
        const nets = new Map()
        for (const part of parts) {
            for (const pad of part.pads) {
                if (!nets.has(pad.net)) nets.set(pad.net, nets.size + 1)
            }
        }
        return nets
    }

    /**
     * Appends the outline section, flipped to a top-left origin.
     * @param {string[]} lines Output accumulator.
     * @param {{ x: number, y: number }[]} outline Outline points in mils.
     * @param {object} bounds Board bounds.
     * @returns {void}
     */
    static #appendOutline(lines, outline, bounds) {
        lines.push(`BRDOUT: ${outline.length} ${bounds.width} ${bounds.height}`)
        for (const point of outline) {
            const x = Math.round(point.x - bounds.minX)
            const y = Math.round(bounds.maxY - point.y)
            lines.push(`${x} ${y}`)
        }
    }

    /**
     * Appends the nets table.
     * @param {string[]} lines Output accumulator.
     * @param {Map<string, number>} nets Net id by name.
     * @returns {void}
     */
    static #appendNets(lines, nets) {
        lines.push(`NETS: ${nets.size}`)
        for (const [name, id] of nets) {
            lines.push(`${id} ${name}`)
        }
    }

    /**
     * Appends the parts section with per-part bounding boxes and first-pin index.
     * @param {string[]} lines Output accumulator.
     * @param {object[]} parts Prepared parts.
     * @param {object} bounds Board bounds.
     * @returns {void}
     */
    static #appendParts(lines, parts, bounds) {
        lines.push(`PARTS: ${parts.length}`)
        let firstPin = 0
        for (const part of parts) {
            const box = CircuitJsonBoardviewExporter.#partBox(part, bounds)
            lines.push(
                `${part.name} ${box.x1} ${box.y1} ${box.x2} ${box.y2} ${firstPin} ${part.side}`
            )
            firstPin += part.pads.length
        }
    }

    /**
     * Appends the pins section in part order.
     * @param {string[]} lines Output accumulator.
     * @param {object[]} parts Prepared parts.
     * @param {Map<string, number>} nets Net id by name.
     * @param {object} bounds Board bounds.
     * @returns {void}
     */
    static #appendPins(lines, parts, nets, bounds) {
        const total = parts.reduce((sum, part) => sum + part.pads.length, 0)
        lines.push(`PINS: ${total}`)
        for (const part of parts) {
            for (const pad of part.pads) {
                const point = CircuitJsonBoardviewExporter.#padPoint(
                    pad,
                    part.side,
                    bounds
                )
                lines.push(
                    `${point.x} ${point.y} ${nets.get(pad.net) ?? 0} ${part.side}`
                )
            }
        }
    }

    /**
     * Computes one part's bounding box in stored boardview coordinates.
     * @param {object} part Prepared part.
     * @param {object} bounds Board bounds.
     * @returns {{ x1: number, y1: number, x2: number, y2: number }} Box.
     */
    static #partBox(part, bounds) {
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const pad of part.pads) {
            const point = CircuitJsonBoardviewExporter.#padPoint(
                pad,
                part.side,
                bounds
            )
            const halfWidth = Math.round(
                (CircuitJsonBoardviewExporter.#mil(pad.width) || 0) / 2
            )
            const halfHeight = Math.round(
                (CircuitJsonBoardviewExporter.#mil(pad.height) || 0) / 2
            )
            minX = Math.min(minX, point.x - halfWidth)
            minY = Math.min(minY, point.y - halfHeight)
            maxX = Math.max(maxX, point.x + halfWidth)
            maxY = Math.max(maxY, point.y + halfHeight)
        }
        return { x1: minX, y1: minY, x2: maxX, y2: maxY }
    }

    /**
     * Stores one pad point so the parser's bottom-side flip re-registers it.
     * @param {object} pad Pad with mm coordinates.
     * @param {number} side Mounting side (1 top, 2 bottom).
     * @param {object} bounds Board bounds.
     * @returns {{ x: number, y: number }} Stored point in mils.
     */
    static #padPoint(pad, side, bounds) {
        const x = Math.round(
            CircuitJsonBoardviewExporter.#mil(pad.x) - bounds.minX
        )
        const yMil = CircuitJsonBoardviewExporter.#mil(pad.y)
        const y =
            side === 2
                ? Math.round(yMil - bounds.minY)
                : Math.round(bounds.maxY - yMil)
        return { x, y }
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
     * Formats one millimetre value as mils.
     * @param {number} millimetres Coordinate in millimetres.
     * @returns {number} Coordinate in mils.
     */
    static #mil(millimetres) {
        return Number(millimetres) * MM_TO_MIL
    }

    /**
     * Decodes literal `\uXXXX` escape sequences left in stored label text.
     * @param {string} value Possibly escaped label.
     * @returns {string} Decoded label.
     */
    static #unescape(value) {
        return String(value).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
            String.fromCharCode(Number.parseInt(hex, 16))
        )
    }
}
