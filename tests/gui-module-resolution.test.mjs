import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Reads the browser import map declared in the GUI entry page.
 * @returns {Record<string, string>} Specifier-to-URL map.
 */
function readImportMap() {
    const html = readFileSync(resolve(REPO_ROOT, 'gui/index.html'), 'utf8')
    const match = html.match(
        /<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i
    )
    assert.ok(match, 'gui/index.html must declare an import map')
    return JSON.parse(match[1]).imports ?? {}
}

/**
 * Strips comments so commented-out imports are not mistaken for real ones,
 * while leaving protocol-relative URLs (`http://`) intact.
 * @param {string} source Module source text.
 * @returns {string} Source without comments.
 */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Reports whether a captured token is shaped like a real module specifier, so
 * the word "from" appearing inside string data or object keys is ignored.
 * @param {string} value Captured token.
 * @returns {boolean} True when it is a relative path, node builtin, or package.
 */
function isModuleSpecifier(value) {
    if (
        value.startsWith('./') ||
        value.startsWith('../') ||
        value.startsWith('/') ||
        value.startsWith('node:')
    ) {
        return true
    }
    return /^(@[\w.-]+\/)?[\w.-]+(\/[\w.-]+)*$/.test(value)
}

/**
 * Extracts every module specifier a browser would fetch for one source file.
 * @param {string} source Module source text.
 * @returns {string[]} Specifiers from static, side-effect, and dynamic imports.
 */
function extractSpecifiers(source) {
    const clean = stripComments(source)
    const specifiers = new Set()
    const patterns = [
        /\bfrom\s*['"]([^'"]+)['"]/g,
        /(?:^|[\n;{}()])\s*import\s*['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    ]
    for (const pattern of patterns) {
        let hit
        while ((hit = pattern.exec(clean)) !== null) {
            if (isModuleSpecifier(hit[1])) {
                specifiers.add(hit[1])
            }
        }
    }
    return [...specifiers]
}

/**
 * Resolves one bare specifier through the import map using the browser
 * algorithm: an exact key wins, otherwise the longest trailing-slash prefix.
 * @param {string} specifier Bare specifier.
 * @param {Record<string, string>} imports Import map entries.
 * @returns {string | null} Mapped URL or null when unmapped.
 */
function resolveBare(specifier, imports) {
    if (Object.hasOwn(imports, specifier)) {
        return imports[specifier]
    }
    let best = null
    for (const key of Object.keys(imports)) {
        if (
            key.endsWith('/') &&
            specifier.startsWith(key) &&
            (best === null || key.length > best.length)
        ) {
            best = key
        }
    }
    return best === null ? null : imports[best] + specifier.slice(best.length)
}

/**
 * Resolves one specifier from an importer URL to a server-absolute path.
 * @param {string} specifier Import specifier.
 * @param {string} importerUrl Importer server path.
 * @param {Record<string, string>} imports Import map entries.
 * @returns {string | null} Server-absolute path or null when unresolved.
 */
function resolveSpecifier(specifier, importerUrl, imports) {
    if (
        specifier.startsWith('/') ||
        specifier.startsWith('./') ||
        specifier.startsWith('../')
    ) {
        return new URL(specifier, `http://gui${importerUrl}`).pathname
    }
    return resolveBare(specifier, imports)
}

/**
 * Maps a server-absolute path to its file on disk under the served root.
 * @param {string} serverPath Server-absolute path.
 * @returns {string} Absolute file-system path.
 */
function toDiskPath(serverPath) {
    return resolve(REPO_ROOT, `.${serverPath}`)
}

test('every GUI module specifier resolves to a file the server can serve', () => {
    const imports = readImportMap()
    const queue = ['/gui/GuiApp.mjs']
    const seen = new Set(queue)
    const failures = []

    while (queue.length > 0) {
        const importerUrl = queue.shift()
        const diskPath = toDiskPath(importerUrl)
        if (!existsSync(diskPath) || !statSync(diskPath).isFile()) {
            failures.push(`entry module is missing: ${importerUrl}`)
            continue
        }
        const source = readFileSync(diskPath, 'utf8')
        for (const specifier of extractSpecifiers(source)) {
            if (specifier.startsWith('node:')) {
                failures.push(
                    `${importerUrl}: imports Node builtin "${specifier}", which a browser cannot load`
                )
                continue
            }
            const resolved = resolveSpecifier(specifier, importerUrl, imports)
            if (resolved === null) {
                failures.push(
                    `${importerUrl}: bare specifier "${specifier}" is not in the import map`
                )
                continue
            }
            const target = toDiskPath(resolved)
            if (!existsSync(target) || !statSync(target).isFile()) {
                failures.push(
                    `${importerUrl}: "${specifier}" -> ${resolved} does not exist`
                )
                continue
            }
            if (!seen.has(resolved)) {
                seen.add(resolved)
                queue.push(resolved)
            }
        }
    }

    assert.deepEqual(failures, [], failures.join('\n'))
    // Guard against a vacuous pass: the GUI pulls in the whole toolkit graph,
    // so reaching only a handful of modules would mean extraction silently
    // stopped following imports.
    assert.ok(
        seen.size > 20,
        `expected the module graph to be traversed, only saw ${seen.size} modules`
    )
})
