import { GerberCircuitJsonArcSampler } from './GerberCircuitJsonArcSampler.mjs'
import { GerberCircuitJsonArtworkImageProjector } from './GerberCircuitJsonArtworkImageProjector.mjs'
import { GerberCircuitJsonArtworkProjector } from './GerberCircuitJsonArtworkProjector.mjs'
import { GerberCircuitJsonCopperImageProjector } from './GerberCircuitJsonCopperImageProjector.mjs'
import { GerberCircuitJsonLayerSemantics } from './GerberCircuitJsonLayerSemantics.mjs'
import { GerberCircuitJsonOutlineProjector } from './GerberCircuitJsonOutlineProjector.mjs'
import { GerberCircuitJsonOwnershipIndex } from './GerberCircuitJsonOwnershipIndex.mjs'
import { GerberCircuitJsonPhysicalImage } from './GerberCircuitJsonPhysicalImage.mjs'
import { GerberCircuitJsonSolderMaskProjector } from './GerberCircuitJsonSolderMaskProjector.mjs'

/** Projects standards-representable fabrication geometry into CircuitJSON. */
export class GerberCircuitJsonProjector {
    /**
     * Projects one native composite Gerber document.
     * @param {Record<string, any>} document Native document.
     * @returns {Record<string, any>[]} Canonical CircuitJSON elements.
     */
    static project(document) {
        const layers = Array.isArray(document?.pcb?.fabrication?.layers)
            ? document.pcb.fabrication.layers
            : []
        const profile = GerberCircuitJsonOutlineProjector.project(layers)
        const ownership = GerberCircuitJsonOwnershipIndex.build(layers)
        document.diagnostics ||= []
        document.diagnostics.push(...ownership.diagnostics)
        const domain = GerberCircuitJsonPhysicalImage.domain(profile, document)
        const copperLayerCount =
            GerberCircuitJsonLayerSemantics.copperLayerCount(layers)
        const explicitPhysicalPolarity = layers.some(
            (layer) =>
                GerberCircuitJsonPhysicalImage.filePolarity(layer) ||
                layer?.imagePolarity === 'negative'
        )
        if (domain.fallback && explicitPhysicalPolarity) {
            document.diagnostics ||= []
            document.diagnostics.push({
                code: 'GERBER_FILE_POLARITY_DOMAIN_FALLBACK',
                severity: 'warning',
                message:
                    'Negative file or image polarity used aggregate fabrication bounds because no closed board profile was available.'
            })
        }
        const masks = GerberCircuitJsonProjector.#maskImages(
            layers,
            domain.image
        )
        const model = [
            ...GerberCircuitJsonProjector.#boards(
                document,
                profile,
                copperLayerCount
            ),
            ...profile.cutouts,
            ...ownership.rows
        ]
        for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
            GerberCircuitJsonProjector.#layer(
                layers[layerIndex],
                layerIndex,
                model,
                masks,
                domain.image,
                ownership
            )
        }
        return model
    }

    /**
     * Groups native solder-mask opening primitives by board side.
     * @param {Record<string, any>[]} layers Native layers.
     * @returns {Map<string, Record<string, any>[]>} Side-indexed openings.
     */
    static #maskImages(layers, domain) {
        const masks = new Map()
        for (const layer of layers) {
            const semantics = GerberCircuitJsonLayerSemantics.resolve(layer)
            if (semantics.kind !== 'mask') continue
            const images = masks.get(semantics.circuitLayer) || []
            images.push(
                GerberCircuitJsonPhysicalImage.maskOpenings(
                    layer.primitives || [],
                    domain,
                    GerberCircuitJsonPhysicalImage.filePolarity(layer),
                    layer.imagePolarity
                )
            )
            masks.set(semantics.circuitLayer, images)
        }
        return new Map(
            [...masks].map(([side, images]) => [
                side,
                GerberCircuitJsonPhysicalImage.union(images)
            ])
        )
    }

    /**
     * Builds one canonical board from the aggregate fabrication bounds.
     * @param {Record<string, any>} document Native document.
     * @param {{ outline: object[] | null, bounds: object | null }} profile Projected profile.
     * @returns {Record<string, any>} Board element.
     */
    static #boards(document, profile, copperLayerCount) {
        if (profile.boards.length) {
            return profile.boards.map((board, index) =>
                GerberCircuitJsonProjector.#boardFromGeometry(
                    board,
                    index,
                    copperLayerCount
                )
            )
        }
        return [
            GerberCircuitJsonProjector.#boardFromGeometry(
                { bounds: document?.pcb?.bounds || {}, outline: null },
                0,
                copperLayerCount
            )
        ]
    }

    /**
     * Builds one canonical board from projected profile geometry.
     * @param {{ outline: object[] | null, bounds: object }} geometry Geometry.
     * @param {number} index Stable board index.
     * @param {number} copperLayerCount Physical copper layer count.
     * @returns {Record<string, any>} Board element.
     */
    static #boardFromGeometry(geometry, index, copperLayerCount) {
        const bounds = geometry.bounds || {}
        const minX = GerberCircuitJsonProjector.#number(bounds.minX)
        const minY = GerberCircuitJsonProjector.#number(bounds.minY)
        const maxX = GerberCircuitJsonProjector.#number(bounds.maxX, minX + 1)
        const maxY = GerberCircuitJsonProjector.#number(bounds.maxY, minY + 1)
        const board = {
            type: 'pcb_board',
            pcb_board_id: `gerber_board_${index}`,
            center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
            width: Math.max(maxX - minX, 0.000001),
            height: Math.max(maxY - minY, 0.000001),
            num_layers: copperLayerCount
        }
        if (geometry.outline) board.outline = geometry.outline
        return board
    }

    /**
     * Projects one fabrication layer without inventing unsupported semantics.
     * @param {Record<string, any>} layer Native layer.
     * @param {number} layerIndex Stable layer index.
     * @param {Record<string, any>[]} model Destination.
     * @param {Map<string, Record<string, any>[]>} masks Side mask openings.
     * @returns {void}
     */
    static #layer(layer, layerIndex, model, masks, domain, ownership) {
        const semantics = GerberCircuitJsonLayerSemantics.resolve(layer)
        const circuitLayer = semantics.circuitLayer
        const primitives = Array.isArray(layer?.primitives)
            ? layer.primitives
            : []
        const filePolarity = GerberCircuitJsonPhysicalImage.filePolarity(layer)
        const hasReversedImage = layer?.imagePolarity === 'negative'
        if (semantics.kind === 'copper') {
            const hasMask = masks.has(circuitLayer)
            const mask = masks.get(circuitLayer)
            const sourceImage =
                filePolarity || hasReversedImage
                    ? GerberCircuitJsonPhysicalImage.generatedImage(
                          primitives,
                          domain,
                          layer.imagePolarity
                      )
                    : null
            const requiresPhysicalImage =
                filePolarity === 'negative' ||
                hasReversedImage ||
                (filePolarity === 'positive' &&
                    !GerberCircuitJsonPhysicalImage.isWithin(
                        sourceImage,
                        domain
                    ))
            if (requiresPhysicalImage) {
                const material = GerberCircuitJsonPhysicalImage.copper(
                    primitives,
                    domain,
                    filePolarity || 'positive',
                    layer.imagePolarity
                )
                model.push(
                    ...(hasMask
                        ? GerberCircuitJsonSolderMaskProjector.projectImage(
                              material,
                              mask,
                              circuitLayer,
                              layerIndex
                          )
                        : GerberCircuitJsonCopperImageProjector.rows(
                              material,
                              circuitLayer,
                              `gerber_physical_${layerIndex}`
                          ))
                )
            } else if (hasMask) {
                model.push(
                    ...GerberCircuitJsonSolderMaskProjector.project(
                        primitives,
                        mask,
                        circuitLayer,
                        layerIndex,
                        (primitive, id) =>
                            GerberCircuitJsonProjector.#copper(
                                primitive,
                                circuitLayer,
                                id,
                                ownership.facts(primitive)
                            )
                    )
                )
            } else {
                GerberCircuitJsonProjector.#copperLayer(
                    primitives,
                    circuitLayer,
                    layerIndex,
                    model,
                    ownership
                )
            }
        } else if (semantics.kind === 'drill') {
            GerberCircuitJsonProjector.#drillHoles(
                primitives,
                layerIndex,
                model
            )
        } else if (
            semantics.kind !== 'outline' &&
            semantics.kind !== 'mask' &&
            (filePolarity || hasReversedImage)
        ) {
            const material = GerberCircuitJsonPhysicalImage.material(
                primitives,
                domain,
                filePolarity || 'positive',
                layer.imagePolarity
            )
            model.push(
                ...(semantics.kind === 'silkscreen'
                    ? GerberCircuitJsonArtworkImageProjector.silkscreenImage(
                          material,
                          circuitLayer,
                          layerIndex,
                          ownership.commonComponentId(primitives)
                      )
                    : GerberCircuitJsonArtworkImageProjector.notesImage(
                          material,
                          circuitLayer,
                          layerIndex,
                          semantics.kind
                      ))
            )
        } else {
            if (
                semantics.kind !== 'outline' &&
                GerberCircuitJsonArtworkImageProjector.requiresComposition(
                    primitives
                )
            ) {
                model.push(
                    ...(semantics.kind === 'silkscreen'
                        ? GerberCircuitJsonArtworkImageProjector.silkscreen(
                              primitives,
                              circuitLayer,
                              layerIndex,
                              ownership.commonComponentId(primitives)
                          )
                        : GerberCircuitJsonArtworkImageProjector.notes(
                              primitives,
                              circuitLayer,
                              layerIndex,
                              semantics.kind
                          ))
                )
            } else {
                for (let index = 0; index < primitives.length; index += 1) {
                    if (semantics.kind === 'outline') continue
                    model.push(
                        ...GerberCircuitJsonArtworkProjector.project(
                            primitives[index],
                            semantics,
                            `${layerIndex}_${index}`,
                            ownership.facts(primitives[index])
                        )
                    )
                }
            }
        }
        const drills = Array.isArray(layer?.drills) ? layer.drills : []
        for (let index = 0; index < drills.length; index += 1) {
            model.push(
                GerberCircuitJsonProjector.#hole(
                    drills[index],
                    layerIndex,
                    index
                )
            )
        }
    }

    /**
     * Projects a gerber-format drill layer's flashes into plated or bare holes.
     *
     * Excellon drill layers expose a `drills` array the trailing loop handles,
     * but gerber-format drill files (`FileFunction=Plated…Drill`) carry each
     * hole as a circular flash. Each flash is normalised to the drill shape
     * {@link #hole} expects, taking the plated flag from its X2 file function.
     * @param {Record<string, any>[]} primitives Native drill primitives.
     * @param {number} layerIndex Stable layer index.
     * @param {Record<string, any>[]} model Destination.
     * @returns {void}
     */
    static #drillHoles(primitives, layerIndex, model) {
        for (let index = 0; index < primitives.length; index += 1) {
            const flash = primitives[index]
            if (flash?.type !== 'flash') continue
            const diameter = GerberCircuitJsonProjector.#positive(
                flash.diameter ?? flash.shape?.diameter
            )
            if (!diameter) continue
            const fileFunction = flash.attributes?.file?.FileFunction ?? []
            const plated =
                String(fileFunction[0] || '').toLowerCase() !== 'nonplated'
            model.push(
                GerberCircuitJsonProjector.#hole(
                    { x: flash.x, y: flash.y, diameter, plated },
                    layerIndex,
                    index
                )
            )
        }
    }

    /**
     * Projects one copper layer while attaching contained clear artwork as
     * BREP holes instead of misrepresenting it as documentation.
     * @param {Record<string, any>[]} primitives Native layer primitives.
     * @param {string} layer Canonical copper layer.
     * @param {number} layerIndex Stable layer index.
     * @param {Record<string, any>[]} model Destination.
     * @returns {void}
     */
    static #copperLayer(primitives, layer, layerIndex, model, ownership) {
        if (
            GerberCircuitJsonCopperImageProjector.requiresComposition(
                primitives
            )
        ) {
            model.push(
                ...GerberCircuitJsonCopperImageProjector.project(
                    primitives,
                    layer,
                    layerIndex
                )
            )
            return
        }
        for (let index = 0; index < primitives.length; index += 1) {
            model.push(
                ...GerberCircuitJsonProjector.#copper(
                    primitives[index],
                    layer,
                    `${layerIndex}_${index}`,
                    ownership.facts(primitives[index])
                )
            )
        }
    }

    /**
     * Converts clear Gerber artwork to a closed polygon suitable for a BREP
     * inner ring. Unsupported geometry returns an empty path.
     * @param {Record<string, any>} primitive Native clear primitive.
     * @returns {{ x: number, y: number }[]} Polygon vertices.
     */
    static #clearPolygon(primitive) {
        if (primitive?.type === 'region') {
            return GerberCircuitJsonProjector.#points(primitive.points)
        }
        if (primitive?.type === 'line' || primitive?.type === 'arc') {
            const points =
                primitive.type === 'arc'
                    ? GerberCircuitJsonArcSampler.points(primitive)
                    : [
                          { x: primitive.x1, y: primitive.y1 },
                          { x: primitive.x2, y: primitive.y2 }
                      ]
            return GerberCircuitJsonProjector.#strokePolygon(
                points,
                GerberCircuitJsonProjector.#positive(primitive.width)
            )
        }
        if (primitive?.type !== 'flash') return []
        const x = GerberCircuitJsonProjector.#number(primitive.x)
        const y = GerberCircuitJsonProjector.#number(primitive.y)
        const rotation = GerberCircuitJsonProjector.#number(
            primitive.rotation ?? primitive.transform?.rotation
        )
        if (primitive.shape === 'circle') {
            const radius =
                GerberCircuitJsonProjector.#positive(primitive.diameter) / 2
            return GerberCircuitJsonProjector.#ellipse(
                x,
                y,
                radius,
                radius,
                rotation
            )
        }
        if (primitive.shape === 'rect') {
            return GerberCircuitJsonProjector.#rectangle(
                x,
                y,
                GerberCircuitJsonProjector.#positive(primitive.width),
                GerberCircuitJsonProjector.#positive(primitive.height),
                rotation
            )
        }
        if (primitive.shape === 'obround') {
            return GerberCircuitJsonProjector.#ellipse(
                x,
                y,
                GerberCircuitJsonProjector.#positive(primitive.width) / 2,
                GerberCircuitJsonProjector.#positive(primitive.height) / 2,
                rotation
            )
        }
        return []
    }

    /**
     * Expands a centerline into a deterministic polygonal stroke envelope.
     * @param {{ x: number, y: number }[]} points Centerline points.
     * @param {number} width Stroke width.
     * @returns {{ x: number, y: number }[]} Stroke polygon.
     */
    static #strokePolygon(points, width) {
        if (points.length < 2) return []
        const left = []
        const right = []
        for (let index = 0; index < points.length; index += 1) {
            const previous = points[Math.max(0, index - 1)]
            const next = points[Math.min(points.length - 1, index + 1)]
            const length = Math.hypot(next.x - previous.x, next.y - previous.y)
            if (!length) continue
            const nx = (-(next.y - previous.y) / length) * (width / 2)
            const ny = ((next.x - previous.x) / length) * (width / 2)
            left.push({ x: points[index].x + nx, y: points[index].y + ny })
            right.push({ x: points[index].x - nx, y: points[index].y - ny })
        }
        return [...left, ...right.reverse()]
    }

    /**
     * Samples a rotated ellipse.
     * @param {number} x Center X.
     * @param {number} y Center Y.
     * @param {number} radiusX X radius.
     * @param {number} radiusY Y radius.
     * @param {number} rotation Rotation in degrees.
     * @returns {{ x: number, y: number }[]} Ellipse vertices.
     */
    static #ellipse(x, y, radiusX, radiusY, rotation) {
        const radians = (rotation * Math.PI) / 180
        const cosRotation = Math.cos(radians)
        const sinRotation = Math.sin(radians)
        return Array.from({ length: 32 }, (_, index) => {
            const angle = (index / 32) * Math.PI * 2
            const localX = Math.cos(angle) * radiusX
            const localY = Math.sin(angle) * radiusY
            return {
                x: x + localX * cosRotation - localY * sinRotation,
                y: y + localX * sinRotation + localY * cosRotation
            }
        })
    }

    /**
     * Builds rotated rectangle vertices.
     * @param {number} x Center X.
     * @param {number} y Center Y.
     * @param {number} width Width.
     * @param {number} height Height.
     * @param {number} rotation Rotation in degrees.
     * @returns {{ x: number, y: number }[]} Rectangle vertices.
     */
    static #rectangle(x, y, width, height, rotation) {
        const radians = (rotation * Math.PI) / 180
        const cosRotation = Math.cos(radians)
        const sinRotation = Math.sin(radians)
        return [
            [-width / 2, -height / 2],
            [width / 2, -height / 2],
            [width / 2, height / 2],
            [-width / 2, height / 2]
        ].map(([localX, localY]) => ({
            x: x + localX * cosRotation - localY * sinRotation,
            y: y + localX * sinRotation + localY * cosRotation
        }))
    }

    /**
     * Tests whether every hole vertex lies inside or on an outer polygon.
     * @param {{ x: number, y: number }[]} outer Outer ring.
     * @param {{ x: number, y: number }[]} inner Candidate inner ring.
     * @returns {boolean} Whether the candidate is a valid contained hole.
     */
    static #polygonContains(outer, inner) {
        return (
            inner.length >= 3 &&
            inner.every((point) =>
                GerberCircuitJsonProjector.#pointInPolygon(outer, point)
            )
        )
    }

    /**
     * Tests point containment, treating the authored boundary as contained.
     * @param {{ x: number, y: number }[]} polygon Polygon.
     * @param {{ x: number, y: number }} point Candidate point.
     * @returns {boolean} Containment result.
     */
    static #pointInPolygon(polygon, point) {
        let inside = false
        for (
            let current = 0, previous = polygon.length - 1;
            current < polygon.length;
            previous = current, current += 1
        ) {
            const start = polygon[previous]
            const end = polygon[current]
            const cross =
                (point.y - start.y) * (end.x - start.x) -
                (point.x - start.x) * (end.y - start.y)
            const dot =
                (point.x - start.x) * (point.x - end.x) +
                (point.y - start.y) * (point.y - end.y)
            if (Math.abs(cross) <= 1e-9 && dot <= 1e-12) return true
            if (
                start.y > point.y !== end.y > point.y &&
                point.x <
                    ((end.x - start.x) * (point.y - start.y)) /
                        (end.y - start.y) +
                        start.x
            ) {
                inside = !inside
            }
        }
        return inside
    }

    /**
     * Projects one copper primitive.
     * @param {Record<string, any>} primitive Native primitive.
     * @param {'top' | 'bottom'} layer Circuit layer.
     * @param {string} id Stable suffix.
     * @returns {Record<string, any>[]} Zero or more rows.
     */
    static #copper(primitive, layer, id, ownership = {}) {
        if (primitive?.type === 'line' || primitive?.type === 'arc') {
            return [
                {
                    type: 'pcb_trace',
                    pcb_trace_id: `gerber_trace_${id}`,
                    route: GerberCircuitJsonProjector.#route(primitive, layer),
                    ...(ownership.pcbComponentId
                        ? { pcb_component_id: ownership.pcbComponentId }
                        : {}),
                    ...(ownership.sourceTraceId
                        ? { source_trace_id: ownership.sourceTraceId }
                        : {})
                }
            ]
        }
        if (primitive?.type === 'region') {
            const points = GerberCircuitJsonProjector.#points(primitive.points)
            return points.length >= 3
                ? [
                      {
                          type: 'pcb_copper_pour',
                          pcb_copper_pour_id: `gerber_pour_${id}`,
                          shape: 'polygon',
                          points,
                          layer,
                          ...(ownership.sourceNetIds?.length === 1
                              ? {
                                    source_net_id: ownership.sourceNetIds[0]
                                }
                              : {})
                      }
                  ]
                : []
        }
        if (primitive?.type !== 'flash') return []
        if (
            primitive.hole ||
            ['block', 'macro', 'polygon'].includes(primitive.shape)
        ) {
            return GerberCircuitJsonCopperImageProjector.projectPrimitive(
                primitive,
                layer,
                id
            ).map((row) => ({
                ...row,
                ...(ownership.sourceNetIds?.length === 1
                    ? { source_net_id: ownership.sourceNetIds[0] }
                    : {})
            }))
        }
        const pad = GerberCircuitJsonProjector.#pad(
            primitive,
            layer,
            id,
            ownership
        )
        return pad ? [pad] : []
    }

    /**
     * Projects one supported aperture flash as non-semantic copper artwork.
     * @param {Record<string, any>} primitive Native flash.
     * @param {'top' | 'bottom'} layer Circuit layer.
     * @param {string} id Stable suffix.
     * @returns {Record<string, any> | null} Pad or null.
     */
    static #pad(primitive, layer, id, ownership = {}) {
        const common = {
            type: 'pcb_smtpad',
            pcb_smtpad_id: `gerber_pad_${id}`,
            x: GerberCircuitJsonProjector.#number(primitive.x),
            y: GerberCircuitJsonProjector.#number(primitive.y),
            layer,
            ...(ownership.pcbComponentId
                ? { pcb_component_id: ownership.pcbComponentId }
                : {}),
            ...(ownership.pcbPortId ? { pcb_port_id: ownership.pcbPortId } : {})
        }
        if (primitive.shape === 'circle') {
            return {
                ...common,
                shape: 'circle',
                radius: Math.max(
                    GerberCircuitJsonProjector.#number(primitive.diameter) / 2,
                    0.000001
                )
            }
        }
        if (primitive.shape === 'rect') {
            const rotation = GerberCircuitJsonProjector.#number(
                primitive.rotation ?? primitive.transform?.rotation
            )
            return {
                ...common,
                shape: rotation === 0 ? 'rect' : 'rotated_rect',
                width: GerberCircuitJsonProjector.#positive(primitive.width),
                height: GerberCircuitJsonProjector.#positive(primitive.height),
                ...(rotation === 0 ? {} : { ccw_rotation: rotation })
            }
        }
        if (primitive.shape === 'obround') {
            const width = GerberCircuitJsonProjector.#positive(primitive.width)
            const height = GerberCircuitJsonProjector.#positive(
                primitive.height
            )
            const rotation = GerberCircuitJsonProjector.#number(
                primitive.rotation ?? primitive.transform?.rotation
            )
            return {
                ...common,
                shape: rotation === 0 ? 'pill' : 'rotated_pill',
                width,
                height,
                radius: Math.min(width, height) / 2,
                ...(rotation === 0 ? {} : { ccw_rotation: rotation })
            }
        }
        return null
    }

    /**
     * Projects component-free documentation into generic PCB notes.
     * @param {Record<string, any>} primitive Native primitive.
     * @param {'top' | 'bottom'} layer Circuit layer.
     * @param {string} id Stable suffix.
     * @returns {Record<string, any> | null} Note row.
     */
    static #note(primitive, layer, id) {
        if (primitive?.type === 'line') {
            return {
                type: 'pcb_note_line',
                pcb_note_line_id: `gerber_note_${id}`,
                x1: GerberCircuitJsonProjector.#number(primitive.x1),
                y1: GerberCircuitJsonProjector.#number(primitive.y1),
                x2: GerberCircuitJsonProjector.#number(primitive.x2),
                y2: GerberCircuitJsonProjector.#number(primitive.y2),
                stroke_width: GerberCircuitJsonProjector.#positive(
                    primitive.width
                ),
                layer
            }
        }
        if (primitive?.type === 'arc') {
            return {
                type: 'pcb_note_path',
                pcb_note_path_id: `gerber_note_${id}`,
                route: GerberCircuitJsonProjector.#route(primitive, layer).map(
                    ({ x, y }) => ({ x, y })
                ),
                stroke_width: GerberCircuitJsonProjector.#positive(
                    primitive.width
                ),
                layer
            }
        }
        return null
    }

    /**
     * Builds a trace route, approximating native arcs at bounded resolution.
     * @param {Record<string, any>} primitive Native stroke.
     * @param {'top' | 'bottom'} layer Circuit layer.
     * @returns {Record<string, any>[]} Route points.
     */
    static #route(primitive, layer) {
        const width = GerberCircuitJsonProjector.#positive(primitive.width)
        const points =
            primitive.type === 'arc'
                ? GerberCircuitJsonArcSampler.points(primitive)
                : [
                      { x: primitive.x1, y: primitive.y1 },
                      { x: primitive.x2, y: primitive.y2 }
                  ]
        return points.map((point) => ({
            route_type: 'wire',
            x: GerberCircuitJsonProjector.#number(point.x),
            y: GerberCircuitJsonProjector.#number(point.y),
            width,
            layer
        }))
    }

    /**
     * Projects one native drill.
     * @param {Record<string, any>} drill Native drill.
     * @param {number} layerIndex Layer index.
     * @param {number} drillIndex Drill index.
     * @returns {Record<string, any>} Canonical hole.
     */
    static #hole(drill, layerIndex, drillIndex) {
        const id = `gerber_hole_${layerIndex}_${drillIndex}`
        if (drill?.type === 'slot') {
            const x1 = GerberCircuitJsonProjector.#number(drill.x1)
            const y1 = GerberCircuitJsonProjector.#number(drill.y1)
            const x2 = GerberCircuitJsonProjector.#number(drill.x2)
            const y2 = GerberCircuitJsonProjector.#number(drill.y2)
            const diameter = GerberCircuitJsonProjector.#positive(
                drill.diameter
            )
            if (drill.plated !== false) {
                const width = Math.hypot(x2 - x1, y2 - y1) + diameter
                const rotation = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI
                return {
                    type: 'pcb_plated_hole',
                    pcb_plated_hole_id: id,
                    shape: 'pill',
                    x: (x1 + x2) / 2,
                    y: (y1 + y2) / 2,
                    hole_width: width,
                    hole_height: diameter,
                    outer_width: width,
                    outer_height: diameter,
                    ccw_rotation: rotation,
                    layers: ['top', 'bottom']
                }
            }
            return {
                type: 'pcb_hole',
                pcb_hole_id: id,
                hole_shape: 'pill',
                x: (x1 + x2) / 2,
                y: (y1 + y2) / 2,
                hole_width: Math.hypot(x2 - x1, y2 - y1) + diameter,
                hole_height: diameter,
                ccw_rotation: (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI,
                layer: 'board'
            }
        }
        const diameter = GerberCircuitJsonProjector.#positive(drill?.diameter)
        if (drill?.plated !== false) {
            return {
                type: 'pcb_plated_hole',
                pcb_plated_hole_id: id,
                shape: 'circle',
                x: GerberCircuitJsonProjector.#number(drill?.x),
                y: GerberCircuitJsonProjector.#number(drill?.y),
                outer_diameter: diameter,
                hole_diameter: diameter,
                layers: ['top', 'bottom']
            }
        }
        return {
            type: 'pcb_hole',
            pcb_hole_id: id,
            hole_shape: 'circle',
            x: GerberCircuitJsonProjector.#number(drill?.x),
            y: GerberCircuitJsonProjector.#number(drill?.y),
            hole_diameter: diameter,
            layer: 'board'
        }
    }

    /**
     * Builds a minimal source-shaped polygon around one plated slot.
     * @param {number} x1 Slot start X.
     * @param {number} y1 Slot start Y.
     * @param {number} x2 Slot end X.
     * @param {number} y2 Slot end Y.
     * @param {number} diameter Slot diameter.
     * @returns {{ x: number, y: number }[]} Polygon pad outline.
     */
    static #slotOutline(x1, y1, x2, y2, diameter) {
        const length = Math.hypot(x2 - x1, y2 - y1)
        const ux = length > 0 ? (x2 - x1) / length : 1
        const uy = length > 0 ? (y2 - y1) / length : 0
        const nx = (-uy * diameter) / 2
        const ny = (ux * diameter) / 2
        const ex = (ux * diameter) / 2
        const ey = (uy * diameter) / 2
        return [
            { x: x1 - ex + nx, y: y1 - ey + ny },
            { x: x2 + ex + nx, y: y2 + ey + ny },
            { x: x2 + ex - nx, y: y2 + ey - ny },
            { x: x1 - ex - nx, y: y1 - ey - ny }
        ]
    }

    /** @param {unknown} value Points. @returns {object[]} Finite points. */
    static #points(value) {
        if (!Array.isArray(value)) return []
        return value
            .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
            .filter(
                (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
            )
    }

    /** @param {unknown} value Candidate. @param {number} [fallback] Fallback. @returns {number} Finite value. */
    static #number(value, fallback = 0) {
        const number = Number(value)
        return Number.isFinite(number) ? number : fallback
    }

    /** @param {unknown} value Candidate. @returns {number} Positive value. */
    static #positive(value) {
        return Math.max(GerberCircuitJsonProjector.#number(value), 0.000001)
    }
}

Object.freeze(GerberCircuitJsonProjector.prototype)
Object.freeze(GerberCircuitJsonProjector)
