import { ProjectLoader } from 'gerber-toolkit'
import { ConversionService } from './ConversionService.mjs'
import { PcbPreviewDocument } from './PcbPreviewDocument.mjs'

const MAX_PREVIEW_BYTES = 12_000_000

/**
 * Browser application wiring for the Gerber conversion GUI.
 */
export class GuiApp {
    /** Loaded canonical document, or null before the first successful load. */
    #document = null
    /** Selected source files as File objects. */
    #files = []
    /** DOM elements used by the application. */
    #elements = {}

    /**
     * Prepares the application against the page DOM.
     */
    constructor() {
        const byId = (id) => document.getElementById(id)
        this.#elements = {
            dropZone: byId('drop-zone'),
            fileInput: byId('file-input'),
            browseButton: byId('browse-button'),
            fileList: byId('file-list'),
            loadButton: byId('load-button'),
            resetButton: byId('reset-button'),
            status: byId('status'),
            stats: byId('stats'),
            preview: byId('preview'),
            targets: byId('targets'),
            downloadAllButton: byId('download-all-button')
        }
        this.#wire()
        this.#renderFiles()
        this.#setStatus(
            'Add Gerber, Excellon, or ZIP files, then load the project.'
        )
    }

    /**
     * Wires every static event listener once.
     * @returns {void}
     */
    #wire() {
        const {
            dropZone,
            fileInput,
            browseButton,
            loadButton,
            resetButton,
            downloadAllButton
        } = this.#elements
        browseButton.addEventListener('click', () => fileInput.click())
        fileInput.addEventListener('change', () => {
            this.#addFiles(Array.from(fileInput.files ?? []))
            fileInput.value = ''
        })
        for (const type of ['dragenter', 'dragover']) {
            dropZone.addEventListener(type, (event) => {
                event.preventDefault()
                dropZone.classList.add('drop-zone--active')
            })
        }
        for (const type of ['dragleave', 'drop']) {
            dropZone.addEventListener(type, () =>
                dropZone.classList.remove('drop-zone--active')
            )
        }
        dropZone.addEventListener('drop', (event) => {
            event.preventDefault()
            this.#addFiles(Array.from(event.dataTransfer?.files ?? []))
        })
        loadButton.addEventListener('click', () => {
            this.#loadProject().catch((error) => this.#showError(error))
        })
        resetButton.addEventListener('click', () => this.#reset())
        downloadAllButton.addEventListener('click', () => this.#downloadAll())
    }

    /**
     * Adds picked or dropped files to the selection.
     * @param {File[]} incoming Incoming files.
     * @returns {void}
     */
    #addFiles(incoming) {
        for (const file of incoming) {
            if (!this.#files.some((existing) => existing.name === file.name)) {
                this.#files.push(file)
            }
        }
        this.#renderFiles()
    }

    /**
     * Removes one file from the selection by index.
     * @param {number} index File index.
     * @returns {void}
     */
    #removeFile(index) {
        this.#files.splice(index, 1)
        this.#renderFiles()
    }

    /**
     * Clears the selection and every loaded result.
     * @returns {void}
     */
    #reset() {
        this.#files = []
        this.#document = null
        this.#renderFiles()
        this.#renderStats(null)
        this.#renderTargets()
        this.#elements.preview.hidden = true
        this.#elements.preview.removeAttribute('srcdoc')
        this.#setStatus(
            'Add Gerber, Excellon, or ZIP files, then load the project.'
        )
    }

    /**
     * Renders the selected file list.
     * @returns {void}
     */
    #renderFiles() {
        const list = this.#elements.fileList
        list.replaceChildren()
        this.#elements.loadButton.disabled = this.#files.length === 0
        this.#files.forEach((file, index) => {
            const row = document.createElement('li')
            const name = document.createElement('span')
            name.className = 'file-name'
            name.textContent = file.name
            const size = document.createElement('span')
            size.className = 'file-size'
            size.textContent = GuiApp.#formatBytes(file.size)
            const remove = document.createElement('button')
            remove.type = 'button'
            remove.className = 'file-remove'
            remove.textContent = 'Remove'
            remove.setAttribute('aria-label', `Remove ${file.name}`)
            remove.addEventListener('click', () => this.#removeFile(index))
            row.append(name, size, remove)
            list.append(row)
        })
    }

    /**
     * Loads the selected files as one fabrication project.
     * @returns {Promise<void>} Resolves after results render.
     */
    async #loadProject() {
        const files = [...this.#files]
        if (files.length === 0) return
        this.#elements.loadButton.disabled = true
        this.#setStatus('Loading project…')
        const entries = await Promise.all(
            files.map(async (file) => ({
                name: file.name,
                data: await file.arrayBuffer()
            }))
        )
        const result = ProjectLoader.tryLoad(entries, { worker: false })
        if (!result.ok) {
            this.#document = null
            this.#renderTargets()
            this.#setStatus('Project loading failed.')
            this.#showError(result.error, result.diagnostics)
            return
        }
        this.#document = result.value.documents[0] ?? null
        this.#renderStats(result.value)
        this.#renderTargets()
        const previewNote = await this.#renderPreview()
        const layerCount = result.value.statistics?.loadedLayerCount ?? 0
        const summary = `Loaded ${files.length} file${files.length === 1 ? '' : 's'} into one document (${layerCount} fabrication layer${layerCount === 1 ? '' : 's'}).`
        this.#setStatus(previewNote ? `${summary} ${previewNote}` : summary)
    }

    /**
     * Renders project statistics and diagnostics.
     * @param {unknown} project Project envelope or null.
     * @returns {void}
     */
    #renderStats(project) {
        const stats = this.#elements.stats
        if (!project) {
            stats.hidden = true
            stats.replaceChildren()
            return
        }
        const statistics = project.statistics ?? {}
        const summary = [
            `fabrication layers: ${statistics.loadedLayerCount ?? 0}`,
            `companion assets kept: ${statistics.assetCount ?? 0}`,
            `unresolved entries: ${statistics.failureCount ?? 0}`
        ]
        const diagnostics = Array.isArray(project.diagnostics)
            ? project.diagnostics
            : []
        stats.hidden = false
        stats.replaceChildren(
            GuiApp.#text('p', summary.join(' · ')),
            ...diagnostics.map((entry) =>
                GuiApp.#text(
                    'p',
                    `${entry.severity ?? 'info'}: ${entry.message ?? JSON.stringify(entry)}`,
                    'diagnostic'
                )
            )
        )
    }

    /**
     * Renders the conversion target table.
     * @returns {void}
     */
    #renderTargets() {
        const container = this.#elements.targets
        const downloadAll = this.#elements.downloadAllButton
        container.replaceChildren()
        if (!this.#document) {
            const empty = GuiApp.#text(
                'p',
                'Load a project to see which output files are available.',
                'muted'
            )
            container.append(empty)
            if (downloadAll) downloadAll.disabled = true
            return
        }
        let available = 0
        for (const row of ConversionService.listTargets(this.#document)) {
            if (row.status === 'available') available += 1
            container.append(this.#renderTargetRow(row))
        }
        if (downloadAll) downloadAll.disabled = available === 0
    }

    /**
     * Renders one conversion target row.
     * @param {object} row Availability row from ConversionService.
     * @returns {HTMLElement} Row element.
     */
    #renderTargetRow(row) {
        const item = document.createElement('li')
        item.className = 'target-row'
        const info = document.createElement('div')
        info.className = 'target-info'
        const label = GuiApp.#text('span', row.label, 'target-label')
        const file = GuiApp.#text('span', row.fileName, 'target-file')
        info.append(label, file)
        if (row.reason) {
            info.append(GuiApp.#text('span', row.reason, 'target-reason'))
        }
        const status = GuiApp.#text(
            'span',
            row.status === 'available' ? 'Available' : 'Not available',
            `status status--${row.status === 'available' ? 'available' : 'unavailable'}`
        )
        const download = document.createElement('button')
        download.type = 'button'
        download.textContent = 'Download'
        download.disabled = row.status !== 'available'
        download.addEventListener('click', () => this.#download(row.id))
        item.append(info, status, download)
        return item
    }

    /**
     * Renders the combined PCB SVG preview.
     * @returns {Promise<string>} Empty string when shown, else a short note.
     */
    async #renderPreview() {
        const frame = this.#elements.preview
        frame.hidden = true
        frame.removeAttribute('srcdoc')
        if (!this.#document) return ''
        const result = ConversionService.convert(this.#document, 'pcb-svg')
        if (!result.ok) {
            return `Preview unavailable: ${result.reason}`
        }
        if (result.data.length > MAX_PREVIEW_BYTES) {
            return 'Preview skipped: the rendering is too large to inline.'
        }
        const svg = new TextDecoder().decode(result.data)
        frame.srcdoc = PcbPreviewDocument.render(svg)
        frame.hidden = false
        return ''
    }

    /**
     * Converts one target and triggers a browser download.
     * @param {string} targetId Conversion target id.
     * @returns {void}
     */
    #download(targetId) {
        if (!this.#document) return
        const result = ConversionService.convert(this.#document, targetId)
        if (!result.ok) {
            this.#setStatus(`Conversion failed: ${result.reason}`)
            return
        }
        this.#triggerDownload(result.data, result.fileName, result.mediaType)
        this.#setStatus(`Downloaded ${result.fileName}.`)
    }

    /**
     * Bundles every available output into one ZIP and triggers its download.
     * @returns {void}
     */
    #downloadAll() {
        if (!this.#document) return
        const result = ConversionService.bundleAll(this.#document)
        if (!result.ok) {
            this.#setStatus(`Bundle failed: ${result.reason}`)
            return
        }
        this.#triggerDownload(result.data, result.fileName, result.mediaType)
        const count = result.included.length
        const skipped = result.skipped.length
            ? ` ${result.skipped.length} unavailable format${result.skipped.length === 1 ? '' : 's'} skipped.`
            : ''
        this.#setStatus(
            `Downloaded ${result.fileName} with ${count} output${count === 1 ? '' : 's'}.${skipped}`
        )
    }

    /**
     * Starts a browser download for one blob payload.
     * @param {Uint8Array} data Encoded file bytes.
     * @param {string} fileName Suggested download file name.
     * @param {string} mediaType Blob media type.
     * @returns {void}
     */
    #triggerDownload(data, fileName, mediaType) {
        const blob = new Blob([data], { type: mediaType })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = fileName
        link.rel = 'noopener'
        // Anchor must be in the document for the click to start a download in
        // every browser; revoking is deferred so the browser can finish reading
        // large blobs before the object URL is released.
        document.body.append(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1_000)
    }

    /**
     * Renders one error with optional diagnostics.
     * @param {unknown} error Toolkit or runtime error.
     * @param {unknown[]} [diagnostics] Optional diagnostic rows.
     * @returns {void}
     */
    #showError(error, diagnostics = []) {
        const details = [
            `code: ${error?.code ?? 'n/a'}`,
            `message: ${error?.message ?? String(error)}`
        ]
        console.error(error)
        for (const entry of diagnostics) console.error(entry)
        this.#setStatus(details.join(' · '), 'status--error')
    }

    /**
     * Updates the status line.
     * @param {string} message Status text.
     * @param {string} [modifier] Optional CSS modifier.
     * @returns {void}
     */
    #setStatus(message, modifier = '') {
        const status = this.#elements.status
        status.textContent = message
        status.className = `status-line${modifier ? ` ${modifier}` : ''}`
    }

    /**
     * Creates one text element.
     * @param {string} tag Element tag name.
     * @param {string} text Text content.
     * @param {string} [className] Optional class name.
     * @returns {HTMLElement} Text element.
     */
    static #text(tag, text, className = '') {
        const element = document.createElement(tag)
        element.textContent = text
        if (className) element.className = className
        return element
    }

    /**
     * Formats one byte count for display.
     * @param {number} bytes Byte count.
     * @returns {string} Formatted size.
     */
    static #formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }
}

new GuiApp()
