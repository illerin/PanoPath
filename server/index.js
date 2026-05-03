const express    = require('express');
const multer     = require('multer');
const archiver   = require('archiver');
const sharp      = require('sharp');
const heicConvert = require('heic-convert');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const previewSessions = new Map();

const UPLOAD_DIR     = path.join(__dirname, '../tmp/uploads');
const TILES_DIR      = path.join(__dirname, '../tmp/tiles');
const PROJECTS_DIR   = path.join(__dirname, '../tmp/projects');
const MARZIPANO_PATH = path.join(__dirname, '../public/js/marzipano.js');
const MARZIPANO_CDN  = 'https://cdn.jsdelivr.net/npm/marzipano@0.10.2/dist/marzipano.js';

fs.mkdirSync(UPLOAD_DIR,   { recursive: true });
fs.mkdirSync(TILES_DIR,    { recursive: true });
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(MARZIPANO_PATH), { recursive: true });

// ── Download Marzipano locally on first run ───────────────────────────────────
function ensureMarzipano() {
  return new Promise((resolve) => {
    if (fs.existsSync(MARZIPANO_PATH)) {
      console.log('Marzipano already cached at', MARZIPANO_PATH);
      return resolve(true);
    }
    console.log('Downloading Marzipano from CDN…');
    const file = fs.createWriteStream(MARZIPANO_PATH);
    https.get(MARZIPANO_CDN, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(MARZIPANO_PATH); } catch(e) {}
        console.warn(`Marzipano download failed (HTTP ${res.statusCode}) — will use CDN fallback`);
        return resolve(false);
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('Marzipano cached locally at', MARZIPANO_PATH);
        resolve(true);
      });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(MARZIPANO_PATH); } catch(e) {}
      console.warn('Marzipano download error:', err.message, '— will use CDN fallback');
      resolve(false);
    });
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json({ limit: '50mb' }));

setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of previewSessions.entries()) {
    if (!sess || now - sess.createdAt > PREVIEW_TTL_MS) previewSessions.delete(id);
  }
}, 5 * 60 * 1000);

// ── Upload & process ──────────────────────────────────────────────────────────
app.post('/api/process', upload.single('panorama'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const sceneId = uuidv4();
  const outDir  = path.join(TILES_DIR, sceneId);
  fs.mkdirSync(outDir, { recursive: true });
  const imgPath = req.file.path;

  // Wrap entire processing in a 90-second timeout so hangs fail cleanly
  const processTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Processing timed out after 90 seconds')), 90000)
  );

  try {
    const result = await Promise.race([processImage(req, res, sceneId, outDir, imgPath), processTimeout]);
    return; // processImage sends the response
  } catch(err) {
    console.error('Processing error:', err);
    try { fs.unlinkSync(imgPath); } catch(e) {}
    return res.status(500).json({ error: 'Failed to process: ' + err.message });
  }
});

async function processImage(req, res, sceneId, outDir, imgPath) {
  try {
    let fileBuffer = fs.readFileSync(imgPath);

    // ── HEIC/HEIF conversion ────────────────────────────────────────────────
    const origName = (req.file.originalname || '').toLowerCase();
    const isHeic   = /\.(heic|heif)$/i.test(origName) ||
                     (req.file.mimetype && req.file.mimetype.includes('heic'));
    if (isHeic) {
      console.log('Converting HEIC to JPEG...');
      const jpegBuffer = await heicConvert({
        buffer: fileBuffer,
        format: 'JPEG',
        quality: 0.92
      });
      fileBuffer = Buffer.from(jpegBuffer);
    }

    // ── Save original as source.jpg for future re-processing ───────────────
    const sourcePath = path.join(outDir, 'source.jpg');
    if (!fs.existsSync(sourcePath)) {
      // Convert to JPEG if needed (PNG, TIFF, etc.) and save at full quality
      await sharp(fileBuffer).jpeg({ quality: 95 }).toFile(sourcePath);
      console.log(`Source saved: ${sourcePath}`);
    }

    const meta = await sharp(fileBuffer).metadata();
    const { width, height } = meta;
    if (!width || !height) throw new Error('Could not read image dimensions');
    console.log(`Processing: ${req.file.originalname} (${width}x${height}, ${meta.format})`);

    // ── Projection mode detection ──────────────────────────────────────────
    const ratio = width / height;
    const forcedFlat    = !!(req.body && (req.body.asFlat    === '1' || req.body.asFlat    === 1 || req.body.asFlat    === true));
    const forcedPano    = !!(req.body && (req.body.asPano    === '1' || req.body.asPano    === 1 || req.body.asPano    === true));
    const forcedFisheye = !!(req.body && (req.body.asFisheye === '1' || req.body.asFisheye === 1 || req.body.asFisheye === true));
    const fisheyeFov    = forcedFisheye ? (parseFloat(req.body.fisheyeFov) || 180) : 180;
    if (forcedPano)    console.log('asPano flag set — forcing panorama projection');
    if (forcedFisheye) console.log(`asFisheye flag set — FOV=${fisheyeFov}°`);
    const isPano    = forcedPano    || (!forcedFlat && !forcedFisheye && ratio >= 1.9 && ratio <= 2.15);
    const isFisheye = forcedFisheye || false;

    if (isPano || isFisheye) {
      let processBuffer;
      const maxW = 8192;
      if (width > maxW) {
        processBuffer = await sharp(fileBuffer)
          .resize(maxW, Math.round(maxW / 2))
          .jpeg({ quality: 92 })
          .toBuffer();
        console.log(`Downsampled to ${maxW}x${Math.round(maxW/2)}`);
      } else {
        processBuffer = fileBuffer;
      }

      // ── Pad to correct aspect ratio ──────────────────────────────────────
      // Panorama needs 2:1 (equirectangular), fisheye needs 1:1 (square circle).
      // If the image isn't already the right ratio, pad with black so the
      // projection math works correctly and the image sits centered.
      {
        const pm0 = await sharp(processBuffer).metadata();
        const pw0 = pm0.width, ph0 = pm0.height;
        const currentRatio = pw0 / ph0;
        const targetRatio  = isFisheye ? 1.0 : 2.0;
        const tolerance    = 0.05;

        if (Math.abs(currentRatio - targetRatio) > tolerance) {
          let padW, padH;
          if (currentRatio < targetRatio) {
            // Too tall — add black left/right
            padH = ph0;
            padW = Math.round(ph0 * targetRatio);
          } else {
            // Too wide — add black top/bottom
            padW = pw0;
            padH = Math.round(pw0 / targetRatio);
          }
          const left = Math.round((padW - pw0) / 2);
          const top  = Math.round((padH - ph0) / 2);
          console.log(`Padding ${pw0}x${ph0} → ${padW}x${padH} (${isFisheye?'1:1':'2:1'} for ${isFisheye?'fisheye':'panorama'})`);
          processBuffer = await sharp(processBuffer)
            .extend({ top, bottom: padH - ph0 - top, left, right: padW - pw0 - left,
                      background: { r:0, g:0, b:0, alpha:1 } })
            .jpeg({ quality: 92 })
            .toBuffer();
        }
      }

      const pm  = await sharp(processBuffer).metadata();
      const pw  = pm.width, ph = pm.height;
      const faceSize = Math.max(64, Math.min(Math.floor(ph / 2), 2048));
      const levels   = generateLevels(faceSize);
      const finalSize = levels[levels.length - 1].size;
      console.log(`faceSize=${faceSize}, finalSize=${finalSize}, levels=${levels.length}`);

      // Load raw RGBA pixels — downsample to 4096 wide max for memory safety
      const rawMaxW = Math.min(pw, 4096);
      const rawMaxH = Math.round(rawMaxW * ph / pw);  // preserve actual aspect ratio
      const rawBuf  = (rawMaxW < pw)
        ? await sharp(processBuffer).resize(rawMaxW, rawMaxH).raw().ensureAlpha(0).toBuffer({ resolveWithObject: true })
        : await sharp(processBuffer).raw().ensureAlpha(0).toBuffer({ resolveWithObject: true });
      const { data: srcData, info } = rawBuf;
      const sw = info.width, sh = info.height;
      console.log(`Raw pixels: ${sw}x${sh}`);

      const faceNames = ['f', 'b', 'l', 'r', 'u', 'd'];

      for (const level of levels) {
        const { tileSize, size } = level;
        const numTiles = Math.ceil(size / tileSize);

        for (const face of faceNames) {
          const faceDir = path.join(outDir, String(level.z), face);
          fs.mkdirSync(faceDir, { recursive: true });
          const facePixels = isFisheye
            ? projectFisheyeFace(srcData, sw, sh, face, size, fisheyeFov)
            : projectCubeFace(srcData, sw, sh, face, size);

          for (let row = 0; row < numTiles; row++) {
            const rowDir = path.join(faceDir, String(row));
            fs.mkdirSync(rowDir, { recursive: true });
            for (let col = 0; col < numTiles; col++) {
              const x = col * tileSize, y = row * tileSize;
              const tileW = Math.min(tileSize, size - x);
              const tileH = Math.min(tileSize, size - y);
              await sharp(facePixels, { raw: { width: size, height: size, channels: 3 } })
                .extract({ left: x, top: y, width: tileW, height: tileH })
                .jpeg({ quality: 85 })
                .toFile(path.join(rowDir, `${col}.jpg`));
            }
          }
        }
      }

      await sharp(processBuffer).resize(512, 256).jpeg({ quality: 75 })
        .toFile(path.join(outDir, 'preview.jpg'));

      try { fs.unlinkSync(imgPath); } catch(e) {}
      const projLabel = isFisheye ? 'fisheye' : 'pano';
      console.log(`Done: ${sceneId} (${projLabel})`);

      res.json({
        sceneId,
        isPano: true,
        projection: 'cube',
        levels: levels.map(l => ({ tileSize: l.tileSize, size: l.size })),
        faceSize: finalSize,
        previewUrl: `/tiles/${sceneId}/preview.jpg`,
        sourceUrl:  `/tiles/${sceneId}/source.jpg`,
        suggestedInitialView: { yaw: 0, pitch: 0, fov: 1.5707963 }
      });
      return;
    }

    // ── Flat scene path ────────────────────────────────────────────────────
    const MAX_FLAT = 4096;
    const flatScale  = Math.min(1, MAX_FLAT / Math.max(width, height));
    const flatWidth  = Math.max(1, Math.round(width  * flatScale));
    const flatHeight = Math.max(1, Math.round(height * flatScale));
    console.log(`Flat scene: ${flatWidth}x${flatHeight}`);

    const flatBuffer = await sharp(fileBuffer)
      .rotate()           // auto-apply and strip EXIF orientation (fixes phone photos)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(flatWidth, flatHeight, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    await sharp(flatBuffer).toFile(path.join(outDir, 'flat.jpg'));
    await sharp(flatBuffer).resize(512, 256, { fit: 'inside', background: '#fff' }).jpeg({ quality: 75 })
      .toFile(path.join(outDir, 'preview.jpg'));

    try { fs.unlinkSync(imgPath); } catch(e) {}
    console.log(`Done: ${sceneId} (flat)`);

    res.json({
      sceneId,
      isPano: false,
      projection: 'flat',
      previewUrl: `/tiles/${sceneId}/preview.jpg`,
      sourceUrl:  `/tiles/${sceneId}/source.jpg`,
      flat: {
        width:  flatWidth,
        height: flatHeight,
        url:    `/tiles/${sceneId}/flat.jpg`
      },
      suggestedInitialView: { x: 0.5, y: 0.5, zoom: 1 }
    });
  } catch (err) {
    console.error('processImage error:', err);
    try { fs.unlinkSync(imgPath); } catch(e) {}
    res.status(500).json({ error: 'Failed to process: ' + err.message });
  }
}

// ── Serve tiles ───────────────────────────────────────────────────────────────
const unzipper = require('unzipper');

app.use('/tiles', express.static(TILES_DIR));

// ── Import project from ZIP (for cross-machine editing) ───────────────────────
const uploadZip = multer({ dest: UPLOAD_DIR, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
app.post('/api/import-project', uploadZip.single('projectZip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const zipPath = req.file.path;
  try {
    let projectJson = null;
    const tileEntries = [];

    // First pass: read project.json and collect tile entry paths
    const zip1 = fs.createReadStream(zipPath).pipe(unzipper.Parse({ forceStream: true }));
    for await (const entry of zip1) {
      const name = entry.path;
      if (name === 'project.json') {
        const buf = await entry.buffer();
        projectJson = JSON.parse(buf.toString());
      } else if (name.startsWith('tiles/')) {
        // Skip directory entries (they end with /)
        if (name.endsWith('/')) {
          entry.autodrain();
        } else {
          const buf = await entry.buffer();
          tileEntries.push({ path: name, buf });
        }
      } else {
        entry.autodrain();
      }
    }

    if (!projectJson) {
      try { fs.unlinkSync(zipPath); } catch(e) {}
      return res.status(400).json({ error: 'No project.json found in ZIP. Make sure you upload an exported PanoPath ZIP.' });
    }

    // Write tiles to TILES_DIR
    for (const { path: entryPath, buf } of tileEntries) {
      const dest = path.join(TILES_DIR, entryPath.replace(/^tiles\//, ''));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }

    try { fs.unlinkSync(zipPath); } catch(e) {}
    console.log(`Imported project: ${projectJson.scenes?.length || 0} scenes, ${tileEntries.length} tile files`);
    res.json({ ok: true, project: projectJson });
  } catch (err) {
    try { fs.unlinkSync(zipPath); } catch(e) {}
    console.error('Import error:', err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ── Saved projects (persistent, server-side) ─────────────────────────────────
app.get('/api/projects', (req, res) => {
  try {
    const files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'));
    const projects = files.map(f => {
      const raw = fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8');
      const data = JSON.parse(raw);
      return {
        filename: f,
        name: data.settings?.title || f.replace('.json',''),
        savedAt: data.savedAt || null,
        sceneCount: data.scenes?.length || 0
      };
    }).sort((a, b) => (b.savedAt||'').localeCompare(a.savedAt||''));
    res.json({ projects });
  } catch(e) { res.json({ projects: [] }); }
});

app.post('/api/projects/save', express.json({ limit: '50mb' }), (req, res) => {
  const { name, project } = req.body;
  if (!name || !project) return res.status(400).json({ error: 'name and project required' });
  const safe = name.replace(/[^a-z0-9_\-\s]/gi, '_').trim().replace(/\s+/g,'_');
  const filename = safe + '.json';
  project.savedAt = new Date().toISOString();
  fs.writeFileSync(path.join(PROJECTS_DIR, filename), JSON.stringify(project, null, 2));
  res.json({ ok: true, filename });
});

app.get('/api/projects/:filename', (req, res) => {
  const p = path.join(PROJECTS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
});

app.delete('/api/projects/:filename', (req, res) => {
  const p = path.join(PROJECTS_DIR, path.basename(req.params.filename));
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

// ── Style presets (server-side, single JSON file) ─────────────────────────────
const PRESETS_FILE = path.join(PROJECTS_DIR, '_presets.json');

app.get('/api/presets', (req, res) => {
  try {
    if (!fs.existsSync(PRESETS_FILE)) return res.json({ presets: [] });
    res.json({ presets: JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) });
  } catch(e) { res.json({ presets: [] }); }
});

app.post('/api/presets', express.json({ limit: '10mb' }), (req, res) => {
  const { presets } = req.body;
  if (!Array.isArray(presets)) return res.status(400).json({ error: 'presets must be an array' });
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2));
  res.json({ ok: true });
});

// ── Import check (tiles already on server) ────────────────────────────────────
app.post('/api/import-check', (req, res) => {
  const { scenes } = req.body;
  if (!scenes) return res.status(400).json({ error: 'No scenes' });
  res.json({ results: scenes.map(s => ({ id: s.id, exists: fs.existsSync(path.join(TILES_DIR, s.id)) })) });
});

// ── Export ZIP ────────────────────────────────────────────────────────────────
app.post('/api/export', async (req, res) => {
  const { scenes, settings } = req.body;
  if (!scenes || !scenes.length) return res.status(400).json({ error: 'No scenes' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="panorama-tour.zip"');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  archive.append(generateViewerHTML(scenes, settings), { name: 'index.html' });
  archive.append(generateAppJS(scenes, settings),      { name: 'app.js' });
  archive.append(generateAppCSS(),                     { name: 'style.css' });
  archive.append(generateReadme(settings, scenes, 'full'), { name: 'README.txt' });
  archive.append(JSON.stringify({
    version: 1,
    exportedWith: 'PanoPath by illerin v0.5.11',
    exportedAt: new Date().toISOString(),
    settings,
    scenes
  }, null, 2), { name: 'project.json' });

  // Bundle Marzipano locally so the export works fully offline
  if (fs.existsSync(MARZIPANO_PATH)) {
    archive.file(MARZIPANO_PATH, { name: 'marzipano.js' });
  } else {
    // Fallback: rewrite the script tag to CDN so the export still works
    console.warn('marzipano.js not cached — export will reference CDN');
  }

  if (settings.logoData) {
    const m = settings.logoData.match(/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,(.+)$/);
    if (m) archive.append(Buffer.from(m[2], 'base64'), { name: `logo.${m[1].replace('svg+xml','svg')}` });
  }
  if (settings.planData) {
    const m = settings.planData.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
    if (m) archive.append(Buffer.from(m[2], 'base64'), { name: `plan.${m[1]}` });
  }

  for (const scene of scenes) {
    const sceneDir = path.join(TILES_DIR, scene.id);
    if (fs.existsSync(sceneDir)) archive.directory(sceneDir, `tiles/${scene.id}`);
  }
  await archive.finalize();
});

// ── Slim export (hosting only — no source.jpg, no project.json, no README) ──
app.post('/api/export-slim', async (req, res) => {
  const { scenes, settings } = req.body;
  if (!scenes || !scenes.length) return res.status(400).json({ error: 'No scenes' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="tour-hosting.zip"');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  archive.append(generateViewerHTML(scenes, settings), { name: 'index.html' });
  archive.append(generateAppJS(scenes, settings),      { name: 'app.js' });
  archive.append(generateAppCSS(),                     { name: 'style.css' });
  archive.append(generateReadme(settings, scenes, 'slim'), { name: 'README.txt' });

  // Bundle Marzipano locally
  if (fs.existsSync(MARZIPANO_PATH)) {
    archive.file(MARZIPANO_PATH, { name: 'marzipano.js' });
  }

  if (settings.logoData) {
    const m = settings.logoData.match(/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,(.+)$/);
    if (m) archive.append(Buffer.from(m[2], 'base64'), { name: `logo.${m[1].replace('svg+xml','svg')}` });
  }
  if (settings.planData) {
    const m = settings.planData.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
    if (m) archive.append(Buffer.from(m[2], 'base64'), { name: `plan.${m[1]}` });
  }

  // Add tiles but skip source.jpg in each scene folder
  for (const scene of scenes) {
    const sceneDir = path.join(TILES_DIR, scene.id);
    if (!fs.existsSync(sceneDir)) continue;
    const entries = fs.readdirSync(sceneDir);
    for (const entry of entries) {
      if (entry === 'source.jpg') continue; // skip — not needed for hosting
      const entryPath = path.join(sceneDir, entry);
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory()) {
        archive.directory(entryPath, `tiles/${scene.id}/${entry}`);
      } else {
        archive.file(entryPath, { name: `tiles/${scene.id}/${entry}` });
      }
    }
  }

  await archive.finalize();
});

// ── Backup export ────────────────────────────────────────────────────────────
app.post('/api/backup/export', express.json({ limit: '10mb' }), async (req, res) => {
  const { includeProjects, includePresets } = req.body || {};
  const now = new Date();
  const dateStr = now.toISOString().slice(0,10);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="panopath-backup-${dateStr}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  const manifest = {
    createdAt: now.toISOString(),
    exportedWith: 'PanoPath by illerin v0.5.11',
    includesProjects: !!includeProjects,
    includesPresets: !!includePresets,
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: 'backup-manifest.json' });

  if (includePresets && fs.existsSync(PRESETS_FILE)) {
    archive.file(PRESETS_FILE, { name: 'data/presets.json' });
  }

  if (includeProjects) {
    const projectFiles = fs.existsSync(PROJECTS_DIR)
      ? fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json') && f !== '_presets.json')
      : [];

    for (const f of projectFiles) {
      const projectPath = path.join(PROJECTS_DIR, f);
      archive.file(projectPath, { name: `data/projects/${f}` });

      // Bundle the tile folders for every scene in this project
      try {
        const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
        const scenes = project.scenes || [];
        for (const scene of scenes) {
          if (!scene.id) continue;
          const sceneDir = path.join(TILES_DIR, scene.id);
          if (fs.existsSync(sceneDir)) {
            archive.directory(sceneDir, `data/tiles/${scene.id}`);
          }
        }
      } catch(e) {
        console.warn(`Could not read project ${f} for tile bundling:`, e.message);
      }
    }
  }

  await archive.finalize();
});

// ── Backup import ─────────────────────────────────────────────────────────────
const uploadBackup = multer({ dest: UPLOAD_DIR, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
app.post('/api/backup/import', uploadBackup.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const results = { projects: 0, presets: false, tiles: 0 };
  try {
    const dir = await unzipper.Open.file(req.file.path);

    // Validate it's a PanoPath backup
    const manifestEntry = dir.files.find(f => f.path === 'backup-manifest.json');
    if (!manifestEntry) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Not a valid PanoPath backup ZIP.' });
    }

    for (const file of dir.files) {
      if (file.type === 'Directory') continue;
      const p = file.path;
      if (p === 'backup-manifest.json') continue;

      if (p === 'data/presets.json') {
        const buf = await file.buffer();
        fs.mkdirSync(PROJECTS_DIR, { recursive: true });
        fs.writeFileSync(PRESETS_FILE, buf);
        results.presets = true;

      } else if (p.startsWith('data/projects/') && p.endsWith('.json')) {
        const filename = path.basename(p);
        const buf = await file.buffer();
        fs.mkdirSync(PROJECTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(PROJECTS_DIR, filename), buf);
        results.projects++;

      } else if (p.startsWith('data/tiles/')) {
        const rel = p.replace('data/tiles/', '');
        const dest = path.join(TILES_DIR, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const buf = await file.buffer();
        fs.writeFileSync(dest, buf);
        results.tiles++;
      }
    }
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, results });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
    res.status(500).json({ error: e.message });
  }
});

// ── Live preview session ──────────────────────────────────────────────────────
app.post('/api/preview-session', (req, res) => {
  const { scenes, settings } = req.body || {};
  if (!Array.isArray(scenes) || !scenes.length) return res.status(400).json({ error: 'No scenes' });
  const previewId = uuidv4();
  previewSessions.set(previewId, {
    createdAt: Date.now(),
    scenes,
    settings: settings || {}
  });
  res.json({ previewId, url: `/preview/${previewId}` });
});

app.get('/preview/:id', (req, res) => {
  const sess = previewSessions.get(req.params.id);
  if (!sess) return res.status(404).send('Preview expired or not found');
  const previewUrl = `/preview/${req.params.id}/view`;
  res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PanoPath Preview</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #e5e7eb; }
    .bar { display: flex; gap: 8px; align-items: center; padding: 10px 12px; background: #1f2937; border-bottom: 1px solid #374151; }
    .btn { border: 1px solid #4b5563; background: #111827; color: #e5e7eb; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .btn.active { background: #e94560; border-color: #e94560; color: #fff; }
    .label { font-size: 12px; opacity: 0.8; margin-left: auto; }
    .stage { height: calc(100vh - 52px); display: grid; place-items: center; padding: 14px; }
    .viewport { width: min(1200px, 96vw); height: min(760px, 88vh); border: 1px solid #374151; border-radius: 10px; overflow: hidden; background: #000; box-shadow: 0 10px 30px rgba(0,0,0,0.45); transition: all .2s ease; }
    .viewport.phone { width: 390px; height: 844px; border-radius: 26px; }
    iframe { width: 100%; height: 100%; border: 0; background: #000; }
  </style>
</head>
<body>
  <div class="bar">
    <button id="btn-desktop" class="btn active">Desktop</button>
    <button id="btn-phone" class="btn">Phone</button>
    <span class="label">Live preview from current editor state</span>
  </div>
  <div class="stage">
    <div id="viewport" class="viewport">
      <iframe src="${previewUrl}" allowfullscreen></iframe>
    </div>
  </div>
  <script>
    (function(){
      var vp = document.getElementById('viewport');
      var desktopBtn = document.getElementById('btn-desktop');
      var phoneBtn = document.getElementById('btn-phone');
      function setMode(mode){
        var isPhone = mode === 'phone';
        vp.classList.toggle('phone', isPhone);
        desktopBtn.classList.toggle('active', !isPhone);
        phoneBtn.classList.toggle('active', isPhone);
      }
      desktopBtn.addEventListener('click', function(){ setMode('desktop'); });
      phoneBtn.addEventListener('click', function(){ setMode('phone'); });
    })();
  </script>
</body>
</html>`);
});

app.get('/preview/:id/view', (req, res) => {
  const sess = previewSessions.get(req.params.id);
  if (!sess) return res.status(404).send('Preview expired or not found');

  const scenes = sess.scenes || [];
  const settings = sess.settings || {};

  let html = generateViewerHTML(scenes, settings);
  const css = generateAppCSS();
  let appJs = generateAppJS(scenes, settings);

  html = html.replace('<link rel="stylesheet" href="style.css">', `<style>${css}</style>`);
  // Inline Marzipano so the preview works without a relative file path
  if (fs.existsSync(MARZIPANO_PATH)) {
    const marzipanoJs = fs.readFileSync(MARZIPANO_PATH, 'utf8');
    html = html.replace('<script src="marzipano.js"></script>', `<script>${marzipanoJs}</script>`);
  } else {
    // Fall back to CDN if local copy isn't available yet
    html = html.replace('<script src="marzipano.js"></script>', `<script src="https://cdn.jsdelivr.net/npm/marzipano@0.10.2/dist/marzipano.js"></script>`);
  }
  // In preview mode, viewer runs under /preview/:id/view, so tile paths must be absolute.
  appJs = appJs.replace(/'tiles\//g, "'/tiles/");
  appJs = appJs.replace(/"tiles\//g, '"/tiles/');
  appJs = appJs.replace(/<\/script/gi, '<\\/script');
  html = html.replace('<script src="app.js"></script>', `<script>${appJs}</script>`);

  if (settings.logoData) html = html.replace(/src="logo\.[^"]+"/g, `src="${settings.logoData}"`);
  if (settings.planData) html = html.replace(/src="plan\.[^"]+"/g, `src="${settings.planData}"`);

  res.type('html').send(html);
});

// ── Delete scene ──────────────────────────────────────────────────────────────
app.delete('/api/scene/:id', (req, res) => {
  const d = path.join(TILES_DIR, req.params.id);
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
  res.json({ ok: true });
});

// ── Rotate flat scene image ───────────────────────────────────────────────────
app.post('/api/rotate-flat/:id', async (req, res) => {
  const sceneId    = req.params.id;
  const outDir     = path.join(TILES_DIR, sceneId);
  const sourcePath = path.join(outDir, 'source.jpg');
  const flatPath   = path.join(outDir, 'flat.jpg');
  const degrees    = parseInt(req.body && req.body.degrees, 10);

  if (![90, 180, 270, 0].includes(degrees)) {
    return res.status(400).json({ error: 'degrees must be 0, 90, 180, or 270' });
  }

  // Prefer source.jpg (original quality); fall back to flat.jpg for older scenes
  const srcPath = fs.existsSync(sourcePath) ? sourcePath : flatPath;
  if (!fs.existsSync(srcPath)) {
    return res.status(404).json({ error: 'No image found for this scene' });
  }

  try {
    const currentRotation = parseInt(req.body && req.body.currentRotation, 10) || 0;
    const totalRotation   = (currentRotation + degrees) % 360;
    console.log(`rotate-flat: scene=${sceneId} src=${srcPath} degrees=${degrees} total=${totalRotation}`);

    const MAX_FLAT = 4096;

    // Pass 1: normalise EXIF orientation into actual pixels, strip the tag
    const normalised = await sharp(srcPath)
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    // Pass 2: apply the explicit rotation on the now-clean buffer
    const rotated = totalRotation !== 0
      ? await sharp(normalised).rotate(totalRotation).jpeg({ quality: 92 }).toBuffer()
      : normalised;

    const newMeta = await sharp(rotated).metadata();
    console.log(`rotate-flat: result ${newMeta.width}x${newMeta.height}`);

    // Scale down if needed
    const scale = Math.min(1, MAX_FLAT / Math.max(newMeta.width, newMeta.height));
    const flatWidth  = Math.max(1, Math.round(newMeta.width  * scale));
    const flatHeight = Math.max(1, Math.round(newMeta.height * scale));

    const finalBuf = scale < 1
      ? await sharp(rotated).resize(flatWidth, flatHeight).jpeg({ quality: 92 }).toBuffer()
      : rotated;

    fs.writeFileSync(flatPath, finalBuf);

    // Regenerate preview
    await sharp(finalBuf)
      .resize(512, 256, { fit: 'inside', background: '#fff' })
      .jpeg({ quality: 75 })
      .toFile(path.join(outDir, 'preview.jpg'));

    res.json({
      ok: true,
      totalRotation,
      flat: { width: flatWidth, height: flatHeight, url: `/tiles/${sceneId}/flat.jpg` },
      previewUrl: `/tiles/${sceneId}/preview.jpg`
    });
  } catch(err) {
    console.error('rotate-flat error:', err);
    res.status(500).json({ error: 'Rotation failed: ' + err.message });
  }
});

// ── Reprocess existing scene with a different projection ─────────────────────
app.post('/api/reprocess/:id', async (req, res) => {
  const sceneId = req.params.id;
  const outDir  = path.join(TILES_DIR, sceneId);
  const sourcePath = path.join(outDir, 'source.jpg');

  if (!fs.existsSync(sourcePath)) {
    return res.status(404).json({ error: 'No source image found for this scene. Re-import the original file to enable projection switching.' });
  }

  const { projection, fisheyeFov } = req.body || {};
  if (!['flat', 'cube', 'fisheye'].includes(projection)) {
    return res.status(400).json({ error: 'projection must be flat, cube, or fisheye' });
  }

  // Clean out old tiles/flat but keep source.jpg
  try {
    const entries = fs.readdirSync(outDir);
    for (const entry of entries) {
      if (entry === 'source.jpg') continue;
      const p = path.join(outDir, entry);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) fs.rmSync(p, { recursive: true });
      else fs.unlinkSync(p);
    }
  } catch(e) {
    console.error('Reprocess cleanup error:', e);
  }

  // Build a fake req/res-compatible call by re-using processImage with a synthetic req
  const fakeReq = {
    file: { path: sourcePath, originalname: 'source.jpg', mimetype: 'image/jpeg' },
    body: {
      asPano:    projection === 'cube'    ? '1' : '0',
      asFisheye: projection === 'fisheye' ? '1' : '0',
      asFlat:    projection === 'flat'    ? '1' : '0',
      fisheyeFov: fisheyeFov || '180'
    }
  };

  // processImage deletes imgPath — we must NOT delete source.jpg, so give it a temp copy
  const tmpCopy = path.join(outDir, '_reprocess_tmp.jpg');
  fs.copyFileSync(sourcePath, tmpCopy);
  fakeReq.file.path = tmpCopy;

  // Use a custom sceneId so processImage writes into the existing outDir
  // We intercept res.json to capture the result
  let responded = false;
  const fakeRes = {
    json(data) {
      responded = true;
      if (data && data.sceneId) data.sceneId = sceneId;
      res.json(data);
    },
    status(code) { return { json(data){ responded=true; res.status(code).json(data); } }; }
  };

  try {
    await processImage(fakeReq, fakeRes, sceneId, outDir, tmpCopy);
  } catch(err) {
    if (!responded) res.status(500).json({ error: 'Reprocess failed: ' + err.message });
  }
});

// ── Cube face projection ──────────────────────────────────────────────────────
function projectCubeFace(srcData, sw, sh, face, outSize) {
  const pixels = Buffer.alloc(outSize * outSize * 3);
  for (let j = 0; j < outSize; j++) {
    for (let i = 0; i < outSize; i++) {
      const u = (2 * (i + 0.5) / outSize) - 1;
      const v = (2 * (j + 0.5) / outSize) - 1;
      let dx, dy, dz;
      switch (face) {
        case 'f': dx= u; dy=-v; dz= 1; break;
        case 'b': dx=-u; dy=-v; dz=-1; break;
        case 'r': dx= 1; dy=-v; dz=-u; break;
        case 'l': dx=-1; dy=-v; dz= u; break;
        case 'u': dx= u; dy= 1; dz= v; break;
        case 'd': dx= u; dy=-1; dz=-v; break;
      }
      const len = Math.sqrt(dx*dx+dy*dy+dz*dz);
      const nx=dx/len, ny=dy/len, nz=dz/len;
      const lon = Math.atan2(-nx, -nz);
      const lat = Math.asin(Math.max(-1, Math.min(1, ny)));
      const srcX = ((lon/(2*Math.PI))+0.5)*sw;
      const srcY = (0.5-lat/Math.PI)*sh;
      const x0=((Math.floor(srcX)%sw)+sw)%sw, y0=Math.max(0,Math.min(sh-1,Math.floor(srcY)));
      const x1=(x0+1)%sw, y1=Math.min(sh-1,y0+1);
      const fx=srcX-Math.floor(srcX), fy=srcY-Math.floor(srcY);
      const d=( j*outSize+i)*3;
      for (let c=0;c<3;c++) {
        const tl=srcData[(y0*sw+x0)*4+c],tr=srcData[(y0*sw+x1)*4+c];
        const bl=srcData[(y1*sw+x0)*4+c],br=srcData[(y1*sw+x1)*4+c];
        pixels[d+c]=Math.round(tl*(1-fx)*(1-fy)+tr*fx*(1-fy)+bl*(1-fx)*fy+br*fx*fy);
      }
    }
  }
  return pixels;
}

// ── Fisheye (equidistant) → cube face projection ──────────────────────────────
// Projects a circular fisheye image (equidistant model) onto a cube face.
// fisheyeFovDeg: total field of view of the lens in degrees (typically 180).
// The fisheye circle is assumed to be centered in the image with radius = min(sw,sh)/2.
function projectFisheyeFace(srcData, sw, sh, face, outSize, fisheyeFovDeg) {
  const pixels = Buffer.alloc(outSize * outSize * 3);
  const fovRad = (fisheyeFovDeg * Math.PI) / 180;
  const cx = sw / 2, cy = sh / 2;
  const radius = Math.min(sw, sh) / 2; // fisheye circle radius in pixels

  for (let j = 0; j < outSize; j++) {
    for (let i = 0; i < outSize; i++) {
      const u = (2 * (i + 0.5) / outSize) - 1;
      const v = (2 * (j + 0.5) / outSize) - 1;
      let dx, dy, dz;
      switch (face) {
        case 'f': dx= u; dy=-v; dz= 1; break;
        case 'b': dx=-u; dy=-v; dz=-1; break;
        case 'r': dx= 1; dy=-v; dz=-u; break;
        case 'l': dx=-1; dy=-v; dz= u; break;
        case 'u': dx= u; dy= 1; dz= v; break;
        case 'd': dx= u; dy=-1; dz=-v; break;
      }
      const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
      const nx = dx/len, ny = dy/len, nz = dz/len;

      // Spherical coords
      const lat = Math.asin(Math.max(-1, Math.min(1, ny)));   // elevation
      const lon = Math.atan2(nx, nz);                          // azimuth

      // Angle from optical axis (straight ahead = nz>0 hemisphere)
      // For a fisheye we map the full sphere but pixels outside the FOV cone go black
      const theta = Math.acos(Math.max(-1, Math.min(1, nz)));  // angle from forward axis

      const d = outSize * outSize * 3;
      if (theta > fovRad / 2) {
        // Outside lens FOV — write black
        pixels[(j * outSize + i) * 3 + 0] = 0;
        pixels[(j * outSize + i) * 3 + 1] = 0;
        pixels[(j * outSize + i) * 3 + 2] = 0;
        continue;
      }

      // Equidistant projection: r = f * theta, where f = radius / (fovRad/2)
      const r = radius * (theta / (fovRad / 2));
      // Direction in the image plane (azimuth around forward axis)
      const phi = Math.atan2(ny, nx);  // angle in the plane perpendicular to forward
      const srcX = cx + r * Math.cos(phi);
      const srcY = cy - r * Math.sin(phi);

      // Bilinear sample
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(srcX)));
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(srcY)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = srcX - Math.floor(srcX);
      const fy = srcY - Math.floor(srcY);
      const p = (j * outSize + i) * 3;
      for (let c = 0; c < 3; c++) {
        const tl = srcData[(y0*sw+x0)*4+c], tr = srcData[(y0*sw+x1)*4+c];
        const bl = srcData[(y1*sw+x0)*4+c], br = srcData[(y1*sw+x1)*4+c];
        pixels[p+c] = Math.round(tl*(1-fx)*(1-fy) + tr*fx*(1-fy) + bl*(1-fx)*fy + br*fx*fy);
      }
    }
  }
  return pixels;
}

function generateLevels(faceSize) {
  faceSize = Math.max(64, faceSize);
  const TILE = 512;
  const levels = [];
  let z = 0, size = 256;
  // Build levels doubling up until we reach or exceed faceSize
  while (size < faceSize) {
    const tileSize = Math.min(TILE, size);
    levels.push({ z, tileSize, size });
    size *= 2;
    z++;
  }
  // Final level: use the current power-of-2 size (which is >= faceSize).
  // This satisfies ALL Marzipano constraints:
  //   size % tileSize === 0  (power of 2 is always a multiple of 512)
  //   size % parentSize === 0  (each level doubles the previous)
  // We cap at 4096 to avoid excessive memory use for very large images.
  const finalSize = Math.min(size, 4096);
  levels.push({ z, tileSize: TILE, size: finalSize });
  return levels.slice(0, 6);
}

// ── Viewer templates ──────────────────────────────────────────────────────────
function generateViewerHTML(scenes, settings) {
  const logoMatch = settings.logoData && settings.logoData.match(/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/);
  const logoExt   = logoMatch ? logoMatch[1].replace('svg+xml','svg') : null;
  const planMatch = settings.planData && settings.planData.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,/);
  const planExt   = planMatch ? planMatch[1] : null;

  function btnTarget(newTab){ return newTab ? ' target="_blank" rel="noopener"' : ''; }
  const logoHtml   = logoExt ? `<a id="logo-link" href="${safeUrl(settings.logoUrl)}"${btnTarget(settings.logoNewTab)}><img id="logo-img" src="logo.${logoExt}" alt="Logo"></a>` : '';
  function btnStyle(textColor, bgColor){ return textColor||bgColor ? ` style="color:${textColor||'#fff'};background:${bgColor||'rgba(0,0,0,0.65)'}"` : ''; }
  const btn1Html   = settings.btn1Text ? `<a class="top-btn"${btnStyle(settings.btn1TextColor,settings.btn1BgColor)} href="${safeUrl(settings.btn1Url)}"${btnTarget(settings.btn1NewTab)}>${escHtml(settings.btn1Text)}</a>` : '';
  const btn2Html   = settings.btn2Text ? `<a class="top-btn"${btnStyle(settings.btn2TextColor,settings.btn2BgColor)} href="${safeUrl(settings.btn2Url)}"${btnTarget(settings.btn2NewTab)}>${escHtml(settings.btn2Text)}</a>` : '';
  const btn3Html   = settings.btn3Text ? `<a class="top-btn"${btnStyle(settings.btn3TextColor,settings.btn3BgColor)} href="${safeUrl(settings.btn3Url)}"${btnTarget(settings.btn3NewTab)}>${escHtml(settings.btn3Text)}</a>` : '';
  const pw = settings.planSize || 200;
  const ph = Math.round(pw * 0.75);
  const planHtml  = planExt ? `<div id="plan-container" style="width:${pw}px;height:${ph}px">
      <div class="plan-controls-bar">
        <span class="plan-controls-title">Plan</span>
        <button class="plan-ctrl-btn" id="plan-maximize-btn" title="Maximise">&#x26F6;</button>
        <button class="plan-ctrl-btn" id="plan-minimize-btn" title="Minimise">&minus;</button>
      </div>
      <img id="plan-img" src="plan.${planExt}" alt="Plan">
      <canvas id="plan-dots"></canvas>
    </div>
    <button id="plan-restore-btn" hidden>Plan &#9652;</button>` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(settings.title||'Panorama Tour')}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="pano"></div>
  <div id="ui">
    <div id="title-bar"><span id="scene-title">Loading...</span></div>
    <div id="scene-list">
      <button id="scene-list-toggle">&#9776; Scenes</button>
      <div id="scene-list-items"></div>
    </div>
    <div id="top-right">${logoHtml}${btn1Html}${btn2Html}${btn3Html}</div>
    ${planHtml}
    <div id="controls">
      ${settings.fullscreen ? '<button id="fullscreen-btn" title="Fullscreen">&#x26F6;</button>' : ''}
      ${settings.zoom ? '<button id="zoom-in-btn" title="Zoom in">+</button><button id="zoom-out-btn" title="Zoom out">&minus;</button>' : ''}
    </div>
    ${settings.compass ? `<div id="compass-wrap">
      <svg id="compass-svg" viewBox="0 0 60 60" width="60" height="60">
        <circle cx="30" cy="30" r="28" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/>
        <g id="compass-needle">
          <polygon points="30,6 34,30 30,26 26,30" fill="#e94560"/>
          <polygon points="30,54 34,30 30,34 26,30" fill="rgba(255,255,255,0.7)"/>
        </g>
        <circle cx="30" cy="30" r="3" fill="rgba(255,255,255,0.9)"/>
        <text x="30" y="19" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-size="8" font-family="sans-serif" font-weight="bold" class="compass-north-label">N</text>
        <g id="flat-north-arrow" hidden>
          <polygon points="30,8 40,32 30,27 20,32" fill="#e94560"/>
          <rect x="27.5" y="27" width="5" height="16" rx="2.5" fill="rgba(255,255,255,0.88)"/>
          <text x="30" y="52" text-anchor="middle" fill="rgba(255,255,255,0.95)" font-size="10" font-family="sans-serif" font-weight="700">N</text>
        </g>
      </svg>
    </div>` : ''}
  </div>
  <script src="marzipano.js"></script>
  <script src="app.js"></script>
</body>
</html>`;
}

function generateAppJS(scenes, settings) {
  const scenesJson = JSON.stringify(scenes.map(s=>({
    id:s.id, name:s.name, levels:s.levels, faceSize:s.faceSize,
    initialView:s.initialView||{yaw:0,pitch:0,fov:1.5707963},
    hotspots:(s.hotspots||[]).map(h => {
      if ((s.projection === 'flat' || s.isPano === false) && h) {
        return Object.assign({}, h, {
          x: h.x != null ? h.x : 0.5,
          y: h.y != null ? h.y : 0.5
        });
      }
      return h;
    }),
    planDot:s.planDot ? Object.assign({ rotation: 0 }, s.planDot) : null,
    compassEnabled:s.compassEnabled !== false,
    northOffset:s.northOffset||0,
    projection:s.projection || (s.isPano===false ? 'flat' : 'cube'),
    flat:s.flat ? {
      width:  s.flat.width,
      height: s.flat.height,
      url:    (s.flat.url || ('tiles/'+s.id+'/flat.jpg')).replace(/^\//,'')
    } : null,
    sourceUrl:s.sourceUrl || null,
    fisheyeFov:s.fisheyeFov || null
  })),null,2);

  return `(function(){
  var APP = {settings:${JSON.stringify(settings)}, scenes:${scenesJson}};
  var viewer = new Marzipano.Viewer(document.getElementById('pano'),{controls:{mouseViewMode:'${settings.mouseMode||'drag'}'}});
  var scenes={}, currentId=null;
  var planContainer=document.getElementById('plan-container');
  var planRestoreBtn=document.getElementById('plan-restore-btn');
  var controlsEl=document.getElementById('controls');
  var ICON_SVGS={
    camera:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    arrow:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    door:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4H6a2 2 0 0 0-2 2v14"/><path d="M2 20h20"/><path d="M13 4a2 2 0 0 1 2 2v14H4"/><circle cx="15" cy="12" r="1" fill="currentColor"/></svg>',
    star:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    eye:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    location:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>'
  };
  function getLinkIcon(type){ return ICON_SVGS[type]||ICON_SVGS.camera; }
  function applyHotspotTheme(marker, type){
    var colors=(APP.settings.hotspotColors && APP.settings.hotspotColors[type]) || (APP.settings.hotspotColors && APP.settings.hotspotColors.camera) || { bg:'#ffab91', icon:'#7b2d00' };
    marker.style.background = colors.bg;
    marker.style.color = colors.icon;
    if(type==='info'){
      marker.style.fontWeight='700';
      marker.style.fontStyle='normal';
    }
  }

  APP.scenes.forEach(function(sd){
    var sc;
    if(sd.projection==='flat' && sd.flat && sd.flat.width && sd.flat.height){
      var fGeo = new Marzipano.FlatGeometry([{
        width: sd.flat.width,
        height: sd.flat.height,
        tileWidth: sd.flat.width,
        tileHeight: sd.flat.height
      }]);
      var fSrc = Marzipano.ImageUrlSource.fromString(sd.flat.url || ('tiles/'+sd.id+'/flat.jpg'));
      var fLim = Marzipano.util.compose(
        Marzipano.FlatView.limit.resolution(sd.flat.width),
        Marzipano.FlatView.limit.letterbox()
      );
      var fView = new Marzipano.FlatView({
        mediaAspectRatio: sd.flat.width / sd.flat.height,
        x: (sd.initialView && sd.initialView.x!=null) ? sd.initialView.x : 0.5,
        y: (sd.initialView && sd.initialView.y!=null) ? sd.initialView.y : 0.5,
        zoom: (sd.initialView && sd.initialView.zoom!=null) ? sd.initialView.zoom : 1
      }, fLim);
      sc = viewer.createScene({source:fSrc,geometry:fGeo,view:fView,pinFirstLevel:true});
    } else {
      var geo  = new Marzipano.CubeGeometry(sd.levels);
      var src  = Marzipano.ImageUrlSource.fromString('tiles/'+sd.id+'/{z}/{f}/{y}/{x}.jpg',{cubeMapPreviewUrl:'tiles/'+sd.id+'/preview.jpg'});
      var lim  = Marzipano.RectilinearView.limit.traditional(sd.faceSize,120*Math.PI/180);
      var view = new Marzipano.RectilinearView(sd.initialView,lim);
      sc = viewer.createScene({source:src,geometry:geo,view:view,pinFirstLevel:true});
    }

    (sd.hotspots||[]).forEach(function(hs){
      var wrap=document.createElement('div'); wrap.className='hotspot-wrap';
      if(hs.type==='info'){
        var icon=document.createElement('div'); icon.className='hs-icon hs-info'; icon.textContent='i';
        applyHotspotTheme(icon, 'info');
        var lbl=document.createElement('div'); lbl.className='hs-label'; lbl.textContent=hs.text;
        wrap.appendChild(icon); wrap.appendChild(lbl);
        var exp=false;
        wrap.style.cursor='pointer';
        wrap.addEventListener('click',function(e){e.stopPropagation();exp=!exp;lbl.classList.toggle('hs-label-expanded',exp);});
      } else {
        var icon=document.createElement('div');
        icon.className='hs-icon hs-link hs-link-'+( hs.icon||'camera');
        icon.innerHTML=getLinkIcon(hs.icon||'camera');
        applyHotspotTheme(icon, hs.icon||'camera');
        wrap.style.cursor='pointer';
        wrap.appendChild(icon);
        (function(tid){wrap.addEventListener('click',function(e){e.stopPropagation();switchScene(tid);});})(hs.targetId);
      }
      var hsPos=(sd.projection==='flat'&&sd.flat)
        ? {x:hs.x!=null?hs.x:0.5,y:hs.y!=null?hs.y:0.5}
        : {yaw:hs.yaw,pitch:hs.pitch};
      sc.hotspotContainer().createHotspot(wrap,hsPos);
    });
    scenes[sd.id]={data:sd,scene:sc};
  });

  var listEl=document.getElementById('scene-list-items');
  APP.scenes.forEach(function(s){
    var btn=document.createElement('button'); btn.textContent=s.name;
    btn.onclick=function(){switchScene(s.id);}; listEl.appendChild(btn);
  });
  document.getElementById('scene-list-toggle').addEventListener('click',function(){listEl.classList.toggle('open');});

  ${settings.fullscreen?`document.getElementById('fullscreen-btn').addEventListener('click',function(){if(!document.fullscreenElement)document.documentElement.requestFullscreen();else document.exitFullscreen();});`:''}

  ${settings.zoom?`
  document.getElementById('zoom-in-btn').addEventListener('click',function(){
    var s=scenes[currentId]; if(!s)return;
    var v=s.scene.view();
    if(s.data.projection==='flat'){
      var curZoom=typeof v.zoom==='function' ? v.zoom() : 1;
      v.setParameters({ zoom: Math.min(curZoom*1.2, 8) });
    } else {
      v.setFov(Math.max(v.fov()*0.8, 0.2));
    }
  });
  document.getElementById('zoom-out-btn').addEventListener('click',function(){
    var s=scenes[currentId]; if(!s)return;
    var v=s.scene.view();
    if(s.data.projection==='flat'){
      var curZoom=typeof v.zoom==='function' ? v.zoom() : 1;
      v.setParameters({ zoom: Math.max(curZoom/1.2, 1) });
    } else {
      v.setFov(Math.min(v.fov()*1.25, Math.PI*0.9));
    }
  });`:''}

  ${settings.compass?`
  var compassNeedle=document.getElementById('compass-needle');
  var compassWrap=document.getElementById('compass-wrap');
  var flatNorthArrow=document.getElementById('flat-north-arrow');
  function updateCompass(){
    var s=scenes[currentId]; if(!s||!compassNeedle||!compassWrap||!flatNorthArrow)return;
    if(s.data.compassEnabled===false){
      compassWrap.style.display='none';
      return;
    }
    compassWrap.style.display='';
    var deg;
    if(s.data.projection==='flat'){
      compassWrap.classList.add('flat-mode');
      flatNorthArrow.hidden=false;
      deg=-(s.data.northOffset||0);
    } else {
      compassWrap.classList.remove('flat-mode');
      flatNorthArrow.hidden=true;
      var yaw=s.scene.view().yaw();
      var northOffset=(s.data.northOffset||0)*Math.PI/180;
      deg=-((yaw-northOffset)*180/Math.PI);
    }
    compassNeedle.setAttribute('transform','rotate('+deg+',30,30)');
  }
  // Poll view changes for compass rotation
  setInterval(updateCompass, 50);`:''}


  function drawPlanSymbol(ctx,x,y,r,color,type,rotation,isActive,ringColor){
    ringColor=ringColor||'#000000';
    ctx.save(); ctx.translate(x,y);
    if(type==='arrow'){
      ctx.rotate((rotation*Math.PI)/180);
      var coneLen=r*2.8, halfA=Math.PI/6;
      ctx.beginPath(); ctx.moveTo(0,0);
      ctx.lineTo(Math.sin(-halfA)*coneLen,-Math.cos(halfA)*coneLen);
      ctx.arc(0,0,coneLen,-Math.PI/2-halfA,-Math.PI/2+halfA);
      ctx.closePath();
      ctx.fillStyle=color+(isActive?'cc':'88'); ctx.fill();
      ctx.strokeStyle=isActive?'rgba(0,0,0,0.7)':'rgba(0,0,0,0.4)'; ctx.lineWidth=1; ctx.stroke();
      ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2);
      ctx.fillStyle=color; ctx.fill(); ctx.strokeStyle=ringColor; ctx.lineWidth=1.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2);
      ctx.fillStyle=color; ctx.fill(); ctx.strokeStyle=ringColor; ctx.lineWidth=1.5; ctx.stroke();
    }
    ctx.restore();
  }

  function drawPlanDots(activeId){
    var canvas=document.getElementById('plan-dots');
    if(!canvas)return;
    var container=document.getElementById('plan-container');
    if(!container)return;
    canvas.width=container.offsetWidth; canvas.height=container.offsetHeight;
    var ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    var scale=canvas.width/200;
    var r=(APP.settings.dotSize||4)*scale;
    var activeCol=APP.settings.dotActiveColor||'#00cc44';
    var inactiveCol=APP.settings.dotInactiveColor||'#ffffff';
    var dotType=APP.settings.dotType||'circle';
    APP.scenes.forEach(function(sd){
      if(!sd.planDot)return;
      var x=sd.planDot.x*canvas.width, y=sd.planDot.y*canvas.height;
      var isActive=sd.id===activeId;
      drawPlanSymbol(ctx,x,y,r,isActive?activeCol:inactiveCol,dotType,sd.planDot.rotation||0,isActive,APP.settings.dotRingColor||'#000000');
    });
  }

  function updateControlDock(){
    if(!controlsEl) return;
    if(planRestoreBtn && !planRestoreBtn.hidden){
      controlsEl.style.bottom='66px';
      controlsEl.style.right='20px';
      return;
    }
    if(!planContainer || planContainer.hidden){
      controlsEl.style.bottom='20px';
      controlsEl.style.right='20px';
      return;
    }
    controlsEl.style.right='20px';
    controlsEl.style.bottom=(planContainer.offsetHeight + 32)+'px';
  }

  function setPlanMinimised(minimised){
    if(!planContainer || !planRestoreBtn) return;
    planContainer.hidden=!!minimised;
    planRestoreBtn.hidden=!minimised;
    updateControlDock();
    drawPlanDots(currentId);
  }

  function setPlanMaximised(maximised){
    if(!planContainer) return;
    planContainer.classList.toggle('plan-maximised', !!maximised);
    updateControlDock();
    drawPlanDots(currentId);
  }

  // Click on plan to navigate to that scene
  var planCanvas=document.getElementById('plan-dots');
  if(planCanvas){
    planCanvas.style.pointerEvents='all'; planCanvas.style.cursor='pointer';
    planCanvas.addEventListener('click',function(e){
      var rect=planCanvas.getBoundingClientRect();
      var cx=(e.clientX-rect.left)/rect.width, cy=(e.clientY-rect.top)/rect.height;
      var best=null, bestDist=Infinity;
      var r=APP.settings.dotSize||4;
      var scaledR=r*(rect.width/200);
      var tol=Math.max(0.06,(scaledR*3)/rect.width);
      APP.scenes.forEach(function(sd){
        if(!sd.planDot)return;
        var dx=sd.planDot.x-cx, dy=sd.planDot.y-cy;
        var dist=Math.sqrt(dx*dx+dy*dy);
        if(dist<tol&&dist<bestDist){bestDist=dist;best=sd;}
      });
      if(best&&best.id!==currentId)switchScene(best.id);
    });
  }
  var planMinBtn=document.getElementById('plan-minimize-btn');
  if(planMinBtn){ planMinBtn.addEventListener('click',function(e){ e.stopPropagation(); setPlanMinimised(true); }); }
  var planRestore=document.getElementById('plan-restore-btn');
  if(planRestore){ planRestore.addEventListener('click',function(e){ e.stopPropagation(); setPlanMinimised(false); }); }
  var planMaxBtn=document.getElementById('plan-maximize-btn');
  if(planMaxBtn){ planMaxBtn.addEventListener('click',function(e){ e.stopPropagation(); setPlanMaximised(!planContainer.classList.contains('plan-maximised')); }); }

  function switchScene(id){
    var s=scenes[id]; if(!s)return;
    currentId=id;
    if(s.data.projection==='flat'){
      var fv=s.scene.view();
      fv.setParameters({
        x: (s.data.initialView && s.data.initialView.x!=null) ? s.data.initialView.x : 0.5,
        y: (s.data.initialView && s.data.initialView.y!=null) ? s.data.initialView.y : 0.5,
        zoom: (s.data.initialView && s.data.initialView.zoom!=null) ? s.data.initialView.zoom : 1
      });
    } else {
      var rv=s.scene.view();
      rv.setYaw(s.data.initialView.yaw||0);
      rv.setPitch(s.data.initialView.pitch||0);
      rv.setFov(s.data.initialView.fov||1.5707963);
    }
    s.scene.switchTo({transitionDuration:800});
    document.getElementById('scene-title').textContent=s.data.name;
    listEl.classList.remove('open');
    drawPlanDots(id);
    updateControlDock();
    ${settings.autorotate?`viewer.setIdleMovement(800,Marzipano.autorotate({yawSpeed:0.05,targetPitch:0,targetFov:Math.PI/2}));`:''}
  }

  var planImg=document.getElementById('plan-img');
  if(planImg){planImg.addEventListener('load',function(){drawPlanDots(currentId);});if(planImg.complete)drawPlanDots(currentId);}
  window.addEventListener('resize',function(){drawPlanDots(currentId); updateControlDock();});
  var planCon=document.getElementById('plan-container');
  if(planCon&&window.ResizeObserver){new ResizeObserver(function(){drawPlanDots(currentId); updateControlDock();}).observe(planCon);}
  updateControlDock();

  if(APP.scenes.length>0)switchScene(APP.scenes[0].id);
})();`;
}

function generateAppCSS(){
  return `*{box-sizing:border-box;margin:0;padding:0;}
[hidden]{display:none!important;}
body{background:#000;overflow:hidden;font-family:sans-serif;}
#pano{position:fixed;inset:0;}
#ui{position:fixed;inset:0;pointer-events:none;}
#title-bar{position:absolute;top:16px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.6);color:#fff;padding:8px 20px;border-radius:20px;font-size:15px;backdrop-filter:blur(4px);white-space:nowrap;}
#scene-list{position:absolute;top:16px;left:16px;pointer-events:all;}
#scene-list-toggle{background:rgba(0,0,0,0.7);color:#fff;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:14px;backdrop-filter:blur(4px);}
#scene-list-toggle:hover{background:rgba(0,0,0,0.9);}
#scene-list-items{display:none;flex-direction:column;gap:6px;margin-top:8px;}
#scene-list-items.open{display:flex;}
#scene-list-items button{background:rgba(0,0,0,0.8);color:#fff;border:1px solid rgba(255,255,255,0.2);padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;text-align:left;}
#scene-list-items button:hover{background:rgba(255,255,255,0.15);}
#top-right{position:absolute;top:16px;right:16px;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:all;max-width:45vw;}
#logo-link{display:flex;align-items:center;}
#logo-img{height:40px;max-width:140px;object-fit:contain;filter:drop-shadow(0 1px 4px rgba(0,0,0,0.6));}
.top-btn{color:#fff;text-decoration:none;font-size:13px;font-weight:600;background:rgba(0,0,0,0.65);padding:7px 16px;border-radius:8px;backdrop-filter:blur(4px);white-space:nowrap;display:block;text-align:center;}
.top-btn:hover{background:rgba(0,0,0,0.9);}
.top-btn-accent{background:rgba(233,69,96,0.85);}
.top-btn-accent:hover{background:rgba(200,50,70,0.95);}
#controls{position:absolute;bottom:20px;right:20px;display:flex;flex-direction:column;gap:8px;pointer-events:all;transition:bottom .18s ease,right .18s ease;}
#controls button{background:rgba(0,0,0,0.7);color:#fff;border:1px solid rgba(255,255,255,0.2);width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:18px;backdrop-filter:blur(4px);line-height:1;}
#controls button:hover{background:rgba(255,255,255,0.2);}
#compass-wrap{position:absolute;bottom:20px;left:20px;pointer-events:none;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5));}
#compass-wrap.flat-mode svg{transform:none;}
#compass-wrap.flat-mode .compass-north-label{display:none;}
#compass-wrap.flat-mode #flat-north-arrow{display:block;}
@media(max-width:768px){#compass-wrap{bottom:16px;left:12px;} #compass-wrap svg{width:48px;height:48px;}}
#plan-container{position:absolute;bottom:20px;right:20px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,0.6);background:#111;overflow:hidden;}
#plan-container.plan-maximised{width:min(70vw,720px)!important;height:min(70vh,540px)!important;right:20px;bottom:20px;z-index:8;}
#plan-img{width:100%;height:100%;object-fit:contain;display:block;border-radius:8px;}
#plan-dots{position:absolute;inset:0;pointer-events:none;width:100%;height:100%;}
#plan-restore-btn{position:absolute;bottom:20px;right:20px;pointer-events:all;background:rgba(0,0,0,0.7);color:#fff;border:1px solid rgba(255,255,255,0.2);padding:8px 12px;border-radius:999px;cursor:pointer;font-size:13px;backdrop-filter:blur(4px);}
#plan-restore-btn:hover{background:rgba(255,255,255,0.16);}
.plan-controls-bar{position:absolute;top:8px;right:8px;left:8px;display:flex;align-items:center;justify-content:flex-end;gap:6px;z-index:2;}
.plan-controls-title{margin-right:auto;background:rgba(0,0,0,0.55);color:#fff;padding:4px 8px;border-radius:999px;font-size:11px;}
.plan-ctrl-btn{width:28px;height:28px;border-radius:999px;border:1px solid rgba(255,255,255,0.18);background:rgba(0,0,0,0.58);color:#fff;cursor:pointer;font-size:15px;line-height:1;pointer-events:all;}
.plan-ctrl-btn:hover{background:rgba(255,255,255,0.16);}
@media(max-width:768px){
  #top-right{top:12px!important;right:12px!important;max-width:55vw!important;gap:6px!important;}
  #logo-img{height:30px;max-width:100px;}
  .top-btn{font-size:11px;padding:5px 10px;}
  #title-bar{font-size:12px;padding:5px 12px;max-width:55vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  #plan-container{bottom:16px!important;left:50%!important;right:auto!important;transform:translateX(-50%)!important;width:52vw!important;height:39vw!important;}
  #plan-container.plan-maximised{left:50%!important;right:auto!important;bottom:16px!important;transform:translateX(-50%)!important;width:min(92vw,560px)!important;height:min(68vh,420px)!important;}
  #plan-restore-btn{bottom:16px;right:12px;}
}
.hotspot-wrap{display:flex;flex-direction:column;align-items:center;gap:4px;transform:translate(-50%,-50%);cursor:default;position:relative;}
.hs-icon{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,0.6);transition:transform 0.15s;padding:8px;}
.hotspot-wrap:hover .hs-icon{transform:scale(1.15);}
.hs-info{background:#2196F3;font-size:20px;}
.hs-link{font-style:normal;cursor:pointer;}
.hs-link-camera{background:#FFAB91;color:#7B2D00;}
.hs-link-arrow{background:#CE93D8;color:#4A0070;font-style:normal;}
.hs-link-door{background:#A5D6A7;color:#1B5E20;}
.hs-link-star{background:#FFCC80;color:#7B3E00;}
.hs-link-eye{background:#80DEEA;color:#004D55;}
.hs-link-location{background:#FFAB91;color:#7B1500;}
.hs-label{background:rgba(0,0,0,0.82);color:#fff;padding:5px 12px;border-radius:10px;font-size:12px;max-width:200px;text-align:center;position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:all 0.2s ease;}
.hs-label-expanded{white-space:normal;overflow:visible;text-overflow:unset;width:240px;text-align:left;}`;
}

function generateReadme(settings, scenes, exportType){
  exportType = exportType || 'full';
  const APP_VERSION = '0.5.15';
  const isSlim = exportType === 'slim';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day:'2-digit', month:'long', year:'numeric' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  const sceneList = (scenes||[]).map((s,i) => `  ${i+1}. ${s.name||('Scene '+(i+1))}`).join('\n');
  const lines = [
    'PanoPath by illerin',
    '===================',
    `Version:     ${APP_VERSION}`,
    `Export type: ${isSlim ? 'Hosting Only' : 'Full Export'}`,
    `Title:       ${settings.title||'Panorama Tour'}`,
    `Exported:    ${dateStr} at ${timeStr}`,
    `Scenes:      ${(scenes||[]).length}`,
    sceneList,
    '',
    'Hosting',
    '-------',
    'Upload all files to any static web server and open index.html.',
    'All assets including marzipano.js are bundled — no internet connection required.',
    '',
    'Re-editing',
    '----------',
  ];
  if (isSlim) {
    lines.push('This is a Hosting Only export. It does not include source images or project.json.');
    lines.push('It cannot be re-imported into PanoPath for future editing.');
    lines.push('To retain editing capability, use Full Export instead.');
  } else {
    lines.push('This is a Full Export. Import the ZIP back into PanoPath using Project -> Import ZIP to continue editing.');
  }
  return lines.join('\n');
}

function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function safeUrl(s){
  s=String(s||'').trim(); if(!s)return'#';
  if(/^https?:\/\//i.test(s))return s;
  if(s.startsWith('//')||s.startsWith('#')||s.startsWith('/'))return s;
  return'https://'+s;
}

ensureMarzipano().then(() => {
  app.listen(PORT, () => console.log(`PanoPath Local Tool running on http://localhost:${PORT}`));
});
