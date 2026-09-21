import {
    BomTableRenderer,
    ManufacturingService,
    PcbScene3dBuilder,
    PcbSvgRenderer
} from 'gerber-toolkit'
import { strToU8, zipSync } from 'fflate'

import { CircuitJsonBoardviewExporter } from '../src/convergence/CircuitJsonBoardviewExporter.mjs'
import { CircuitJsonKicadPcbExporter } from '../src/convergence/CircuitJsonKicadPcbExporter.mjs'

const TARGETS = [
    {
        id: 'circuitjson',
        label: 'CircuitJSON model',
        kind: 'model',
        fileExtension: '.circuit.json',
        mediaType: 'application/json;charset=utf-8'
    },
    {
        id: 'pcb-svg',
        label: 'PCB SVG (all layers)',
        kind: 'pcb-svg',
        fileExtension: '.pcb.svg',
        mediaType: 'image/svg+xml;charset=utf-8'
    },
    {
        id: 'pcb-layers-svg-zip',
        label: 'PCB SVG per layer (ZIP)',
        kind: 'pcb-layers-svg-zip',
        fileExtension: '.pcb-layers.zip',
        mediaType: 'application/zip'
    },
    {
        id: 'bom-html',
        label: 'Bill of materials (HTML)',
        kind: 'bom-html',
        fileExtension: '.bom.html',
        mediaType: 'text/html;charset=utf-8'
    },
    {
        id: 'scene3d-json',
        label: '3D scene JSON',
        kind: 'scene3d-json',
        fileExtension: '.scene3d.json',
        mediaType: 'application/json;charset=utf-8'
    },
    {
        id: 'pick-place-csv',
        label: 'Pick-and-place CSV',
        kind: 'manufacturing',
        fileExtension: '-pick-place.csv',
        mediaType: 'text/csv;charset=utf-8'
    },
    {
        id: 'fabrication-notes-json',
        label: 'Fabrication notes JSON',
        kind: 'manufacturing',
        fileExtension: '-fabrication-notes.json',
        mediaType: 'application/json;charset=utf-8'
    },
    {
        id: 'routing-dsn',
        label: 'Routing (Specctra DSN)',
        kind: 'manufacturing',
        fileExtension: '-routing.dsn',
        mediaType: 'application/specctra-dsn'
    },
    {
        id: 'boardview-brd',
        label: 'Boardview (OpenBoardView .brd)',
        kind: 'boardview-brd',
        fileExtension: '.brd',
        mediaType: 'text/plain;charset=utf-8'
    },
    {
        id: 'kicad-pcb',
        label: 'KiCad PCB with copper (.kicad_pcb)',
        kind: 'kicad-pcb',
        fileExtension: '.kicad_pcb',
        mediaType: 'text/plain;charset=utf-8'
    }
]

/**
 * Converts one loaded toolkit document into every output file type the shared
 * CircuitJSON services can produce, reporting honest per-format availability.
 */
export class ConversionService {
    /**
     * Lists every conversion target and whether the document can produce it.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {object[]} Rows with id, label, fileName, fileExtension, mediaType, status, and reason.
     */
    static listTargets(document) {
        const manufacturing = ConversionService.#manufacturingStatus(document)
        const fileName = ConversionService.#baseName(document)
        const boardview = ConversionService.#boardviewStatus(document)
        return TARGETS.map((target) => {
            let status = { status: 'available', reason: '' }
            if (target.kind === 'manufacturing') {
                status = manufacturing[target.id] ?? {
                    status: 'unavailable',
                    reason: 'Manufacturing export is unavailable.'
                }
            } else if (target.kind === 'boardview-brd') {
                status = boardview
            }
            return {
                id: target.id,
                label: target.label,
                fileName: `${fileName}${target.fileExtension}`,
                fileExtension: target.fileExtension,
                mediaType: target.mediaType,
                status: status.status,
                reason: status.reason
            }
        })
    }

    /**
     * Builds one converted output file for one target id.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @param {string} targetId Conversion target id from listTargets().
     * @returns {{ ok: true, fileName: string, mediaType: string, data: Uint8Array } | { ok: false, reason: string }} Discriminated result.
     */
    static convert(document, targetId) {
        const target = TARGETS.find((entry) => entry.id === targetId)
        if (!target) {
            return {
                ok: false,
                reason: `Unknown conversion target: ${targetId}.`
            }
        }
        try {
            const data = ConversionService.#build(document, target)
            if (!data || data.length === 0) {
                return {
                    ok: false,
                    reason: `Conversion target ${targetId} produced no content.`
                }
            }
            return {
                ok: true,
                fileName: `${ConversionService.#baseName(document)}${target.fileExtension}`,
                mediaType: target.mediaType,
                data
            }
        } catch (error) {
            return { ok: false, reason: ConversionService.#reason(error) }
        }
    }

    /**
     * Bundles every available conversion target into one ZIP archive.
     *
     * Unavailable targets are skipped rather than fabricated, keeping the
     * bundle consistent with the honest per-format availability model.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {{ ok: true, fileName: string, mediaType: string, data: Uint8Array, included: string[], skipped: string[] } | { ok: false, reason: string }} Discriminated result.
     */
    static bundleAll(document) {
        const entries = {}
        const included = []
        const skipped = []
        for (const row of ConversionService.listTargets(document)) {
            if (row.status !== 'available') {
                skipped.push(row.id)
                continue
            }
            const result = ConversionService.convert(document, row.id)
            if (!result.ok) {
                skipped.push(row.id)
                continue
            }
            entries[result.fileName] = result.data
            included.push(row.id)
        }
        if (included.length === 0) {
            return {
                ok: false,
                reason: 'No available conversion outputs to bundle.'
            }
        }
        return {
            ok: true,
            fileName: `${ConversionService.#baseName(document)}-outputs.zip`,
            mediaType: 'application/zip',
            data: zipSync(entries),
            included,
            skipped
        }
    }

    /**
     * Builds one conversion payload.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @param {object} target Target definition row.
     * @returns {Uint8Array} Encoded output bytes.
     */
    static #build(document, target) {
        switch (target.kind) {
            case 'model': {
                const model = Array.isArray(document)
                    ? document
                    : document.model
                return strToU8(JSON.stringify(model, null, 2))
            }
            case 'pcb-svg':
                return strToU8(PcbSvgRenderer.render(document))
            case 'pcb-layers-svg-zip':
                return ConversionService.#layersZip(document)
            case 'bom-html':
                return strToU8(BomTableRenderer.render(document))
            case 'scene3d-json':
                return strToU8(
                    JSON.stringify(PcbScene3dBuilder.build(document), null, 2)
                )
            case 'manufacturing':
                return ManufacturingService.export(document, { id: target.id })
                    .data
            case 'boardview-brd':
                return strToU8(CircuitJsonBoardviewExporter.export(document))
            case 'kicad-pcb':
                return strToU8(CircuitJsonKicadPcbExporter.export(document))
            default:
                throw new Error(`Unknown conversion kind: ${target.kind}.`)
        }
    }

    /**
     * Builds one ZIP archive holding one SVG per rendered PCB layer.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {Uint8Array} ZIP bytes.
     */
    static #layersZip(document) {
        const renderSet = PcbSvgRenderer.renderLayers(document)
        if (!Array.isArray(renderSet.items) || renderSet.items.length === 0) {
            throw new Error('No PCB layers are available for SVG conversion.')
        }
        const entries = {}
        for (const item of renderSet.items) {
            entries[`${item.id}.svg`] = strToU8(item.svg)
        }
        return zipSync(entries)
    }

    /**
     * Reports boardview export availability for one document.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {{ status: string, reason: string }} Availability row.
     */
    static #boardviewStatus(document) {
        if (CircuitJsonBoardviewExporter.hasBoardview(document)) {
            return { status: 'available', reason: '' }
        }
        return {
            status: 'unavailable',
            reason: 'No component or pad metadata is available.'
        }
    }

    /**
     * Maps manufacturing export availability rows by id.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {Record<string, { status: string, reason: string }>} Availability by export id.
     */
    static #manufacturingStatus(document) {
        const rows = ManufacturingService.listExports(document)
        const mapped = {}
        for (const row of rows) {
            mapped[row.id] = { status: row.status, reason: row.reason ?? '' }
        }
        return mapped
    }

    /**
     * Derives the output base file name from the document source.
     * @param {unknown} document DocumentResult, CircuitJSON model, or context.
     * @returns {string} Base file name without output extension.
     */
    static #baseName(document) {
        const raw = String(document?.source?.fileName ?? '').trim()
        const segment = raw.split(/[\\/]/).pop() ?? ''
        const stripped = segment.replace(/\.[^.]*$/, '')
        return stripped || segment || 'fabrication-package'
    }

    /**
     * Extracts a user-facing reason from one conversion failure.
     * @param {unknown} error Thrown error.
     * @returns {string} Reason text.
     */
    static #reason(error) {
        const message = error instanceof Error ? error.message : String(error)
        return message || 'Conversion failed.'
    }
}
