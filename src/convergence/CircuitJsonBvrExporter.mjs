import { GerberCircuitJsonConnectivity } from './GerberCircuitJsonConnectivity.mjs'

// Millimetres to mils (thousandths of an inch); BVR coordinates are in mils.
const MM_TO_MIL = 39.37007874015748

/**
 * Exports a canonical CircuitJSON document to the FlexBV/OpenBoardView BVR
 * ("BV Raw", `BVRAW_FORMAT_1`) boardview format.
 *
 * The format is tab-delimited and line-oriented with three sections —
 * `<<Layout>>` (board outline), `<<Pin>>` (parts and pins), and `<<Nail>>`
 * (test points) — each followed by one skipped header line. Coordinates are
 * emitted in mils. Parts are implicit: consecutive pin rows that share a part
 * name form one part, so pins are grouped per component and part names are
 * made unique to avoid merging distinct components.
 */
export class CircuitJsonBvrExporter {
    /**
     * Renders one CircuitJSON document as BVR boardview text.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {string} BVRAW_FORMAT_1 text.
     */
    static export(document) {
        const model = CircuitJsonBvrExporter.#model(document)
        const index = CircuitJsonBvrExporter.#index(model)
        const lines = ['BVRAW_FORMAT_1', '']
        CircuitJsonBvrExporter.#appendLayout(lines, index)
        CircuitJsonBvrExporter.#appendPins(lines, index)
        CircuitJsonBvrExporter.#appendNails(lines)
        return lines.join('\n') + '\n'
    }

    /**
     * Reports whether one document carries the component data a boardview needs.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {boolean} True when at least one placed pad exists.
     */
    static hasBoardview(document) {
        const model = CircuitJsonBvrExporter.#model(document)
        return model.some((element) => element.type === 'pcb_smtpad')
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
     * Builds the lookup tables that connect pads to parts, pins, and nets.
     * @param {object[]} model Model element array.
     * @returns {object} Prepared index of maps and grouped pads.
     */
    static #index(model) {
        const board = model.find((element) => element.type === 'pcb_board')
        const netNameBySource = new Map()
        for (const element of model) {
            if (element.type === 'source_net') {
                netNameBySource.set(element.source_net_id, element.name ?? '')
            }
        }
        const netByPort = new Map()
        for (const element of model) {
            if (element.type !== 'source_trace') continue
            const netId = element.connected_source_net_ids?.[0]
            const name = netNameBySource.get(netId)
            for (const portId of element.connected_source_port_ids ?? []) {
                if (name && !netByPort.get(portId)) netByPort.set(portId, name)
            }
        }
        const sourcePortName = new Map()
        for (const element of model) {
            if (element.type === 'source_port') {
                sourcePortName.set(
                    element.source_port_id,
                    String(element.name ?? element.pin_number ?? '')
                )
            }
        }
        const pcbPort = new Map()
        for (const element of model) {
            if (element.type === 'pcb_port') {
                pcbPort.set(element.pcb_port_id, element.source_port_id)
            }
        }
        const sourceComponentName = new Map()
        for (const element of model) {
            if (element.type === 'source_component') {
                sourceComponentName.set(
                    element.source_component_id,
                    CircuitJsonBvrExporter.#unescape(
                        element.name ?? element.display_name ?? ''
                    )
                )
            }
        }
        return {
            board,
            netByPort,
            sourcePortName,
            pcbPort,
            components: CircuitJsonBvrExporter.#components(
                model,
                sourceComponentName
            ),
            padsByComponent: CircuitJsonBvrExporter.#padsByComponent(model),
            padNet: GerberCircuitJsonConnectivity.assignPadNets(model)
        }
    }

    /**
     * Builds per-component metadata with unique display names.
     * @param {object[]} model Model element array.
     * @param {Map<string, string>} sourceComponentName Source names by id.
     * @returns {Map<string, { name: string, side: string }>} Component metadata.
     */
    static #components(model, sourceComponentName) {
        const used = new Map()
        const components = new Map()
        for (const element of model) {
            if (element.type !== 'pcb_component') continue
            const base =
                sourceComponentName.get(element.source_component_id) ||
                element.pcb_component_id
            const seen = used.get(base) ?? 0
            used.set(base, seen + 1)
            components.set(element.pcb_component_id, {
                name: seen === 0 ? base : `${base}_${seen + 1}`,
                side: element.layer === 'bottom' ? '(B)' : '(T)'
            })
        }
        return components
    }

    /**
     * Groups pads by their owning component in stable model order.
     * @param {object[]} model Model element array.
     * @returns {Map<string, object[]>} Pads keyed by component id.
     */
    static #padsByComponent(model) {
        const grouped = new Map()
        for (const element of model) {
            if (element.type !== 'pcb_smtpad') continue
            const key = element.pcb_component_id ?? ''
            const list = grouped.get(key) ?? []
            list.push(element)
            grouped.set(key, list)
        }
        return grouped
    }

    /**
     * Appends the `<<Layout>>` board-outline section.
     * @param {string[]} lines Output line accumulator.
     * @param {object} index Prepared index.
     * @returns {void}
     */
    static #appendLayout(lines, index) {
        lines.push('<<Layout>>', 'LOC_X\tLOC_Y')
        for (const point of index.board?.outline ?? []) {
            lines.push(
                `${CircuitJsonBvrExporter.#mil(point.x)}\t${CircuitJsonBvrExporter.#mil(point.y)}`
            )
        }
        lines.push('')
    }

    /**
     * Appends the `<<Pin>>` parts-and-pins section.
     * @param {string[]} lines Output line accumulator.
     * @param {object} index Prepared index.
     * @returns {void}
     */
    static #appendPins(lines, index) {
        lines.push(
            '<<Pin>>',
            'PART_NAME\tLOC\tPIN_ID\tPIN_NAME\tLOC_X\tLOC_Y\tLAYER\tNET_NAME'
        )
        let pinId = 0
        for (const [componentId, pads] of index.padsByComponent) {
            const component = index.components.get(componentId)
            for (const pad of pads) {
                pinId += 1
                const sourcePortId = index.pcbPort.get(pad.pcb_port_id)
                const pinName =
                    index.sourcePortName.get(sourcePortId) || String(pinId)
                // Prefer a net the source explicitly tied to this pad; otherwise
                // fall back to the net derived from copper connectivity.
                const net =
                    index.netByPort.get(sourcePortId) ||
                    index.padNet.get(pad.pcb_smtpad_id) ||
                    'UNCONNECTED'
                // Pads the source never tied to a component (bare Gerber data)
                // become their own single-pin part so they are not falsely
                // highlighted together as one component.
                const part = component ?? {
                    name: `PAD_${pinId}`,
                    side: pad.layer === 'bottom' ? '(B)' : '(T)'
                }
                lines.push(
                    [
                        part.name,
                        part.side,
                        pinId,
                        pinName,
                        CircuitJsonBvrExporter.#mil(pad.x),
                        CircuitJsonBvrExporter.#mil(pad.y),
                        part.side === '(B)' ? 2 : 1,
                        net
                    ].join('\t')
                )
            }
        }
        lines.push('')
    }

    /**
     * Appends an empty `<<Nail>>` test-point section header.
     * @param {string[]} lines Output line accumulator.
     * @returns {void}
     */
    static #appendNails(lines) {
        lines.push(
            '<<Nail>>',
            'NET_ID\tLOC_X\tLOC_Y\tTYPE\tGRID\tLOC\tNET_NAME'
        )
    }

    /**
     * Formats one millimetre value as a mils string.
     * @param {number} millimetres Coordinate in millimetres.
     * @returns {string} Coordinate in mils.
     */
    static #mil(millimetres) {
        return (Number(millimetres) * MM_TO_MIL).toFixed(3)
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
