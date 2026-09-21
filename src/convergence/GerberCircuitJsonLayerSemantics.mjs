const MAX_INNER_LAYER = 6

/** Resolves native filename and X2 layer facts for canonical projection. */
export class GerberCircuitJsonLayerSemantics {
    /**
     * Derives the physical copper layer count from positive X2 stack levels.
     * @param {Record<string, any>[]} layers Native fabrication layers.
     * @returns {number} Bounded board layer count.
     */
    static copperLayerCount(layers) {
        let count = 2
        for (const layer of layers) {
            const tokens = GerberCircuitJsonLayerSemantics.#fileFunction(layer)
            if (String(tokens[0] || '').toLowerCase() !== 'copper') continue
            for (const token of tokens) {
                const match = /^l(\d+)$/iu.exec(String(token).trim())
                if (match) count = Math.max(count, Number(match[1]))
            }
        }
        return Math.min(MAX_INNER_LAYER + 2, count)
    }

    /**
     * Resolves one layer without modifying its retained native metadata.
     * @param {Record<string, any>} layer Native fabrication layer.
     * @returns {{ kind: 'ambiguous' | 'copper' | 'documentation' | 'drill' | 'mask' | 'outline' | 'paste' | 'silkscreen', circuitLayer: string }} Projection semantics.
     */
    static resolve(layer) {
        const fileFunction =
            GerberCircuitJsonLayerSemantics.#fileFunction(layer)
        const functionName = String(fileFunction[0] || '').toLowerCase()
        if (functionName === 'copper') {
            return {
                kind: 'copper',
                circuitLayer:
                    GerberCircuitJsonLayerSemantics.#copperLayer(fileFunction)
            }
        }
        if (functionName === 'profile') {
            return { kind: 'outline', circuitLayer: 'top' }
        }
        if (functionName === 'legend') {
            return {
                kind: 'silkscreen',
                circuitLayer:
                    GerberCircuitJsonLayerSemantics.#side(fileFunction) || 'top'
            }
        }
        if (functionName === 'paste') {
            return {
                kind: 'paste',
                circuitLayer:
                    GerberCircuitJsonLayerSemantics.#side(fileFunction) || 'top'
            }
        }
        if (functionName === 'soldermask') {
            return {
                kind: 'mask',
                circuitLayer:
                    GerberCircuitJsonLayerSemantics.#side(fileFunction) || 'top'
            }
        }
        // X2 drill/hole files declare Plated or NonPlated as their function.
        if (functionName === 'plated' || functionName === 'nonplated') {
            return { kind: 'drill', circuitLayer: 'top' }
        }
        if (functionName) {
            return {
                kind: 'documentation',
                circuitLayer:
                    GerberCircuitJsonLayerSemantics.#side(fileFunction) || 'top'
            }
        }

        const role = String(layer?.role || '').toLowerCase()
        const side =
            String(layer?.side || '').toLowerCase() === 'bottom'
                ? 'bottom'
                : 'top'
        if (role === 'board-outline') {
            return { kind: 'outline', circuitLayer: side }
        }
        if (/(?:^|-)?drill(?:-|$)/u.test(role)) {
            return { kind: 'drill', circuitLayer: side }
        }
        if (/(?:^|-)?copper$/u.test(role)) {
            return { kind: 'copper', circuitLayer: side }
        }
        if (role.includes('silkscreen') || role.includes('legend')) {
            return { kind: 'silkscreen', circuitLayer: side }
        }
        if (role.includes('solder-paste') || role === 'paste') {
            return { kind: 'paste', circuitLayer: side }
        }
        if (role.includes('solder-mask') || role === 'soldermask') {
            return { kind: 'mask', circuitLayer: side }
        }
        if (layer?.isDocumentation === true || role === 'drill-map') {
            return { kind: 'documentation', circuitLayer: side }
        }
        return { kind: 'ambiguous', circuitLayer: side }
    }

    /**
     * Returns whether one layer contains board profile geometry.
     * @param {Record<string, any>} layer Native layer.
     * @returns {boolean} Whether the canonical board owns this layer.
     */
    static isBoardOutline(layer) {
        return GerberCircuitJsonLayerSemantics.resolve(layer).kind === 'outline'
    }

    /**
     * Reads X2 FileFunction tokens retained by the native parser.
     * @param {Record<string, any>} layer Native layer.
     * @returns {string[]} File function tokens.
     */
    static #fileFunction(layer) {
        const value = layer?.attributes?.file?.FileFunction
        if (Array.isArray(value)) return value.map(String)
        if (typeof value === 'string') return value.split(',').map(String)
        return []
    }

    /**
     * Maps an X2 copper function to the closest canonical copper layer.
     * @param {string[]} tokens FileFunction tokens.
     * @returns {string} Canonical layer.
     */
    static #copperLayer(tokens) {
        const side = GerberCircuitJsonLayerSemantics.#side(tokens)
        if (side) return side
        const level = tokens
            .map((token) => /^l(\d+)$/iu.exec(String(token).trim()))
            .find(Boolean)
        if (!level || Number(level[1]) <= 1) return 'top'
        const inner = Math.min(
            MAX_INNER_LAYER,
            Math.max(1, Number(level[1]) - 1)
        )
        return `inner${inner}`
    }

    /**
     * Reads an explicit top/bottom X2 token.
     * @param {string[]} tokens FileFunction tokens.
     * @returns {'bottom' | 'top' | null} Canonical side.
     */
    static #side(tokens) {
        const values = tokens.map((token) => String(token).toLowerCase())
        if (values.some((token) => /^(?:bot|bottom)$/u.test(token))) {
            return 'bottom'
        }
        if (values.some((token) => token === 'top')) return 'top'
        return null
    }
}

Object.freeze(GerberCircuitJsonLayerSemantics.prototype)
Object.freeze(GerberCircuitJsonLayerSemantics)
