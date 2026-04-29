# PanoPath

[![Docker Hub](https://img.shields.io/docker/pulls/illerin/panopath?logo=docker&logoColor=white)](https://hub.docker.com/r/illerin/panopath)
[![GitHub](https://img.shields.io/badge/source-GitHub-181717?logo=github)](https://github.com/illerin/PanoPath)

A self-hosted Docker tool for building interactive 360° panorama tours. Upload panorama images, add hotspots, configure branding, place floor plan dots, then export a self-contained ZIP you can host anywhere.

## Features

- Upload equirectangular panoramas (JPG, PNG, HEIC/HEIF, TIFF, WebP)
- Non-panorama images are supported
- Multi-resolution cube face tiling (server-side, no GPU required)
- Info hotspots (click to expand text) and link hotspots (navigate between scenes)
- 7 link hotspot icon styles (camera, arrow, door, star, eye, location) with fully customisable colours
- Floor plan overlay with per-scene dot placement, circle or direction arrow style
- Branding: logo, 3 buttons with custom text/background colours and new-tab toggle
- Settings: autorotate, fullscreen button, zoom buttons, compass, mouse mode
- Set starting view per scene and set which scene loads first
- Live preview of branding and hotspot colours in the editor
- Style presets — save and reload all appearance settings by name
- Export as self-contained ZIP (HTML + tiles + project.json)
- Save and load projects from the server, or import via ZIP
- Fully local — no cloud uploads, no accounts

<img width="2560" height="1274" alt="PanoPath Landing page" src="https://github.com/user-attachments/assets/198e0c75-273b-4882-a283-037c9d6010a6" />

## Quick Start

No clone or build needed — pull the image directly from Docker Hub:

```bash
docker run -d \
  --name panopath \
  -p 3098:3098 \
  -v panopath_tiles:/app/tmp/tiles \
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
      - panopath_tiles:/app/tmp/tiles
    environment:
      - PORT=3098
      - NODE_ENV=production
    restart: unless-stopped

volumes:
  panopath_tiles:
    driver: local
```

### Building from source

If you want to modify the server code and rebuild the image yourself:

```bash
git clone https://github.com/illerin/PanoPath
cd PanoPath
docker-compose up -d
```

## Usage

### Building a tour

1. **Add panoramas** — drag and drop images onto the tool, or click **+ Add**
2. **Set initial view** — pan to your preferred angle in the viewer, then click **Set Initial View** in the toolbar
3. **Set first scene** — in the right props panel, click **Set as First** on the scene that should load first
4. **Add hotspots** — click **Info Hotspot** or **Link Hotspot** in the toolbar, then click in the panorama to place
5. **Appearance** — click **Settings** to configure branding, hotspot colours, viewer controls, and save style presets
6. **Floor plan** — click **Floor Plan** to upload a floor plan image, then use the **Floor Plan Dot** section in the right panel to place a dot for each scene
7. **Export** — click **Export** to download a ZIP

### Saving and loading projects

Projects are saved to the server and persist across sessions:

1. Click **Project → Save project** and enter a name
2. Click **Project → Open saved project…** to resume

To import a previously exported ZIP, click **Project → Import ZIP…** and select the file. Tiles are extracted automatically.

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
- **Compass** — enable/disable per scene, adjust north offset
- **Hotspots** — add and manage info and link hotspots
- **Floor Plan Dot** — place or remove this scene's dot on the floor plan

## Deploying the exported tour

The exported ZIP is fully self-contained — no internet connection required. Extract and open `index.html` on any static web server:

```bash
unzip my-tour.zip -d my-tour
cd my-tour
# Python quick server:
python3 -m http.server 8080
# Or upload to Netlify, GitHub Pages, nginx, Apache, etc.
```

## Supported image formats

| Format | Notes |
|--------|-------|
| JPEG / JPG | Recommended for panoramas |
| PNG | Supported including transparency (alpha flattened to white) |
| HEIC / HEIF | Phone photos — converted automatically |
| TIFF | Supported |
| WebP | Supported |

**Panorama detection**: images with a 1.7:1 to 2.4:1 aspect ratio are treated as equirectangular panoramas. Other images are centred on a white 2048×1024 canvas.

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

Tile images are stored in the `panopath_tiles` Docker volume. This persists across container restarts and is required for **Open saved project** to work.

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
