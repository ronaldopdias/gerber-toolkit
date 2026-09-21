import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIME_TYPES = new Map([
    ['.html', 'text/html;charset=utf-8'],
    ['.css', 'text/css;charset=utf-8'],
    ['.mjs', 'text/javascript;charset=utf-8'],
    ['.js', 'text/javascript;charset=utf-8'],
    ['.cjs', 'text/javascript;charset=utf-8'],
    ['.json', 'application/json;charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.wasm', 'application/wasm'],
    ['.map', 'application/json'],
    ['.md', 'text/markdown;charset=utf-8'],
    ['.txt', 'text/plain;charset=utf-8']
])

/**
 * Static file server for the local gerber-toolkit conversion GUI.
 */
export class GuiStaticServer {
    /**
     * Starts one static server.
     * @param {string} root Directory root served over HTTP.
     * @param {{ port?: number, host?: string }} [options] Listen options.
     * @returns {Promise<import('node:http').Server>} Listening server.
     */
    static async start(root, options = {}) {
        const server = createServer((request, response) => {
            GuiStaticServer.#serve(root, request, response).catch(() => {
                response.statusCode = 500
                response.end('Internal server error.')
            })
        })
        // Deep browser module graphs idle pooled sockets while one dependency
        // level parses; a closed pooled socket can strand the next request
        // batch mid-flight. Serve each request on a fresh connection instead.
        server.keepAliveTimeout = 65_000
        server.headersTimeout = 66_000
        const port = options.port ?? 8461
        const host = options.host ?? '127.0.0.1'
        await new Promise((resolveListen, rejectListen) => {
            server.once('error', rejectListen)
            server.listen(port, host, () => resolveListen())
        })
        return server
    }

    /**
     * Serves one HTTP request from the root.
     * @param {string} root Directory root.
     * @param {import('node:http').IncomingMessage} request Incoming request.
     * @param {import('node:http').ServerResponse} response Server response.
     * @returns {Promise<void>} Resolves after the response is sent.
     */
    static async #serve(root, request, response) {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const relative = decodeURIComponent(url.pathname)
        if (process.env.GUI_SERVE_LOG) {
            console.log(`request ${relative}`)
        }
        const filePath = GuiStaticServer.#resolveSafe(root, relative)
        if (!filePath) {
            response.statusCode = 403
            response.end('Forbidden.')
            return
        }
        try {
            const info = await stat(filePath)
            if (info.isDirectory()) {
                response.statusCode = 404
                response.end('Not found.')
                return
            }
        } catch {
            response.statusCode = 404
            response.end('Not found.')
            return
        }
        const body = await readFile(filePath)
        response.statusCode = 200
        response.setHeader(
            'Content-Type',
            MIME_TYPES.get(extname(filePath).toLowerCase()) ??
                'application/octet-stream'
        )
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Connection', 'close')
        response.end(body)
    }

    /**
     * Resolves one URL path inside the root, rejecting traversal.
     * @param {string} root Directory root.
     * @param {string} relative Decoded URL path.
     * @returns {string | null} Absolute file path or null when unsafe.
     */
    static #resolveSafe(root, relative) {
        if (relative === '/' || relative === '') {
            relative = '/gui/index.html'
        }
        const normalized = resolve(root, `.${relative}`)
        const rootWithSeparator = root.endsWith(sep) ? root : root + sep
        if (!normalized.startsWith(rootWithSeparator)) {
            return null
        }
        return join(root, `.${relative}`)
    }

    /**
     * Parses the listen port from command-line arguments.
     * @param {string[]} argv Process arguments.
     * @returns {number} Listen port.
     */
    static #parsePort(argv) {
        const index = argv.indexOf('--port')
        const value = index >= 0 ? argv[index + 1] : undefined
        const port = Number.parseInt(value ?? '', 10)
        if (Number.isInteger(port) && port > 0 && port < 65536) {
            return port
        }
        return 8461
    }

    /**
     * Runs the server as the main script and prints the local URL.
     * @param {string[]} argv Process arguments.
     * @returns {Promise<void>} Resolves when the server has started.
     */
    static async main(argv) {
        const port = GuiStaticServer.#parsePort(argv)
        const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
        try {
            await GuiStaticServer.start(root, { port })
            console.log(`Gerber converter GUI: http://127.0.0.1:${port}/`)
            console.log('Press Ctrl+C to stop.')
        } catch (error) {
            console.error(
                `Could not start the server on port ${port}:`,
                error.message
            )
            process.exitCode = 1
        }
    }
}

const isMainScript = process.argv[1] === fileURLToPath(import.meta.url)

if (isMainScript) {
    await GuiStaticServer.main(process.argv)
}
