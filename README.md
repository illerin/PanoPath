# PanoPath

A self-hosted Docker tool for building interactive 360° panorama tours. Upload panorama images, add hotspots, configure branding, place floor plan dots, then export a self-contained ZIP you can host anywhere.

## Features

- Upload equirectangular panoramas (JPG, PNG, HEIC/HEIF, TIFF, WebP)
- Non-panorama images are supported — padded onto a white canvas automatically
- Multi-resolution cube face tiling (server-side, no GPU required)
- Info hotspots (click to expand text) and link hotspots (navigate between scenes)
- 6 link hotspot icon styles with colour-coded backgrounds, fully customisable colours
- Floor plan overlay with per-scene dot placement, circle or direction arrow style
- Branding panel: logo, 3 buttons with custom text/background colours and new-tab toggle
- Settings: autorotate, fullscreen button, zoom buttons, compass, mouse mode
- Set starting view per scene and set which scene loads first
- Live preview of branding in the editor
- Export as self-contained ZIP (HTML + tiles + project.json)
- Save and load projects from the server, or import/export via ZIP
- Fully local — no cloud uploads, no accounts

## Quick Start

```bash
git clone <this-repo>
cd panopath
docker-compose up -d
```

Open **http://localhost:3098** in your browser.

## Usage

### Building a tour

1. **Add panoramas** — drag and drop images onto the tool, or click **+ Add**
2. **Set initial view** — pan to your preferred angle in the viewer, then click **Set View** in the toolbar
3. **Set first scene** — in the right props panel, click **Set as First** on the scene that should load first
4. **Add hotspots** — click **Info Hotspot** or **Link Hotspot** in the toolbar, then click in the panorama to place
5. **Configure branding** — click **Branding** to set logo, button labels, URLs, and colours
6. **Floor plan** — click **Plan View** to upload a floor plan, then place dots on each scene from the props panel
7. **Export** — click **Export** to download a ZIP

### Saving and continuing a project

Projects can be saved to the server at any time:

1. Click **Save Project** and enter a name
2. Click **Load Project** to resume from a saved project

Alternatively, export a ZIP — it includes `project.json` which can be re-imported via **Load Project > From ZIP**.

The Docker container must be running with the `panopath_tiles` volume intact for tile data to be available when loading a project.

## Deploying the exported tour

The ZIP works on any static web server:

```bash
unzip my-tour.zip -d my-tour
cd my-tour
# Python quick server:
python3 -m http.server 8080
# Or upload to Netlify, GitHub Pages, nginx, Apache, etc.
```

### Offline use

The viewer loads `marzipano.js` from a CDN by default. For fully offline use:

1. Download: `https://cdn.jsdelivr.net/npm/marzipano@0.10.2/dist/marzipano.js`
2. Place it in the extracted folder
3. In `index.html`, replace the CDN script tag with: `<script src="marzipano.js"></script>`

## Supported image formats

| Format | Notes |
|--------|-------|
| JPEG / JPG | Recommended for panoramas |
| PNG | Supported including transparency (alpha flattened to white) |
| HEIC / HEIF | Phone photos — converted automatically |
| TIFF | Supported |
| WebP | Supported |

**Panorama detection**: images with a 1.7:1 to 2.4:1 aspect ratio are treated as equirectangular panoramas. Other images are centred on a white 2048x1024 canvas.

## File structure

```
panopath/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server/
│   └── index.js          # Express server, image processing, export
└── public/
    ├── index.html         # Editor UI
    ├── css/
    │   └── tool.css       # Editor styles
    └── js/
        └── tool.js        # Editor logic
```

## Updating files without rebuilding

For static file changes (HTML/CSS/JS), copy directly into the running container:

```bash
docker cp public/index.html panopath:/app/public/index.html
docker cp public/js/tool.js panopath:/app/public/js/tool.js
docker cp public/css/tool.css panopath:/app/public/css/tool.css
```

For server changes (`server/index.js`):

```bash
docker cp server/index.js panopath:/app/server/index.js
docker restart panopath
```

For dependency changes (`package.json`), rebuild:

```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## Data persistence

Tile images are stored in the `panopath_tiles` Docker volume. This persists across container restarts and is required for **Load Project** to work.

To back up your tile data:

```bash
docker run --rm -v panopath_tiles:/data -v $(pwd):/backup alpine \
  tar czf /backup/panopath-tiles-backup.tar.gz /data
```

To restore:

```bash
docker run --rm -v panopath_tiles:/data -v $(pwd):/backup alpine \
  tar xzf /backup/panopath-tiles-backup.tar.gz -C /
```

## License

MIT. Built on [Marzipano](https://github.com/google/marzipano) (Apache 2.0) by Google.
