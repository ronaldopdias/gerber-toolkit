import { app, BrowserWindow, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { GuiStaticServer } from '../serve.mjs'

// Repository root: two levels up from gui/electron/main.mjs. The static server
// serves the whole tree so /src, /node_modules, and /gui all resolve exactly
// as they do for the browser build.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** @type {import('node:http').Server | null} */
let server = null

/**
 * Starts the bundled static server on an ephemeral loopback port and opens the
 * converter in one desktop window.
 * @returns {Promise<void>} Resolves once the window has loaded.
 */
async function createWindow() {
    if (!server) {
        server = await GuiStaticServer.start(ROOT, {
            port: 0,
            host: '127.0.0.1'
        })
    }
    const { port } = /** @type {{ port: number }} */ (server.address())
    const window = new BrowserWindow({
        width: 1180,
        height: 940,
        title: 'gerber-toolkit converter',
        backgroundColor: '#f5f7f7',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    })
    // Keep external links in the user's browser rather than the app shell.
    window.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url)
        return { action: 'deny' }
    })
    await window.loadURL(`http://127.0.0.1:${port}/`)
}

app.whenReady().then(createWindow)

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
    server?.close()
    server = null
    if (process.platform !== 'darwin') app.quit()
})
