import polygonClipping from 'polygon-clipping'

const BATCH_SIZE = 256

// polygon-clipping's sweep line is not fully robust against floating-point
// noise: two vertices that should coincide but differ by rounding (for example
// 33.467910999999816 vs 33.467911) can leave a segment unfindable in its tree
// and abort the union. These grids snap coordinates to progressively coarser
// fabrication-safe resolutions on failure. The finest grid is well below any
// Gerber/Excellon coordinate resolution, so a successful retry is geometrically
// indistinguishable from the exact result while removing the sub-nanometre
// noise that trips the sweep line.
const SNAP_GRIDS = [1e-7, 1e-6, 1e-5, 1e-4]

/** AABB-aware polygon union. */
export class GerberCircuitJsonPolygonUnion {
    /** @param {number[][][][][]} operands Inputs. @returns {number[][][][]} Union. */
    static union(operands) {
        const nonEmpty = operands.filter(
            (operand) => !Array.isArray(operand) || operand.length
        )
        if (!nonEmpty.length) return []
        if (nonEmpty.length <= BATCH_SIZE) {
            return GerberCircuitJsonPolygonUnion.#boundedUnion(nonEmpty)
        }

        const components =
            GerberCircuitJsonPolygonUnion.partitionOverlapping(nonEmpty)
        if (components.length <= 1) {
            return GerberCircuitJsonPolygonUnion.#boundedUnion(nonEmpty)
        }

        const locallyMerged = components.flatMap((component) =>
            GerberCircuitJsonPolygonUnion.#boundedUnion(component)
        )
        return GerberCircuitJsonPolygonUnion.#safeUnion(locallyMerged)
    }

    /** @param {number[][][][][]} operands Inputs. @returns {number[][][][][][]} Stable components. */
    static partitionOverlapping(operands) {
        const nonEmpty = operands.filter(
            (operand) => !Array.isArray(operand) || operand.length
        )
        const entries = []
        let scanBudget = nonEmpty.length * BATCH_SIZE
        for (let index = 0; index < nonEmpty.length; index += 1) {
            const operand = nonEmpty[index]
            const bounds = GerberCircuitJsonPolygonUnion.#bounds(operand)
            if (bounds === null) {
                // Unknown bounds disable unsafe separation.
                return [nonEmpty]
            }
            entries.push({ ...bounds, index, operand })
        }
        entries.sort(
            (left, right) => left.minX - right.minX || left.index - right.index
        )
        entries.forEach((entry, index) => {
            entry.sweepIndex = index
        })

        const parents = entries.map((_, index) => index)
        let active = []
        for (let index = 0; index < entries.length; index += 1) {
            const current = entries[index]
            scanBudget -= active.length
            if (scanBudget < 0) return [nonEmpty]
            active = active.filter(
                (candidate) => entries[candidate].maxX >= current.minX
            )
            for (const candidateIndex of active) {
                const candidate = entries[candidateIndex]
                if (
                    candidate.maxY >= current.minY &&
                    candidate.minY <= current.maxY
                ) {
                    const leftRoot = GerberCircuitJsonPolygonUnion.#root(
                        parents,
                        index
                    )
                    const rightRoot = GerberCircuitJsonPolygonUnion.#root(
                        parents,
                        candidateIndex
                    )
                    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot
                }
            }
            active.push(index)
        }

        const groups = new Map()
        for (const entry of [...entries].sort(
            (left, right) => left.index - right.index
        )) {
            const root = GerberCircuitJsonPolygonUnion.#root(
                parents,
                entry.sweepIndex
            )
            const group = groups.get(root) || []
            group.push(entry.operand)
            groups.set(root, group)
        }
        return [...groups.values()]
    }

    /** @param {number[][][][]} operand Input. @returns {{ minX: number, minY: number, maxX: number, maxY: number } | null} Bounds marker. */
    static #bounds(operand) {
        if (!Array.isArray(operand)) return null
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const polygon of operand) {
            if (!Array.isArray(polygon)) return null
            for (const ring of polygon) {
                if (!Array.isArray(ring)) return null
                for (const point of ring) {
                    if (
                        !Array.isArray(point) ||
                        !Number.isFinite(point[0]) ||
                        !Number.isFinite(point[1])
                    ) {
                        return null
                    }
                    minX = Math.min(minX, point[0])
                    minY = Math.min(minY, point[1])
                    maxX = Math.max(maxX, point[0])
                    maxY = Math.max(maxY, point[1])
                }
            }
        }
        return minX < Infinity ? { minX, minY, maxX, maxY } : null
    }

    /** @param {number[][][][][]} operands Inputs. @returns {number[][][][]} Union. */
    static #boundedUnion(operands) {
        let merged = []
        for (let offset = 0; offset < operands.length; offset += BATCH_SIZE) {
            const chunk = GerberCircuitJsonPolygonUnion.#safeUnion(
                ...operands.slice(offset, offset + BATCH_SIZE)
            )
            merged = merged.length
                ? GerberCircuitJsonPolygonUnion.#safeUnion(merged, chunk)
                : chunk
        }
        return merged
    }

    /**
     * Runs one polygon union, retrying with coordinate snapping when the
     * sweep line fails on floating-point noise.
     * @param {...number[][][][]} operands Multipolygon operands.
     * @returns {number[][][][]} Union multipolygon.
     */
    static #safeUnion(...operands) {
        try {
            return polygonClipping.union(...operands)
        } catch (error) {
            for (const grid of SNAP_GRIDS) {
                try {
                    return polygonClipping.union(
                        ...operands.map((operand) =>
                            GerberCircuitJsonPolygonUnion.#snap(operand, grid)
                        )
                    )
                } catch {
                    // Try the next, coarser grid before giving up.
                }
            }
            throw error
        }
    }

    /**
     * Snaps every coordinate of one multipolygon to a fixed grid.
     * @param {number[][][][]} operand Multipolygon operand.
     * @param {number} grid Grid resolution.
     * @returns {number[][][][]} Snapped multipolygon.
     */
    static #snap(operand, grid) {
        if (!Array.isArray(operand)) return operand
        return operand.map((polygon) =>
            polygon.map((ring) =>
                ring.map((point) => [
                    Math.round(point[0] / grid) * grid,
                    Math.round(point[1] / grid) * grid
                ])
            )
        )
    }

    /** @param {number[]} parents Parents. @param {number} index Index. @returns {number} Root. */
    static #root(parents, index) {
        let root = index
        while (parents[root] !== root) root = parents[root]
        while (parents[index] !== index) {
            const parent = parents[index]
            parents[index] = root
            index = parent
        }
        return root
    }
}

Object.freeze(GerberCircuitJsonPolygonUnion.prototype)
Object.freeze(GerberCircuitJsonPolygonUnion)
