# gerber-toolkit

Browser-safe Gerber and Excellon parsing into immutable CircuitJSON document
envelopes, plus the shared ECAD rendering, interaction, query, manufacturing,
simulation, and 3D scene APIs.

## Breaking API convergence

Version 0.2.0 intentionally changes root names, parameters, return shapes, and
package subpaths. The root now exposes the same 18-class API as
`circuitjson-toolkit`, `altium-toolkit`, and `kicad-toolkit`. `Parser.parse()`
returns an `ecad-toolkit.document.v1` envelope whose `model` is CircuitJSON,
and `ProjectLoader.load()` returns an `ecad-toolkit.project.v1` envelope.

Version 0.3.0 updates the shared runtime baseline to CircuitJSON Toolkit 1.2
and makes performance release gates hardware-aware. Comparable environments
retain their absolute and relative timing thresholds, while different hardware
still has to pass the deterministic structural and size gates. See the
[0.3.0 release notes](docs/release-notes-v0.3.0.md).

Version 0.4.0 adopts newly decoded CircuitJSON and native extension graphs at
the shared validation boundary. Their ordinary nodes retain identity and are
deeply frozen without a redundant defensive graph copy. Parser parameters,
document envelopes, extension fields, and return shapes remain unchanged. See
the [0.4.0 release notes](docs/release-notes-v0.4.0.md).

Version 0.4.1 keeps unordered endpoint reconstruction for discovering board
profiles, but requires inferred dark cutouts on ambiguous mechanical layers to
follow a directed, source-order-continuous closed path. Gerber regions,
clear-polarity contours, and authoritative X2 `FileFunction=Profile` layers
retain their explicit cutout semantics. Closure checks now use normalized
segment endpoints, and sampled arcs are normalized once as they enter profile
projection instead of repeatedly normalizing growing paths. Public APIs and
return shapes remain unchanged. See the
[0.4.1 release notes](docs/release-notes-v0.4.1.md).

Version 0.4.2 supersedes 0.4.1 with parser-owned draw-run provenance and a
material-aware containment tree. D02 moves, flashes, polarity transitions,
regions, and step-repeat instances can no longer be collapsed into one inferred
cutout path. Ineligible artwork remains transparent to nested material parity,
while X2 profiles, Gerber regions, clear geometry, fragmented outer profiles,
and disjoint boards retain their established behavior. Chunked chaining and an
indexed contour-boundary test also remove the quadratic growth and large-array
overflow paths found during release review. Canonical envelopes and service
return shapes are unchanged; native line and arc primitives add
`sourcePathId`. See the
[0.4.2 release notes](docs/release-notes-v0.4.2.md).

Version 0.4.3 gives generated Gerber 3D scenes source-neutral via masking.
Plated via annuli use the authored copper flash diameter and are tented on each
mask-bearing surface by default. A surface stays open only when the via lies
inside a larger copper pad that is opened by that side's solder-mask artwork,
including offset and rotated via-in-pad geometry. See the
[0.4.3 release notes](docs/release-notes-v0.4.3.md).

Version 0.4.4 scales large copper-image unions by separating spatially
independent polygon components before bounded composition, while falling back
to the conservative union path when separation cannot be proven cheaply. It
also prevents via-owned flashes from being exposed as host-pad mask openings
and re-exports the shared self-adjusting computation runtime. See the
[0.4.4 release notes](docs/release-notes-v0.4.4.md).

No Gerber functionality was removed. The complete 0.1.21 parser, renderer,
interaction, and native 3D APIs remain available from
`gerber-toolkit/extensions`. See the [migration guide](docs/migration.md).

## Features

- Parses RS-274X Gerber and Excellon sources in browsers and Node.js.
- Projects representable board, copper, solder-mask, paste, legend,
  documentation, and drill geometry into CircuitJSON. X2 `TO.C`, `TO.P`, and
  `TO.N` attributes become components, ports, and connectivity only when those
  source attributes establish the ownership explicitly.
- Preserves disjoint board outlines and cutouts, ordered dark/clear image
  composition, X2 `FilePolarity`, legacy `IPNEG`, aperture holes, macro/block
  transforms, plated/non-plated hits, and straight routed slots.
- Loads `{ name, data }` entry arrays and expands a single ZIP entry internally
  with bounded entry, byte, compression-ratio, and path checks.
- Uses one common parser/project contract with progress, cancellation, workers,
  assets, source retention, typed errors, and discriminated `try*` results.
- Uses the shared CircuitJSON context, SVG/BOM renderers, interaction indexes,
  queries, manufacturing exports, injected simulation, and 3D scene services.
- Re-exports the canonical `SelfAdjustingComputation` runtime for persistent
  consumers with explicit mutable input boundaries.
- Retains exact native fabrication geometry on request through the Gerber
  extension namespace.
- Uses bounded polygon composition only for artwork that needs it; ordinary
  traces and pads retain their compact canonical rows and stable identities.
- Runs locally; parsing does not send source data over the network.

## Install

```bash
npm install gerber-toolkit
```

## Usage

```js
import {
    CircuitJsonDocumentContext,
    Parser,
    PcbInteractionIndex,
    PcbScene3dBuilder,
    PcbSvgRenderer,
    QueryService
} from 'gerber-toolkit'

const document = await Parser.parseAsync(
    { fileName: file.name, data: await file.arrayBuffer() },
    { worker: 'auto' }
)
const context = CircuitJsonDocumentContext.prepare(document, {
    indexes: ['elements', 'relations', 'connectivity', 'spatial']
})

const svg = PcbSvgRenderer.render(context)
const hits = PcbInteractionIndex.create(context).hitTest({ x: 10, y: 5 })
const components = QueryService.create(context).query({
    select: 'components'
})
const scene = PcbScene3dBuilder.build(context)

console.log(document.model, svg, hits, components.items, scene)
```

Load several fabrication files, or one ZIP blob, without an app adapter:

```js
import { ProjectLoader } from 'gerber-toolkit/project'

const project = await ProjectLoader.loadAsync([
    { name: 'board.zip', data: zipArrayBuffer }
])

console.log(project.documents[0].model)
```

Optional renderer CSS is available through:

```js
import 'gerber-toolkit/styles/renderers.css'
```

Use the exact native API deliberately when it is required:

```js
import {
    GerberParser,
    GerberPcbSvgRenderer,
    PcbScene3dBuilder
} from 'gerber-toolkit/extensions'

const nativeDocument = GerberParser.parseArrayBuffer(file.name, arrayBuffer)
const nativeSvg = GerberPcbSvgRenderer.render(nativeDocument)
const nativeScene = PcbScene3dBuilder.build(nativeDocument)
```

## Conversion GUI

A local browser GUI converts fabrication packages without writing any code.
Start it from the repository root:

```bash
npm run gui        # or: node gui/serve.mjs
```

Then open <http://127.0.0.1:8461>. Use `--port <n>` to choose another port.
Add Gerber, Excellon, and ZIP files (or drag them onto the page), load the
project, and download every available output:

- CircuitJSON model (`.circuit.json`)
- Combined PCB SVG (`.pcb.svg`) and one SVG per layer in a ZIP archive
- Bill of materials HTML (`.bom.html`)
- 3D scene JSON (`.scene3d.json`)
- Pick-and-place CSV and fabrication notes JSON when the source metadata
  provides components or notes
- Specctra DSN routing (`.dsn`) when the document contains routable geometry
- Boardview (`.brd`, OpenBoardView/FlexBV BRD2) when the source
  carries component and pad metadata
- KiCad PCB (`.kicad_pcb`) with copper traces, pours, pads, and nets — the
  format to use when you need to _see_ the copper (KiCad, BVSense, and other
  viewers render it)

Use **Download all (ZIP)** to bundle every available output into one archive.

Boardview export derives pad nets from copper connectivity: it unions each
layer's pads, traces, and pours so pads sharing copper get the same net, and
labels them with the real net name wherever the source carries one (X2 `%TO.N`
attributes) or a stable `Net_N` otherwise. Component reference designators and
pin names still require component metadata (X2 `%TO`/`%TF` or a netlist); bare
copper files therefore yield a connectivity-accurate boardview with generic
part names rather than a full CAD-quality one.

Formats that the loaded data cannot support are listed as unavailable with
the reason, matching the toolkit's honest availability model. Everything
runs locally in the browser; no file content leaves the machine.

### Desktop app (Electron)

The same GUI runs as a desktop window. Electron is a dev dependency
(`npm install` pulls it in); launch it from the repository root:

```bash
npm run electron
```

It starts the bundled static server on a private loopback port and opens the
converter in one window — no separate `serve.mjs` process required.

## Documentation

- [API](docs/api.md)
- [Capabilities](docs/capabilities.md)
- [Migration from 0.1.21](docs/migration.md)
- [0.4.4 release notes](docs/release-notes-v0.4.4.md)
- [0.4.3 release notes](docs/release-notes-v0.4.3.md)
- [0.4.2 release notes](docs/release-notes-v0.4.2.md)
- [0.4.1 release notes](docs/release-notes-v0.4.1.md)
- [0.4.0 release notes](docs/release-notes-v0.4.0.md)
- [0.3.0 release notes](docs/release-notes-v0.3.0.md)
- [0.2.0 release notes](docs/release-notes-v0.2.0.md)
- [Model format](docs/model-format.md)
- [Testing and performance](docs/testing.md)
- [Library scope](spec/library-scope.md)

## Development

```bash
npm install
npm test
npm run check:features -- --strict
npm run benchmark
npm run check:format
```

## License

The software is available under GPL-3.0-or-later or a separate commercial
license. Documentation and non-code text are licensed under CC-BY-SA-4.0 unless
otherwise marked. See [LICENSE](LICENSE),
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md), and [NOTICE.md](NOTICE.md).
