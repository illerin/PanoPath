# PanoPath

[![Docker Hub](https://img.shields.io/docker/pulls/illerin/panopath?logo=docker&logoColor=white)](https://hub.docker.com/r/illerin/panopath)
[![GitHub](https://img.shields.io/badge/source-GitHub-181717?logo=github)](https://github.com/illerin/PanoPath)

A self-hosted Docker tool for building interactive 360° panorama tours. Upload images, add hotspots, configure branding, place floor plan dots, then export a self-contained ZIP you can host anywhere — fully offline, no internet required.

## Features

- Upload any image (JPG, PNG, HEIC/HEIF, TIFF, WebP) — equirectangular panoramas auto-detected
- Three projection modes per scene: **Flat**, **Panorama** (equirectangular cube map), **Fisheye** (hemisphere with configurable FOV)
- Switch projection at any time from the scene properties panel — original source image is preserved for re-processing
- Drag-and-drop scene reordering in the sidebar
- Multi-resolution cube face tiling (server-side, no GPU required)
- Info hotspots (click to expand text) and link hotspots (navigate between scenes)
- 7 link hotspot icon styles (camera, arrow, door, star, eye, location) with fully customisable colours
- Floor plan overlay with per-scene dot placement, circle or direction arrow style
- Branding: logo, 3 buttons with custom text/background colours and new-tab toggle
- Settings: autorotate, fullscreen button, zoom buttons, compass, mouse mode
- Set starting view per scene and set which scene loads first
- Live preview of branding and hotspot colours in the editor
- Style presets — save and reload all appearance settings by name
- Export as fully self-contained ZIP (HTML + tiles + Marzipano + project.json) — works offline
- Save and load projects from the server, or import/export via ZIP
- Fully local — no cloud uploads, no accounts, no internet required after first run

<img width="2560" height="1274" alt="PanoPath editor" src="https://github.com/user-attachments/assets/198e0c75-273b-4882-a283-037c9d6010a6" />

## Quick Start

No clone or build needed — pull the image directly from Docker Hub:

```bash
docker run -d \
  --name panopath \
  -p 3098:3098 \
  -v panopath_data:/app/tmp \
  --restart unless-stopped \
  illerin/panopath:latest
```

Open **http://localhost:3098** in your browser.

Or with docker-compose — create a `docker-compose.yml` with the following content and run `docker-compose up -d`:

```yaml
services:
  panopath:
    image: illerin/panopath:latest
    container_name: panopath
    ports:
      - "3098:3098"
    volumes:
      - panopath_data:/app/tmp
    environment:
      - PORT=3098
      - NODE_ENV=production
    restart: unless-stopped

volumes:
  panopath_data:
    driver: local
```

### Building from source

If you want to modify the code and rebuild the image yourself:

```bash
git clone https://github.com/illerin/PanoPath
cd PanoPath
docker-compose up -d
```

## Usage

### Building a tour

1. **Add images** — drag and drop images onto the tool, or click **+ Add**
2. **Reorder scenes** — drag scenes in the left sidebar using the ⠿ handle to set the order
3. **Set initial view** — pan to your preferred angle in the viewer, then click **Set Initial View** in the toolbar
4. **Set first scene** — in the right props panel, click **Set as First** on the scene that should load first
5. **Add hotspots** — click **Info Hotspot** or **Link Hotspot** in the toolbar, then click in the viewer to place
6. **Appearance** — click **Settings** to configure branding, hotspot colours, viewer controls, and save style presets
7. **Floor plan** — click **Floor Plan** to upload a floor plan image, then use the **Floor Plan Dot** section in the right panel to place a dot for each scene
8. **Export** — click **Export** to download a self-contained ZIP

### Projection modes

Every scene has a projection mode that can be changed at any time from the **Projection** section in the right panel. The original source image is always preserved, so switching is non-destructive.

| Mode | Description |
|------|-------------|
| **Flat** | Standard 2D image viewer — pan and zoom |
| **Panorama** | Equirectangular 360° cube map — full spherical view |
| **Fisheye** | Hemisphere projection from a circular fisheye lens — configurable FOV (90°–280°) |

When switching projection, images that don't match the target aspect ratio are automatically padded with black (2:1 for panorama, 1:1 for fisheye) so the projection math works correctly.

> **Note:** Switching projection clears any hotspots and floor plan dot on that scene, since coordinates are incompatible between projection types. A confirmation dialog appears if anything would be lost.

### Panorama detection

On import, images with a **1.9:1 to 2.15:1** aspect ratio are automatically treated as equirectangular panoramas. All other images are imported as flat scenes. You can always switch projection afterwards.

### Saving and loading projects

Projects are saved to the server and persist across sessions:

1. Click **Project → Save project** and enter a name
2. Click **Project → Open saved project…** to resume

To import a previously exported ZIP, click **Project → Import ZIP…** and select the file. Tiles and source images are extracted automatically.

The Docker container must be running with the `panopath_tiles` volume intact for tile data to be available when loading a project.

### Previewing your tour

Click **Project → Preview tour** to open the published tour in a new tab without exporting.

## The interface

The toolbar across the top contains four controls:

| Control | What it does |
|---------|-------------|
| **Project ▾** | New project, open saved project, import ZIP, save project, preview tour |
| **Settings** | Viewer controls, branding, hotspot colours, style presets |
| **Floor Plan** | Upload a floor plan image and configure dot appearance |
| **Export** | Download the tour as a self-contained ZIP |

### Settings panel (tabbed)

| Tab | Contents |
|-----|----------|
| **Viewer** | Autorotate, fullscreen button, zoom buttons, compass, mouse mode |
| **Branding** | Logo image and link, three custom buttons with colours and new-tab toggle |
| **Hotspots** | Background and icon colour per hotspot type, with live preview |
| **Presets** | Save and load named style presets (covers all Settings values) |

### Scene properties (right panel)

Select a scene in the left sidebar to edit:

- **Scene name**
- **Initial view** — set the camera angle that loads when entering this scene
- **Starting scene** — mark this scene as the first to load
- **Compass** — enable/disable per scene, adjust north offset
- **Floor Plan Dot** — place or remove this scene's dot on the floor plan
- **Hotspots** — add and manage info and link hotspots
- **Projection** — switch between Flat, Panorama, and Fisheye (requires source image to be present)

## Deploying the exported tour

The exported ZIP is fully self-contained — no internet connection required. Extract and open `index.html` on any static web server:

```bash
unzip my-tour.zip -d my-tour
cd my-tour
# Python quick server:
python3 -m http.server 8080
# Or upload to Netlify, GitHub Pages, nginx, Apache, etc.
```

The ZIP includes `project.json` which can be re-imported into PanoPath for further editing.

## Supported image formats

| Format | Notes |
|--------|-------|
| JPEG / JPG | Recommended |
| PNG | Supported, transparency flattened to white |
| HEIC / HEIF | Phone photos — converted to JPEG automatically |
| TIFF | Supported |
| WebP | Supported |

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

The image is automatically rebuilt and pushed to Docker Hub whenever the GitHub repo is updated. To pull the latest image:

```bash
docker pull illerin/panopath:latest
docker-compose up -d
```

If you need to patch a specific file without pulling a new image, copy it directly into the running container. If you don't have a local clone, download the file from GitHub first:

```bash
curl -o tool.js https://raw.githubusercontent.com/illerin/PanoPath/main/public/js/tool.js
docker cp tool.js panopath:/app/public/js/tool.js
```

Or if you do have a local clone:

```bash
docker cp public/index.html panopath:/app/public/index.html
docker cp public/js/tool.js panopath:/app/public/js/tool.js
docker cp public/css/tool.css panopath:/app/public/css/tool.css
```

For server changes (`server/index.js`), restart after copying:

```bash
docker cp server/index.js panopath:/app/server/index.js
docker restart panopath
```

## Data persistence

All persistent data (tiles, source images, saved projects, and style presets) is stored under `/app/tmp` in the `panopath_data` Docker volume. This persists across container restarts and image updates.

To back up:

```bash
docker run --rm -v panopath_data:/data -v $(pwd):/backup alpine \
  tar czf /backup/panopath-backup.tar.gz /data
```

To restore:

```bash
docker run --rm -v panopath_data:/data -v $(pwd):/backup alpine \
  tar xzf /backup/panopath-backup.tar.gz -C /
```

## License

MIT. Built on [Marzipano](https://github.com/google/marzipano) (Apache 2.0) by Google.
