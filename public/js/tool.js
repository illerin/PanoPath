/* ============================================================
   PanoPath - Tool JS
   ============================================================ */
(function () {
  'use strict';

  var state = {
    scenes: [], activeSceneId: null, firstSceneId: null,
    placingHotspot: null, pendingCoords: null,
    pendingLinkTarget: null, pendingLinkIcon: 'camera',
    placingPlanDot: false,
    marzViewer: null, marzScenes: {},
    logoData: null, planData: null, planSize: 200,
    dotType: 'circle', dotRotationDefault: 0,
    dotSize: 4, dotActiveColor: '#00cc44', dotInactiveColor: '#ffffff',
    hotspotColors: {
      info: { bg:'#2196f3', icon:'#ffffff' },
      camera: { bg:'#ffab91', icon:'#7b2d00' },
      arrow: { bg:'#ce93d8', icon:'#4a0070' },
      door: { bg:'#a5d6a7', icon:'#1b5e20' },
      star: { bg:'#ffcc80', icon:'#7b3e00' },
      eye: { bg:'#80deea', icon:'#004d55' },
      location: { bg:'#ffab91', icon:'#7b1500' }
    },
    cancelUpload: false,
    btn1TextColor:'#ffffff', btn1BgColor:'#000000',
    btn2TextColor:'#ffffff', btn2BgColor:'#000000',
    btn3TextColor:'#ffffff', btn3BgColor:'#e94560',
  };

  var $  = function(s){ return document.querySelector(s); };
  var $$ = function(s){ return document.querySelectorAll(s); };
  var PRESET_STORAGE_KEY = 'panopath-style-presets-v1';
  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!==undefined)e.textContent=txt; return e; }
  function genId(){ return Math.random().toString(36).slice(2,10); }
  function readAsDataURL(f,cb){ var r=new FileReader(); r.onload=function(e){cb(e.target.result);}; r.readAsDataURL(f); }
  function getSceneById(id){ return state.scenes.find(function(s){ return s.id===id; }) || null; }
  function getActiveScene(){ return getSceneById(state.activeSceneId); }
  function isFlatScene(sd){ return !!(sd && sd.projection==='flat' && sd.flat && sd.flat.width && sd.flat.height); }

  function buildSceneFromProcessResult(file, result) {
    return {
      id: result.sceneId,
      name: file.name.replace(/\.[^.]+$/,''),
      levels: result.levels,
      faceSize: result.faceSize,
      previewUrl: result.previewUrl,
      sourceUrl: result.sourceUrl || null,
      initialView: result.suggestedInitialView || { yaw:0, pitch:0, fov:1.5707963 },
      initialViewSet: false,
      hotspots: [],
      isPano: result.isPano,
      projection: result.projection || (result.isPano ? 'cube' : 'flat'),
      flat: result.flat || null,
      planDot: null,
      compassEnabled: true,
      northOffset: 0
    };
  }

  function normalizeLoadedScene(sc) {
    if(!sc) return sc;
    sc.hotspots = sc.hotspots || [];
    sc.initialView = sc.initialView || { yaw:0, pitch:0, fov:1.5707963 };
    sc.initialViewSet = !!sc.initialViewSet;
    sc.projection = sc.projection || (sc.isPano===false ? 'flat' : 'cube');
    sc.flat = sc.flat || null;
    sc.sourceUrl = sc.sourceUrl || null;
    sc.planDot = sc.planDot || null;
    if(sc.planDot && sc.planDot.rotation == null) sc.planDot.rotation = 0;
    sc.compassEnabled = sc.compassEnabled !== false;
    sc.northOffset = sc.northOffset || 0;
    return sc;
  }

  function getActiveViewParams() {
    var sd=getActiveScene(), ms=state.marzScenes[state.activeSceneId];
    if(!sd||!ms) return null;
    var v=ms.view();
    if(isFlatScene(sd)){
      return {
        x: typeof v.x==='function' ? v.x() : 0.5,
        y: typeof v.y==='function' ? v.y() : 0.5,
        zoom: typeof v.zoom==='function' ? v.zoom() : 1
      };
    }
    return { yaw:v.yaw(), pitch:v.pitch(), fov:v.fov() };
  }

  function refreshSceneRendering() {
    var activeId = state.activeSceneId;
    var currentView = getActiveViewParams();
    Object.keys(state.marzScenes).forEach(function(id){
      var ms=state.marzScenes[id];
      if(ms){ try{ state.marzViewer.destroyScene(ms); }catch(e){} }
    });
    state.marzScenes={};
    if(activeId) activateScene(activeId, currentView);
  }

  function applyHotspotTheme(marker, type){
    var palette = state.hotspotColors[type] || state.hotspotColors.camera;
    marker.style.background = palette.bg;
    marker.style.color = palette.icon;
    if(type==='info'){
      marker.style.fontWeight='700';
      marker.style.fontStyle='normal';
    }
  }

  function syncHotspotColorInputs(){
    Object.keys(state.hotspotColors).forEach(function(type){
      var bg=$('#hotspot-'+type+'-bg-color'), icon=$('#hotspot-'+type+'-icon-color');
      if(bg) bg.value=state.hotspotColors[type].bg;
      if(icon) icon.value=state.hotspotColors[type].icon;
    });
  }

  var PRESET_STORAGE_KEY = 'panopath-style-presets-v1';

  // ── Presets — server-backed ────────────────────────────────────────────────
  // In-memory cache so reads are synchronous after the initial fetch
  var _presetsCache = null;

  function loadPresetsFromServer(cb) {
    fetch('/api/presets')
      .then(function(r){ return r.json(); })
      .then(function(data){
        _presetsCache = data.presets || [];
        // One-time migration: if localStorage has presets and server has none, migrate them
        if (_presetsCache.length === 0) {
          try {
            var local = JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '[]');
            if (local.length > 0) {
              _presetsCache = local;
              savePresetsToServer(_presetsCache, function(){
                localStorage.removeItem(PRESET_STORAGE_KEY);
                console.log('Migrated ' + local.length + ' preset(s) from localStorage to server.');
              });
            }
          } catch(e) {}
        }
        if (cb) cb(_presetsCache);
      })
      .catch(function(){ _presetsCache = _presetsCache || []; if (cb) cb(_presetsCache); });
  }

  function savePresetsToServer(presets, cb) {
    fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presets: presets })
    })
      .then(function(r){ return r.json(); })
      .then(function(){ if (cb) cb(); })
      .catch(function(e){ console.error('Failed to save presets:', e); });
  }

  function readPresets() {
    return _presetsCache || [];
  }

  function writePresets(presets, cb) {
    _presetsCache = presets;
    savePresetsToServer(presets, cb);
  }

  function populatePresetSelect(selectedName) {
    var sel=$('#preset-select'); if(!sel) return;
    var presets=readPresets();
    sel.innerHTML='<option value="">— select preset —</option>';
    presets.forEach(function(p){
      var opt=document.createElement('option');
      opt.value=p.name; opt.textContent=p.name;
      if(selectedName && selectedName===p.name) opt.selected=true;
      sel.appendChild(opt);
    });
  }

  function collectPresetData(){
    return {
      autorotate: $('#setting-autorotate').checked,
      fullscreen: $('#setting-fullscreen').checked,
      zoom: $('#setting-zoom').checked,
      compass: $('#setting-compass').checked,
      mouseMode: $('#setting-mousemode').value,
      logoData: state.logoData || null,
      hotspotColors: JSON.parse(JSON.stringify(state.hotspotColors)),
      logoUrl: $('#setting-logo-url').value || '',
      logoNewTab: $('#setting-logo-newtab').checked,
      btn1Text: $('#setting-btn1-text').value || '',
      btn1Url: $('#setting-btn1-url').value || '',
      btn1NewTab: $('#setting-btn1-newtab').checked,
      btn1TextColor: state.btn1TextColor,
      btn1BgColor: state.btn1BgColor,
      btn2Text: $('#setting-btn2-text').value || '',
      btn2Url: $('#setting-btn2-url').value || '',
      btn2NewTab: $('#setting-btn2-newtab').checked,
      btn2TextColor: state.btn2TextColor,
      btn2BgColor: state.btn2BgColor,
      btn3Text: $('#setting-btn3-text').value || '',
      btn3Url: $('#setting-btn3-url').value || '',
      btn3NewTab: $('#setting-btn3-newtab').checked,
      btn3TextColor: state.btn3TextColor,
      btn3BgColor: state.btn3BgColor
    };
  }

  function applyPresetData(data){
    if(!data) return;
    if(data.autorotate != null) $('#setting-autorotate').checked=!!data.autorotate;
    if(data.fullscreen != null) $('#setting-fullscreen').checked=!!data.fullscreen;
    if(data.zoom != null) $('#setting-zoom').checked=!!data.zoom;
    if(data.compass != null) $('#setting-compass').checked=!!data.compass;
    if(data.mouseMode) $('#setting-mousemode').value=data.mouseMode;
    if(data.logoData){ state.logoData=data.logoData; $('#logo-preview').src=data.logoData; $('#logo-preview-wrap').hidden=false; }
    if(data.hotspotColors){
      Object.keys(state.hotspotColors).forEach(function(type){
        if(data.hotspotColors[type]){
          state.hotspotColors[type].bg = data.hotspotColors[type].bg || state.hotspotColors[type].bg;
          state.hotspotColors[type].icon = data.hotspotColors[type].icon || state.hotspotColors[type].icon;
        }
      });
      syncHotspotColorInputs();
      updateAllHotspotPreviews();
    }
    $('#setting-logo-newtab').checked=!!data.logoNewTab;
    $('#setting-btn1-text').value=data.btn1Text||'';
    $('#setting-btn1-url').value=data.btn1Url||'';
    $('#setting-btn1-newtab').checked=!!data.btn1NewTab;
    if(data.btn1TextColor){ state.btn1TextColor=data.btn1TextColor; $('#btn1-text-color').value=data.btn1TextColor; }
    if(data.btn1BgColor){ state.btn1BgColor=data.btn1BgColor; $('#btn1-bg-color').value=data.btn1BgColor; }
    $('#setting-btn2-text').value=data.btn2Text||'';
    $('#setting-btn2-url').value=data.btn2Url||'';
    $('#setting-btn2-newtab').checked=!!data.btn2NewTab;
    if(data.btn2TextColor){ state.btn2TextColor=data.btn2TextColor; $('#btn2-text-color').value=data.btn2TextColor; }
    if(data.btn2BgColor){ state.btn2BgColor=data.btn2BgColor; $('#btn2-bg-color').value=data.btn2BgColor; }
    $('#setting-btn3-text').value=data.btn3Text||'';
    $('#setting-btn3-url').value=data.btn3Url||'';
    $('#setting-btn3-newtab').checked=!!data.btn3NewTab;
    if(data.btn3TextColor){ state.btn3TextColor=data.btn3TextColor; $('#btn3-text-color').value=data.btn3TextColor; }
    if(data.btn3BgColor){ state.btn3BgColor=data.btn3BgColor; $('#btn3-bg-color').value=data.btn3BgColor; }
    wireBtnColors(1); wireBtnColors(2); wireBtnColors(3);
    updateBtnPreviews();
    updatePreviewOverlay();
    refreshSceneRendering();
  }

  function drawPlanSymbol(ctx,x,y,r,color,type,rotation,isActive){
    ctx.save();
    ctx.translate(x,y);
    if(type==='arrow'){
      ctx.rotate((rotation*Math.PI)/180);
      var coneLen=r*2.8, halfA=Math.PI/6;
      ctx.beginPath();
      ctx.moveTo(0,0);
      ctx.lineTo(Math.sin(-halfA)*coneLen,-Math.cos(halfA)*coneLen);
      ctx.arc(0,0,coneLen,-Math.PI/2-halfA,-Math.PI/2+halfA);
      ctx.closePath();
      ctx.fillStyle=color+(isActive?'cc':'88');
      ctx.fill();
      ctx.strokeStyle=isActive?'rgba(0,0,0,0.7)':'rgba(0,0,0,0.4)';
      ctx.lineWidth=1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0,0,r,0,Math.PI*2);
      ctx.fillStyle=color;
      ctx.fill();
      ctx.strokeStyle='#000';
      ctx.lineWidth=1.5;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0,0,r,0,Math.PI*2);
      ctx.fillStyle=color;
      ctx.fill();
      ctx.strokeStyle='#000';
      ctx.lineWidth=1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  function createMarzipanoScene(sd, viewToUse) {
    if(isFlatScene(sd)){
      var flatLevels=[{
        width: sd.flat.width,
        height: sd.flat.height,
        tileWidth: sd.flat.width,
        tileHeight: sd.flat.height
      }];
      var fGeo=new Marzipano.FlatGeometry(flatLevels);
      var fSrc=Marzipano.ImageUrlSource.fromString(sd.flat.url || ('/tiles/'+sd.id+'/flat.jpg'));
      var fLim=Marzipano.util.compose(
        Marzipano.FlatView.limit.resolution(sd.flat.width),
        Marzipano.FlatView.limit.letterbox()
      );
      var fView=new Marzipano.FlatView({
        mediaAspectRatio: sd.flat.width / sd.flat.height,
        x: (viewToUse && viewToUse.x!=null) ? viewToUse.x : 0.5,
        y: (viewToUse && viewToUse.y!=null) ? viewToUse.y : 0.5,
        zoom: (viewToUse && viewToUse.zoom!=null) ? viewToUse.zoom : 1
      }, fLim);
      var sc = state.marzViewer.createScene({source:fSrc,geometry:fGeo,view:fView,pinFirstLevel:true});
      return sc;
    }

    if(!sd.levels || !sd.levels.length) throw new Error('Scene '+sd.id+' has no levels');
    if(!sd.faceSize) throw new Error('Scene '+sd.id+' has no faceSize');
    var geo=new Marzipano.CubeGeometry(sd.levels);
    var tileUrl='/tiles/'+sd.id+'/{z}/{f}/{y}/{x}.jpg';
    var src=Marzipano.ImageUrlSource.fromString(tileUrl,{cubeMapPreviewUrl:sd.previewUrl});
    var lim=Marzipano.RectilinearView.limit.traditional(sd.faceSize,120*Math.PI/180);
    var view=new Marzipano.RectilinearView(viewToUse,lim);
    var sc = state.marzViewer.createScene({source:src,geometry:geo,view:view,pinFirstLevel:true});
    return sc;
  }

  function applyViewToScene(sd, scene, viewToUse) {
    var v=scene.view();
    if(isFlatScene(sd)){
      v.setParameters({
        x: (viewToUse && viewToUse.x!=null) ? viewToUse.x : 0.5,
        y: (viewToUse && viewToUse.y!=null) ? viewToUse.y : 0.5,
        zoom: (viewToUse && viewToUse.zoom!=null) ? viewToUse.zoom : 1
      });
      return;
    }
    v.setYaw(viewToUse.yaw); v.setPitch(viewToUse.pitch); v.setFov(viewToUse.fov);
  }

  var LINK_ICONS = {
    camera:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    arrow:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    door:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4H6a2 2 0 0 0-2 2v14"/><path d="M2 20h20"/><path d="M13 4a2 2 0 0 1 2 2v14H4"/><circle cx="15" cy="12" r="1" fill="currentColor"/></svg>',
    star:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    eye:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    location:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>'
  };

  // ── Init viewer ────────────────────────────────────────────────────────────
  state.marzViewer = new Marzipano.Viewer($('#pano-viewer'), { controls:{ mouseViewMode:'drag' } });

  // ── Add image + drag/drop ──────────────────────────────────────────────────
  $('#add-image-btn').addEventListener('click', function(){ $('#file-input').click(); });
  $('#file-input').addEventListener('change', function(e){
    var files=Array.from(e.target.files).filter(isImageFile);
    if(files.length) processFiles(files);
    e.target.value='';
  });

  // ── Drag & drop (file import) ──────────────────────────────────────────────
  document.addEventListener('dragover', function(e){
    // Suppress the file-drop overlay when reordering scenes
    if (_dragSrcId) return;
    e.preventDefault(); e.dataTransfer.dropEffect='copy'; $('#drop-overlay').hidden=false;
  });
  document.addEventListener('dragleave', function(e){ if(!e.relatedTarget) $('#drop-overlay').hidden=true; });
  document.addEventListener('drop', function(e){
    // Suppress file import when reordering scenes
    if (_dragSrcId) return;
    e.preventDefault(); $('#drop-overlay').hidden=true;
    var files=Array.from(e.dataTransfer.files).filter(isImageFile);
    if(!files.length){ alert('No supported images found.'); return; }
    processFiles(files);
  });

  // ── Cancel upload ──────────────────────────────────────────────────────────
  $('#processing-cancel').addEventListener('click', function(){
    state.cancelUpload = true;
    $('#processing-modal').hidden = true;
    $('#progress-fill').style.width = '0%';
  });

  // ── Panel toggles ──────────────────────────────────────────────────────────
  function openPanel(id){
    ['plan-panel'].forEach(function(p){ $(('#'+p)).hidden=(p!==id); });
  }
  function closeAllPanels(){ $('#plan-panel').hidden=true; }

  // Settings modal (centered) — toggled as a modal-bg, not a side panel
  $('#appearance-btn').addEventListener('click', function(){ $('#appearance-panel').hidden=false; });
  $('#appearance-close').addEventListener('click', function(){ $('#appearance-panel').hidden=true; });
  // Click backdrop to close
  $('#appearance-panel').addEventListener('click', function(e){ if(e.target===this) this.hidden=true; });

  // Settings tabs
  $$('.settings-tab').forEach(function(tab){
    tab.addEventListener('click', function(){
      $$('.settings-tab').forEach(function(t){ t.classList.remove('active'); });
      $$('.settings-tab-content').forEach(function(c){ c.classList.remove('active'); });
      tab.classList.add('active');
      var target=$('#'+tab.dataset.tab); if(target) target.classList.add('active');
    });
  });

  $('#floor-plan-btn').addEventListener('click', function(){ $('#plan-panel').hidden ? openPanel('plan-panel') : closeAllPanels(); });
  $('#plan-close').addEventListener('click', closeAllPanels);
  // Load presets from server on startup (migrates localStorage presets automatically)
  loadPresetsFromServer(function(){ populatePresetSelect(); });
  syncHotspotColorInputs();
  $('#setting-compass').addEventListener('change', function(){
    var curSd=getActiveScene(); if(curSd) renderProps(curSd);
  });

  // ── Logo ───────────────────────────────────────────────────────────────────
  $('#logo-upload-btn').addEventListener('click', function(){ $('#logo-file-input').click(); });
  $('#logo-file-input').addEventListener('change', function(e){
    var f=e.target.files[0]; if(!f) return;
    readAsDataURL(f, function(data){ state.logoData=data; $('#logo-preview').src=data; $('#logo-preview-wrap').hidden=false; updatePreviewOverlay(); });
    e.target.value='';
  });
  $('#logo-remove-btn').addEventListener('click', function(){ state.logoData=null; $('#logo-preview').src=''; $('#logo-preview-wrap').hidden=true; updatePreviewOverlay(); });

  // Live preview on button text/color changes
  ['setting-btn1-text','setting-btn2-text','setting-btn3-text'].forEach(function(id){
    document.getElementById(id).addEventListener('input', function(){ updatePreviewOverlay(); updateBtnPreviews(); });
  });

  // Button colour pickers
  function wireBtnColors(n) {
    var textEl = document.getElementById('btn'+n+'-text-color');
    var bgEl   = document.getElementById('btn'+n+'-bg-color');
    var prev   = document.getElementById('btn'+n+'-preview');
    function update() {
      state['btn'+n+'TextColor'] = textEl.value;
      state['btn'+n+'BgColor']   = bgEl.value;
      prev.style.color      = textEl.value;
      prev.style.background = bgEl.value;
      updatePreviewOverlay();
    }
    textEl.addEventListener('input', update);
    bgEl.addEventListener('input', update);
    // Set initial preview style
    prev.style.color      = state['btn'+n+'TextColor'];
    prev.style.background = state['btn'+n+'BgColor'];
    // Sync label text with input
    var labelEl = document.getElementById('setting-btn'+n+'-text');
    if(labelEl) {
      labelEl.addEventListener('input', function() {
        prev.textContent = labelEl.value || 'Button '+n;
      });
      prev.textContent = labelEl.value || 'Button '+n;
    }
  }
  wireBtnColors(1); wireBtnColors(2); wireBtnColors(3);
  Object.keys(state.hotspotColors).forEach(function(type){
    $('#hotspot-'+type+'-bg-color').addEventListener('input', function(){
      state.hotspotColors[type].bg=this.value;
      updateHotspotPreview(type);
      refreshSceneRendering();
    });
    $('#hotspot-'+type+'-icon-color').addEventListener('input', function(){
      state.hotspotColors[type].icon=this.value;
      updateHotspotPreview(type);
      refreshSceneRendering();
    });
  });

  function updateHotspotPreview(type){
    var preview=document.querySelector('.'+type+'-preview');
    if(!preview) return;
    var palette=state.hotspotColors[type];
    preview.style.background=palette.bg;
    preview.style.color=palette.icon;
  }
  function updateAllHotspotPreviews(){
    Object.keys(state.hotspotColors).forEach(function(type){ updateHotspotPreview(type); });
  }
  updateAllHotspotPreviews();

  $('#preset-save-btn').addEventListener('click', function(){
    var name=$('#preset-name-input').value.trim();
    if(!name){ alert('Enter a preset name.'); return; }
    var presets=readPresets().filter(function(p){ return p.name!==name; });
    presets.push({ name:name, data:collectPresetData() });
    presets.sort(function(a,b){ return a.name.localeCompare(b.name); });
    writePresets(presets, function(){
      populatePresetSelect(name);
    });
    $('#preset-name-input').value='';
  });
  $('#preset-load-btn').addEventListener('click', function(){
    var name=$('#preset-select').value;
    if(!name){ alert('Choose a preset first.'); return; }
    var preset=readPresets().find(function(p){ return p.name===name; });
    if(preset) applyPresetData(preset.data);
  });
  $('#preset-delete-btn').addEventListener('click', function(){
    var name=$('#preset-select').value;
    if(!name){ alert('Choose a preset first.'); return; }
    if(!confirm('Delete preset "'+name+'"?')) return;
    writePresets(readPresets().filter(function(p){ return p.name!==name; }), function(){
      populatePresetSelect();
    });
  });

  function updateBtnPreviews() {
    [1,2,3].forEach(function(n) {
      var labelEl = document.getElementById('setting-btn'+n+'-text');
      var prev = document.getElementById('btn'+n+'-preview');
      if(prev && labelEl) prev.textContent = labelEl.value || 'Button '+n;
    });
  }

  // ── Plan ───────────────────────────────────────────────────────────────────
  $('#plan-upload-btn').addEventListener('click', function(){ $('#plan-file-input').click(); });
  $('#plan-file-input').addEventListener('change', function(e){
    var f=e.target.files[0]; if(!f) return;
    readAsDataURL(f, function(data){ state.planData=data; $('#plan-preview').src=data; $('#plan-preview-wrap').hidden=false; $('#plan-controls').style.display=''; updatePreviewOverlay(); });
    e.target.value='';
  });
  $('#plan-remove-btn').addEventListener('click', function(){ state.planData=null; $('#plan-preview').src=''; $('#plan-preview-wrap').hidden=true; $('#plan-controls').style.display='none'; updatePreviewOverlay(); });
  $('#plan-size-slider').addEventListener('input', function(){ state.planSize=parseInt(this.value,10); applyPlanSize(); updatePreviewPlanDots(); });
  function applyPlanSize(){ var w=state.planSize||200, h=Math.round(w*0.75), wrap=$('#preview-plan-wrap'); if(wrap){ wrap.style.width=w+'px'; wrap.style.height=h+'px'; } }

  // ── Dot controls ───────────────────────────────────────────────────────────
  $('#dot-size-slider').addEventListener('input', function(){ state.dotSize=parseInt(this.value,10); updatePreviewPlanDots(); drawDotPreviews(); });
  $('#dot-active-color').addEventListener('input', function(){ state.dotActiveColor=this.value; updatePreviewPlanDots(); drawDotPreviews(); });
  $('#dot-inactive-color').addEventListener('input', function(){ state.dotInactiveColor=this.value; updatePreviewPlanDots(); drawDotPreviews(); });
  function drawDotPreviews(){ drawDot($('#dot-preview-active'),state.dotActiveColor,state.dotSize); drawDot($('#dot-preview-inactive'),state.dotInactiveColor,state.dotSize); }
  function drawDot(canvas,color,r){ if(!canvas)return; var s=Math.max(28,(r+4)*4); canvas.width=s; canvas.height=s; var ctx=canvas.getContext('2d'); ctx.clearRect(0,0,s,s); ctx.beginPath(); ctx.arc(s/2,s/2,r,0,Math.PI*2); ctx.fillStyle=color; ctx.fill(); ctx.strokeStyle='#000'; ctx.lineWidth=1.5; ctx.stroke(); }
  drawDotPreviews();
  $$('.dot-type-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      state.dotType = btn.dataset.type || 'circle';
      $$('.dot-type-btn').forEach(function(other){ other.classList.toggle('active', other===btn); });
      $('#dot-rotation-row').style.display = state.dotType==='arrow' ? '' : 'none';
      updatePreviewPlanDots();
      var curSd=getActiveScene(); if(curSd) renderProps(curSd);
    });
  });
  $('#dot-rotation-slider').addEventListener('input', function(){
    state.dotRotationDefault=parseInt(this.value,10)||0;
    $('#dot-rotation-val').textContent=state.dotRotationDefault+'°';
  });

  // ── Toolbar ────────────────────────────────────────────────────────────────
  $('#btn-hotspot-info').addEventListener('click', function(){ startHotspotPlacement('info'); });
  $('#btn-hotspot-link').addEventListener('click', function(){ startHotspotPlacement('link'); });
  $('#btn-set-view').addEventListener('click', setInitialView);
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') cancelPlacement(); });
  setInterval(updateEditorCompass, 80);

  // ── Info text popup ────────────────────────────────────────────────────────
  $('#inline-text-ok').addEventListener('click', confirmInfoHotspot);
  $('#inline-text-input').addEventListener('keydown', function(e){ if(e.key==='Enter') confirmInfoHotspot(); if(e.key==='Escape') cancelInfoHotspot(); });
  $('#inline-text-cancel').addEventListener('click', cancelInfoHotspot);

  // ── Icon picker ────────────────────────────────────────────────────────────
  $$('.icon-opt').forEach(function(btn){
    btn.addEventListener('click', function(){ $$('.icon-opt').forEach(function(b){ b.classList.remove('selected'); }); btn.classList.add('selected'); state.pendingLinkIcon=btn.dataset.icon; });
  });
  var defIcon=document.querySelector('.icon-opt[data-icon="camera"]'); if(defIcon) defIcon.classList.add('selected');
  $('#hotspot-modal-cancel').addEventListener('click', function(){ $('#hotspot-modal').hidden=true; state.placingHotspot=null; state.pendingCoords=null; });

  // ── Project dropdown ───────────────────────────────────────────────────────
  $('#project-menu-btn').addEventListener('click', function(e){
    e.stopPropagation();
    var menu=$('#project-menu');
    menu.hidden=!menu.hidden;
  });
  document.addEventListener('click', function(){ var m=$('#project-menu'); if(m) m.hidden=true; });
  $('#project-menu').addEventListener('click', function(e){ e.stopPropagation(); });

  // New project
  $('#new-project-btn').addEventListener('click', function(){
    $('#project-menu').hidden=true;
    if(state.scenes.length && !confirm('Start a new project? Unsaved changes will be lost.')) return;
    state.scenes.forEach(function(s){ var ms=state.marzScenes[s.id]; if(ms){ try{ state.marzViewer.destroyScene(ms); }catch(e){} } });
    state.scenes=[]; state.marzScenes={}; state.activeSceneId=null; state.firstSceneId=null; state.logoData=null; state.planData=null;
    $$('.scene-item').forEach(function(el){ el.remove(); }); $('#drop-hint').style.display='';
    $('#viewer-empty').hidden=false; $('#viewer-toolbar').hidden=true;
    $('#props-inner').innerHTML='<div class="props-empty">Select a scene to edit</div>';
    $('#project-title').value='My Panorama Tour';
    updatePreviewOverlay();
  });

  // Open saved project
  $('#load-btn').addEventListener('click', function(){ $('#project-menu').hidden=true; openLoadModal(); });

  // Import ZIP — directly open the file picker, no modal needed
  $('#import-zip-btn').addEventListener('click', function(){
    $('#project-menu').hidden=true;
    $('#import-zip-input').value='';
    $('#import-zip-input').click();
  });

  // Save project
  $('#save-btn').addEventListener('click', function(){
    $('#project-menu').hidden=true;
    $('#save-name-input').value=$('#project-title').value||'';
    $('#save-modal').hidden=false;
    setTimeout(function(){ $('#save-name-input').select(); },50);
  });

  // Preview tour (renamed from Test Viewer)
  $('#preview-tour-btn').addEventListener('click', function(){ $('#project-menu').hidden=true; openTestPreview(); });

  // ── Export / Import ────────────────────────────────────────────────────────
  $('#export-btn').addEventListener('click', doExport);
  $('#export-modal-ok').addEventListener('click', function(){ $('#export-modal').hidden=true; });

  // Load modal cancel
  $('#load-modal-cancel').addEventListener('click', function(){ $('#load-modal').hidden=true; });

  // Save modal confirm and cancel
  $('#save-modal-cancel').addEventListener('click', function(){ $('#save-modal').hidden=true; });
  $('#save-confirm-btn').addEventListener('click', doSaveProject);
  $('#save-name-input').addEventListener('keydown', function(e){ if(e.key==='Enter') doSaveProject(); if(e.key==='Escape') $('#save-modal').hidden=true; });

  // ZIP import
  $('#import-zip-input').addEventListener('change', function(e){
    var f=e.target.files[0]; if(!f) return;
    $('#load-modal').hidden=true;
    var modal=$('#processing-modal'), fill=$('#progress-fill'), label=$('#processing-label');
    modal.hidden=false; label.textContent='Importing project ZIP…'; fill.style.width='20%';
    var iv=setInterval(function(){ var c=parseFloat(fill.style.width)||20; if(c<85) fill.style.width=(c+Math.random()*4)+'%'; },400);
    var fd=new FormData(); fd.append('projectZip',f);
    fetch('/api/import-project',{method:'POST',body:fd})
      .then(function(r){ return r.json(); })
      .then(function(result){
        clearInterval(iv); fill.style.width='100%';
        setTimeout(function(){
          modal.hidden=true; fill.style.width='0%';
          if(result.error) throw new Error(result.error);
          loadProject(result.project);
        },200);
      })
      .catch(function(err){ clearInterval(iv); modal.hidden=true; fill.style.width='0%'; alert('Import failed: '+err.message); });
    e.target.value='';
  });

  function isImageFile(f){ if(f.type&&f.type.startsWith('image/')) return true; return /\.(jpe?g|png|tiff?|webp|gif|heic|heif)$/i.test(f.name); }

  // ── Process files ──────────────────────────────────────────────────────────
  function processFiles(files){
    state.cancelUpload = false;
    var queue=Array.from(files), idx=0;
    function next(){
      if(state.cancelUpload){ state.cancelUpload=false; return; }
      if(idx>=queue.length){ $('#processing-modal').hidden=true; return; }
      uploadAndProcess(queue[idx++], next);
    }
    next();
  }

  function uploadAndProcess(file, cb){
    var modal=$('#processing-modal'), label=$('#processing-label'), fill=$('#progress-fill');
    modal.hidden=false; label.textContent='Processing: '+file.name; fill.style.width='10%';
    var iv=setInterval(function(){ var c=parseFloat(fill.style.width)||10; if(c<85) fill.style.width=(c+Math.random()*4)+'%'; },400);
    var fd=new FormData(); fd.append('panorama',file);
    fetch('/api/process',{method:'POST',body:fd})
      .then(function(r){ return r.json(); })
      .then(function(result){
        clearInterval(iv);
        if(result.error) throw new Error(result.error);
        fill.style.width='100%';
        setTimeout(function(){
          if(state.cancelUpload){ modal.hidden=true; fill.style.width='0%'; return; }
          var scene=buildSceneFromProcessResult(file, result);
          state.scenes.push(scene);
          if(!state.firstSceneId) state.firstSceneId=scene.id;
          addSceneToSidebar(scene);
          try {
            activateScene(scene.id);
          } catch(e) {
            console.error('activateScene failed for scene '+scene.id+':', e);
          }
          modal.hidden=true; fill.style.width='0%';
          updatePreviewOverlay(); cb&&cb();
        },200);
      })
      .catch(function(err){ clearInterval(iv); modal.hidden=true; fill.style.width='0%'; if(!state.cancelUpload) alert('Error processing "'+file.name+'":\n'+err.message); cb&&cb(); });
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────
  var _dragSrcId = null;

  function addSceneToSidebar(scene){
    $('#drop-hint').style.display='none';
    var item=el('div','scene-item'); item.dataset.id=scene.id;

    // Drag handle
    var handle=el('div','scene-drag-handle','⠿'); handle.title='Drag to reorder';

    var thumb=document.createElement('img'); thumb.className='scene-thumb'; thumb.src=scene.previewUrl; thumb.alt='';
    var nameWrap=el('div','scene-name-wrap');
    var nameSpan=el('span','scene-name',scene.name); nameSpan.title='Double-click to rename';
    attachRename(nameSpan,scene); nameWrap.appendChild(nameSpan);
    var del=el('button','scene-del','✕'); del.title='Remove';
    del.addEventListener('click',function(e){ e.stopPropagation(); removeScene(scene.id); });
    item.appendChild(handle); item.appendChild(thumb); item.appendChild(nameWrap); item.appendChild(del);
    item.addEventListener('click',function(){ activateScene(scene.id); });

    // ── Drag-and-drop reordering ──────────────────────────────────
    item.draggable = true;
    item.addEventListener('dragstart', function(e){
      _dragSrcId = scene.id;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(function(){ item.classList.add('dragging'); }, 0);
    });
    item.addEventListener('dragend', function(){
      item.classList.remove('dragging');
      $$('.scene-item').forEach(function(el){ el.classList.remove('drag-over'); });
      _dragSrcId = null;
    });
    item.addEventListener('dragover', function(e){
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (_dragSrcId && _dragSrcId !== scene.id) item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', function(){
      item.classList.remove('drag-over');
    });
    item.addEventListener('drop', function(e){
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!_dragSrcId || _dragSrcId === scene.id) return;

      // Reorder state.scenes array
      var fromIdx = state.scenes.findIndex(function(s){ return s.id === _dragSrcId; });
      var toIdx   = state.scenes.findIndex(function(s){ return s.id === scene.id; });
      if (fromIdx === -1 || toIdx === -1) return;
      var moved = state.scenes.splice(fromIdx, 1)[0];
      state.scenes.splice(toIdx, 0, moved);

      // Reorder DOM to match
      var list = $('#scene-list');
      var items = Array.from($$('.scene-item'));
      var fromEl = items.find(function(el){ return el.dataset.id === _dragSrcId; });
      var toEl   = items.find(function(el){ return el.dataset.id === scene.id; });
      if (fromEl && toEl) {
        if (fromIdx < toIdx) list.insertBefore(fromEl, toEl.nextSibling);
        else                 list.insertBefore(fromEl, toEl);
      }
      updateFirstSceneBadges();
    });

    $('#scene-list').appendChild(item);
    updateFirstSceneBadges();
  }

  function attachRename(span,scene){
    span.addEventListener('dblclick',function(e){
      e.stopPropagation();
      var input=document.createElement('input');
      input.style.cssText='background:rgba(255,255,255,0.1);border:1px solid #e94560;color:#fff;border-radius:4px;padding:1px 5px;font-size:12px;width:100%;outline:none;';
      input.value=scene.name; span.replaceWith(input); input.focus(); input.select();
      function commit(){
        var n=input.value.trim()||scene.name;
        scene.name=n;
        span.textContent=n;
        input.replaceWith(span);
        // Sync props panel name input
        var pi=$('#props-name-input'); if(pi&&state.activeSceneId===scene.id) pi.value=n;
        // Update targetName on any link hotspot in other scenes pointing here
        state.scenes.forEach(function(s){
          s.hotspots.forEach(function(hs){
            if(hs.type==='link' && hs.targetId===scene.id){
              hs.targetName=n;
            }
          });
          // Refresh the hotspot list in props if this scene is active
          if(s.id===state.activeSceneId) refreshHotspotList(s);
        });
      }
      input.addEventListener('blur',commit);
      input.addEventListener('keydown',function(k){ if(k.key==='Enter') input.blur(); if(k.key==='Escape'){input.value=scene.name;input.blur();} });
    });
  }

  function updateFirstSceneBadges(){
    $$('.scene-first-badge').forEach(function(b){ b.remove(); });
    if(!state.firstSceneId) return;
    var item=$('#scene-list [data-id="'+state.firstSceneId+'"]');
    if(item){ var b=el('span','scene-first-badge','★'); b.title='First scene'; item.querySelector('.scene-name-wrap').appendChild(b); }
  }

  function removeScene(id){
    if(!confirm('Remove this scene?')) return;
    fetch('/api/scene/'+id,{method:'DELETE'});
    state.scenes=state.scenes.filter(function(s){ return s.id!==id; });
    var ms=state.marzScenes[id]; if(ms){ try{ state.marzViewer.destroyScene(ms); }catch(e){} }
    delete state.marzScenes[id];
    var item=$('#scene-list [data-id="'+id+'"]'); if(item) item.remove();
    if(state.firstSceneId===id){ state.firstSceneId=state.scenes.length?state.scenes[0].id:null; updateFirstSceneBadges(); }
    if(state.activeSceneId===id){
      state.activeSceneId=null; $('#viewer-empty').hidden=false; $('#viewer-toolbar').hidden=true;
      $('#props-inner').innerHTML='<div class="props-empty">Select a scene to edit</div>';
      if(state.scenes.length) activateScene(state.scenes[0].id);
    }
    if(!state.scenes.length) $('#drop-hint').style.display='';
    updatePreviewOverlay();
  }

  // ── Activate scene ─────────────────────────────────────────────────────────
  function activateScene(id, overrideView){
    var sd=getSceneById(id);
    if(!sd) return;
    $$('.scene-item').forEach(function(el){ el.classList.toggle('active',el.dataset.id===id); });
    state.activeSceneId=id; $('#viewer-empty').hidden=true; $('#viewer-toolbar').hidden=false;
    var viewToUse=overrideView||sd.initialView;
    if(!state.marzScenes[id]){
      try {
        state.marzScenes[id]=createMarzipanoScene(sd, viewToUse);
      } catch(e) {
        console.error('[activateScene] createMarzipanoScene THREW:', e.message, e.stack);
        return;
      }
      sd.hotspots.forEach(function(hs){ attachHotspotToScene(state.marzScenes[id],hs,sd); });
    } else {
      applyViewToScene(sd, state.marzScenes[id], viewToUse);
    }
    state.marzScenes[id].switchTo({transitionDuration:600});
    updateEditorCompass();
    renderProps(sd); updatePreviewPlanDots();
  }

  function updateEditorCompass(){
    var wrap=$('#editor-compass'), needle=$('#editor-compass-needle'), northArrow=$('#editor-north-arrow');
    var sd=getActiveScene(), ms=state.marzScenes[state.activeSceneId];
    if(!wrap || !needle || !northArrow || !sd || !ms || !$('#setting-compass').checked || sd.compassEnabled===false){
      if(wrap) wrap.hidden=true;
      return;
    }
    wrap.hidden=false;
    var deg;
    if(isFlatScene(sd)){
      wrap.classList.add('flat-mode');
      northArrow.hidden=false;
      deg=-(sd.northOffset||0);
    } else {
      wrap.classList.remove('flat-mode');
      northArrow.hidden=true;
      var yaw=ms.view().yaw();
      var northOffset=(sd.northOffset||0)*Math.PI/180;
      deg=-((yaw-northOffset)*180/Math.PI);
    }
    needle.setAttribute('transform','rotate('+deg+',30,30)');
  }

  // ── Props panel ────────────────────────────────────────────────────────────
  function renderProps(sd){
    var pi=$('#props-inner'); pi.innerHTML='';
    var ng=el('div','prop-group'); ng.appendChild(el('div','prop-label','Scene Name'));
    var ni=document.createElement('input'); ni.id='props-name-input'; ni.className='prop-input'; ni.type='text'; ni.value=sd.name;
    ni.addEventListener('input',function(){
      sd.name=ni.value;
      var sp=$('#scene-list [data-id="'+sd.id+'"] .scene-name'); if(sp) sp.textContent=sd.name;
      // Update targetName on link hotspots in other scenes pointing here
      state.scenes.forEach(function(s){
        s.hotspots.forEach(function(hs){ if(hs.type==='link'&&hs.targetId===sd.id) hs.targetName=sd.name; });
        if(s.id===state.activeSceneId) refreshHotspotList(s);
      });
    });
    ng.appendChild(ni); pi.appendChild(ng);

    pi.appendChild(el('hr','prop-divider')); pi.appendChild(el('div','prop-section','Initial View'));
    var vi=el('div','initial-view-info');
    function updateVI(){ vi.innerHTML=sd.initialViewSet?'<span class="view-set-badge">✓ View set</span>':'<span style="color:#888;font-size:12px">Pan to angle then click Set View</span>'; }
    updateVI(); sd._updateViewInfo=updateVI; pi.appendChild(vi);

    pi.appendChild(el('hr','prop-divider')); pi.appendChild(el('div','prop-section','Starting Scene'));
    var fr=el('div','prop-group'); fr.style.cssText='flex-direction:row;align-items:center;gap:8px;';
    var isFirst=state.firstSceneId===sd.id;
    var fb=el('span',isFirst?'view-set-badge':'',isFirst?'★ First scene':'Not first scene'); fb.style.fontSize='12px';
    var sfb=el('button','btn btn-sm','Set as First'); sfb.style.display=isFirst?'none':'';
    sfb.addEventListener('click',function(){ state.firstSceneId=sd.id; updateFirstSceneBadges(); fb.className='view-set-badge'; fb.textContent='★ First scene'; sfb.style.display='none'; });
    fr.appendChild(fb); fr.appendChild(sfb); pi.appendChild(fr);

    if($('#setting-compass').checked){
      pi.appendChild(el('hr','prop-divider')); pi.appendChild(el('div','prop-section','Compass'));
      var cg=el('div','prop-group');
      var compassToggle=document.createElement('label');
      compassToggle.className='panel-label';
      compassToggle.innerHTML='<input type="checkbox" '+(sd.compassEnabled!==false?'checked':'')+'> Show compass on this view';
      var compassInput=compassToggle.querySelector('input');
      cg.appendChild(compassToggle);
      var northWrap=el('div','');
      northWrap.style.cssText='display:'+(sd.compassEnabled!==false?'block':'none')+';';
      var northLabel=el('div','prop-label','North Offset');
      northWrap.appendChild(northLabel);
      var northRow=el('div','');
      northRow.style.cssText='display:flex;align-items:center;gap:8px;';
      var northSlider=document.createElement('input');
      northSlider.type='range'; northSlider.min='0'; northSlider.max='359'; northSlider.step='1';
      northSlider.value=String((((sd.northOffset||0)%360)+360)%360);
      northSlider.className='panel-slider'; northSlider.style.flex='1';
      var northVal=el('span','',String((((sd.northOffset||0)%360)+360)%360)+'°');
      northVal.style.cssText='color:#aaa;font-size:12px;min-width:38px;';
      var northBtn=el('button','btn btn-sm','Use Current Heading');
      northBtn.style.marginTop='6px';
      compassInput.addEventListener('change', function(){
        sd.compassEnabled=compassInput.checked;
        northWrap.style.display=sd.compassEnabled?'block':'none';
        updateEditorCompass();
      });
      northSlider.addEventListener('input', function(){
        sd.northOffset=parseInt(northSlider.value,10)||0;
        northVal.textContent=sd.northOffset+'°';
        updateEditorCompass();
      });
      northBtn.addEventListener('click', function(){
        var ms=state.marzScenes[sd.id]; if(!ms) return;
        var view=ms.view();
        sd.northOffset=Math.round(((view.yaw()*180/Math.PI)%360+360)%360);
        northSlider.value=String(sd.northOffset);
        northVal.textContent=sd.northOffset+'°';
        updateEditorCompass();
      });
      northRow.appendChild(northSlider); northRow.appendChild(northVal);
      northWrap.appendChild(northRow);
      if(!isFlatScene(sd)) northWrap.appendChild(northBtn);
      cg.appendChild(northWrap);
      pi.appendChild(cg);
    }

    if(state.planData){
      pi.appendChild(el('hr','prop-divider')); pi.appendChild(el('div','prop-section','Floor Plan Dot'));
      var dotBtn=el('button','plan-dot-btn');
      var dotInd=el('span','plan-dot-indicator '+(sd.planDot?'plan-dot-set':'plan-dot-unset'));
      var dotTxt=el('span','',sd.planDot?'Dot placed — click to move':'Click to place dot on plan');
      dotBtn.appendChild(dotInd); dotBtn.appendChild(dotTxt);
      dotBtn.addEventListener('click',function(){ startPlanDotPlacement(sd,dotInd,dotTxt); });
      pi.appendChild(dotBtn);
      if(sd.planDot){
        if(sd.planDot.rotation == null) sd.planDot.rotation = 0;
        var clearBtn=el('button','btn btn-sm','Remove Dot'); clearBtn.style.marginTop='4px';
        clearBtn.addEventListener('click',function(){ sd.planDot=null; dotInd.className='plan-dot-indicator plan-dot-unset'; dotTxt.textContent='Click to place dot on plan'; clearBtn.remove(); updatePreviewPlanDots(); });
        pi.appendChild(clearBtn);
        if(state.dotType==='arrow'){
          var rotGroup=el('div','prop-group');
          rotGroup.appendChild(el('div','prop-label','Direction'));
          var rotWrap=el('div','');
          rotWrap.style.cssText='display:flex;align-items:center;gap:8px;';
          var rotSlider=document.createElement('input');
          rotSlider.type='range'; rotSlider.min='0'; rotSlider.max='359'; rotSlider.step='1';
          rotSlider.value=String(sd.planDot.rotation||0);
          rotSlider.className='panel-slider';
          rotSlider.style.flex='1';
          var rotVal=el('span','',String(sd.planDot.rotation||0)+'°');
          rotVal.style.cssText='color:#aaa;font-size:12px;min-width:38px;';
          rotSlider.addEventListener('input',function(){
            sd.planDot.rotation=parseInt(rotSlider.value,10)||0;
            rotVal.textContent=sd.planDot.rotation+'°';
            updatePreviewPlanDots();
          });
          rotWrap.appendChild(rotSlider); rotWrap.appendChild(rotVal);
          rotGroup.appendChild(rotWrap);
          pi.appendChild(rotGroup);
        }
      }
    }

    pi.appendChild(el('hr','prop-divider')); pi.appendChild(el('div','prop-section','Hotspots'));
    var hsl=el('div','hotspot-list'); hsl.id='hs-list-'+sd.id; renderHotspotList(sd,hsl); pi.appendChild(hsl);
    var br=el('div','prop-group'); br.style.cssText='flex-direction:row;gap:8px;';
    var bi=el('button','btn','Info'); bi.style.flex='1'; bi.addEventListener('click',function(){ startHotspotPlacement('info'); });
    var bl=el('button','btn','Link'); bl.style.flex='1'; bl.addEventListener('click',function(){ startHotspotPlacement('link'); });
    br.appendChild(bi); br.appendChild(bl); pi.appendChild(br);

    // ── Projection section ─────────────────────────────────────────
    pi.appendChild(el('hr','prop-divider'));
    pi.appendChild(el('div','prop-section','Projection'));

    var hasSource = !!sd.sourceUrl;
    if (!hasSource) {
      var noSrcNote = el('p','');
      noSrcNote.style.cssText='font-size:12px;color:#666;line-height:1.5;';
      noSrcNote.textContent='No source image stored. Re-import this image to enable projection switching.';
      pi.appendChild(noSrcNote);
    } else {
      // Current projection label
      var curProjLabel = sd.projection === 'flat' ? 'Flat' : (sd.fisheyeFov ? 'Fisheye (' + sd.fisheyeFov + '°)' : 'Panorama');
      var curNote = el('p','');
      curNote.style.cssText='font-size:12px;color:#888;margin-bottom:8px;';
      curNote.textContent='Current: ' + curProjLabel + '. Switch to:';
      pi.appendChild(curNote);

      // 3-button row
      var projRow = el('div','');
      projRow.style.cssText='display:flex;gap:6px;';

      function makeProjBtn(label, targetProj) {
        var isCurrent = (targetProj === 'flat'    && sd.projection === 'flat') ||
                        (targetProj === 'cube'    && sd.projection === 'cube' && !sd.fisheyeFov) ||
                        (targetProj === 'fisheye' && sd.projection === 'cube' && !!sd.fisheyeFov);
        var btn = el('button', isCurrent ? 'btn btn-sm btn-primary' : 'btn btn-sm', label);
        btn.style.flex = '1';
        btn.disabled = isCurrent;
        if (!isCurrent) {
          btn.addEventListener('click', function(){
            if (targetProj === 'fisheye') {
              // Show FOV picker modal before confirming
              showFovModal(sd);
            } else {
              confirmReproject(sd, targetProj, null);
            }
          });
        }
        return btn;
      }

      projRow.appendChild(makeProjBtn('Flat', 'flat'));
      projRow.appendChild(makeProjBtn('Panorama', 'cube'));
      projRow.appendChild(makeProjBtn('Fisheye', 'fisheye'));
      pi.appendChild(projRow);
    }
  }

  function renderHotspotList(sd,container){
    container.innerHTML='';
    if(!sd.hotspots.length){ container.innerHTML='<div style="color:#555;font-size:12px;padding:4px">No hotspots yet</div>'; return; }
    sd.hotspots.forEach(function(hs){
      var item=el('div','hotspot-item');
      var iconSm=el('span','hs-icon-sm');
      if(hs.type==='info'){
        iconSm.textContent='i';
      } else {
        iconSm.innerHTML=LINK_ICONS[hs.icon||'camera']||LINK_ICONS.camera;
      }
      item.appendChild(iconSm);
      var txt=hs.type==='info'?(hs.text||'Info'):('→ '+(hs.targetName||'Scene'));
      item.appendChild(el('span','hs-text',txt));
      var d=el('button','hs-del','✕'); d.title='Delete';
      d.addEventListener('click',function(){ removeHotspot(sd,hs.id); }); item.appendChild(d); container.appendChild(item);
    });
  }
  function refreshHotspotList(sd){ var c=document.getElementById('hs-list-'+sd.id); if(c) renderHotspotList(sd,c); }

  // ── Plan dot placement ─────────────────────────────────────────────────────
  function startPlanDotPlacement(sd,dotInd,dotTxt){
    if(!state.planData) return;
    state.placingPlanDot=true;
    var overlay=$('#plan-dot-overlay'); overlay.hidden=false;
    function onOverlayClick(e){
      overlay.removeEventListener('click',onOverlayClick); overlay.hidden=true; state.placingPlanDot=false;
      var img=$('#preview-plan-img'); if(!img) return;
      var rect=img.getBoundingClientRect();
      var cx=Math.max(rect.left,Math.min(rect.right,e.clientX)), cy=Math.max(rect.top,Math.min(rect.bottom,e.clientY));
      sd.planDot={
        x:(cx-rect.left)/rect.width,
        y:(cy-rect.top)/rect.height,
        rotation: sd.planDot && sd.planDot.rotation != null ? sd.planDot.rotation : state.dotRotationDefault
      };
      dotInd.className='plan-dot-indicator plan-dot-set'; dotTxt.textContent='Dot placed — click to move';
      updatePreviewPlanDots();
      var curSd=getActiveScene(); if(curSd) renderProps(curSd);
    }
    overlay.addEventListener('click',onOverlayClick);
  }

  // ── Hotspot placement ──────────────────────────────────────────────────────
  function startHotspotPlacement(type){
    if(!state.activeSceneId) return;
    if(type==='link'&&state.scenes.length<2){ alert('Need at least 2 scenes for a link hotspot.'); return; }
    enablePlacementClick(type);
  }
  function enablePlacementClick(type){
    state.placingHotspot=type;
    var overlay=$('#place-overlay'); overlay.hidden=false;
    $('#place-msg').textContent='Click in the panorama to place '+(type==='info'?'info':'link')+' hotspot — Esc to cancel';
    function onViewerClick(e){
      if(!(e.target===overlay||overlay.contains(e.target))) return;
      overlay.removeEventListener('click',onViewerClick); overlay.hidden=true;
      var sd=state.scenes.find(function(s){ return s.id===state.activeSceneId; });
      var ms=state.marzScenes[state.activeSceneId]; if(!sd||!ms){ state.placingHotspot=null; return; }
      var rect=$('#pano-viewer').getBoundingClientRect();
      var coords=ms.view().screenToCoordinates({x:e.clientX-rect.left,y:e.clientY-rect.top});
      state.pendingCoords=coords;
      if(type==='info'){
        showInlineTextPopup(e.clientX,e.clientY);
      } else {
        $$('.icon-opt').forEach(function(b){ b.classList.remove('selected'); });
        var def=document.querySelector('.icon-opt[data-icon="'+(state.pendingLinkIcon||'camera')+'"]'); if(def) def.classList.add('selected');
        var other=state.scenes.filter(function(s){ return s.id!==state.activeSceneId; });
        var list=$('#hotspot-target-list'); list.innerHTML='';
        other.forEach(function(s){
          var btn=document.createElement('button'); btn.textContent=s.name;
          btn.addEventListener('click',function(){
            state.pendingLinkTarget={id:s.id,name:s.name}; $('#hotspot-modal').hidden=true;
            var icon=state.pendingLinkIcon||'camera';
            var hs=isFlatScene(sd)
              ? {id:genId(),type:'link',x:state.pendingCoords.x,y:state.pendingCoords.y,targetId:state.pendingLinkTarget.id,targetName:state.pendingLinkTarget.name,icon:icon}
              : {id:genId(),type:'link',yaw:state.pendingCoords.yaw,pitch:state.pendingCoords.pitch,targetId:state.pendingLinkTarget.id,targetName:state.pendingLinkTarget.name,icon:icon};
            sd.hotspots.push(hs); attachHotspotToScene(ms,hs,sd); refreshHotspotList(sd);
            state.pendingCoords=null; state.pendingLinkTarget=null; state.placingHotspot=null;
          }); list.appendChild(btn);
        });
        $('#hotspot-modal').hidden=false;
      }
    }
    overlay.addEventListener('click',onViewerClick);
  }
  function cancelPlacement(){
    state.placingHotspot=null; state.pendingCoords=null; state.pendingLinkTarget=null; state.placingPlanDot=false;
    $('#place-overlay').hidden=true; $('#inline-text-popup').hidden=true; $('#hotspot-modal').hidden=true; $('#plan-dot-overlay').hidden=true;
  }
  function showInlineTextPopup(cx,cy){
    var popup=$('#inline-text-popup'), input=$('#inline-text-input'); input.value=''; popup.hidden=false;
    var left=Math.min(cx+14,window.innerWidth-300), top=Math.min(cy+14,window.innerHeight-60);
    popup.style.left=left+'px'; popup.style.top=top+'px'; setTimeout(function(){ input.focus(); },50);
  }
  function confirmInfoHotspot(){
    var text=$('#inline-text-input').value.trim(); if(!text){ $('#inline-text-input').focus(); return; }
    $('#inline-text-popup').hidden=true;
    var sd=getActiveScene(), ms=state.marzScenes[state.activeSceneId];
    if(!sd||!ms||!state.pendingCoords){ state.placingHotspot=null; return; }
    var hs=isFlatScene(sd)
      ? {id:genId(),type:'info',x:state.pendingCoords.x,y:state.pendingCoords.y,text:text}
      : {id:genId(),type:'info',yaw:state.pendingCoords.yaw,pitch:state.pendingCoords.pitch,text:text};
    sd.hotspots.push(hs); attachHotspotToScene(ms,hs,sd); refreshHotspotList(sd);
    state.pendingCoords=null; state.placingHotspot=null;
  }
  function cancelInfoHotspot(){ $('#inline-text-popup').hidden=true; state.pendingCoords=null; state.placingHotspot=null; }

  function attachHotspotToScene(ms,hs,sd){
    var wrap=el('div','hs-marker-wrap');
    var icon=hs.icon||'camera';
    var marker=el('div','hs-marker '+(hs.type==='info'?'info':'link link-'+icon));
    if(hs.type==='info'){
      marker.textContent='i'; var lbl=el('div','hs-marker-label',hs.text);
      applyHotspotTheme(marker, 'info');
      wrap.style.cursor='pointer'; var exp=false;
      wrap.addEventListener('click',function(e){ e.stopPropagation(); exp=!exp; lbl.classList.toggle('hs-marker-label-expanded',exp); });
      wrap.appendChild(marker); wrap.appendChild(lbl);
    } else {
      marker.innerHTML=LINK_ICONS[icon]||LINK_ICONS.camera;
      applyHotspotTheme(marker, icon);
      marker.addEventListener('click',function(e){ e.stopPropagation(); activateScene(hs.targetId); }); wrap.appendChild(marker);
    }
    var pos = isFlatScene(sd)
      ? {x:hs.x!=null?hs.x:0.5, y:hs.y!=null?hs.y:0.5}
      : {yaw:hs.yaw, pitch:hs.pitch};
    ms.hotspotContainer().createHotspot(wrap, pos);
  }
  function removeHotspot(sd,hsId){ sd.hotspots=sd.hotspots.filter(function(h){ return h.id!==hsId; }); rebuildSceneHotspots(sd); refreshHotspotList(sd); }
  function rebuildSceneHotspots(sd){
    var ms=state.marzScenes[sd.id]; if(!ms) return;
    var cv=null;
    try{
      var v=ms.view();
      cv=isFlatScene(sd)
        ? {
            x: typeof v.x==='function' ? v.x() : 0.5,
            y: typeof v.y==='function' ? v.y() : 0.5,
            zoom: typeof v.zoom==='function' ? v.zoom() : 1
          }
        : {yaw:v.yaw(),pitch:v.pitch(),fov:v.fov()};
    }catch(e){}
    delete state.marzScenes[sd.id]; try{ state.marzViewer.destroyScene(ms); }catch(e){} activateScene(sd.id,cv);
  }
  function setInitialView(){
    var sd=getActiveScene(), ms=state.marzScenes[state.activeSceneId]; if(!sd||!ms) return;
    var v=ms.view();
    if(sd.projection==='flat'){
      sd.initialView={
        x: typeof v.x==='function' ? v.x() : 0.5,
        y: typeof v.y==='function' ? v.y() : 0.5,
        zoom: typeof v.zoom==='function' ? v.zoom() : 1
      };
    } else {
      sd.initialView={yaw:v.yaw(),pitch:v.pitch(),fov:v.fov()};
    }
    sd.initialViewSet=true;
    if(sd._updateViewInfo) sd._updateViewInfo();
    var btn=$('#btn-set-view'); btn.textContent='✓ Saved'; setTimeout(function(){ btn.textContent='Set Initial View'; },1500);
  }

  // ── Projection switching ───────────────────────────────────────────────────
  var _reprojScene = null;
  var _reprojTarget = null;
  var _reprojFov = null;

  var PROJ_LABELS = { flat: 'Flat', cube: 'Panorama', fisheye: 'Fisheye' };

  // ── Fisheye FOV picker ─────────────────────────────────────────────────────
  var _fovScene = null;

  function showFovModal(sd) {
    _fovScene = sd;
    // Pre-fill with existing FOV if already fisheye, otherwise default 180
    document.getElementById('fov-input').value = sd.fisheyeFov || 180;
    document.getElementById('fov-modal').hidden = false;
    setTimeout(function(){ document.getElementById('fov-input').select(); }, 50);
  }

  document.getElementById('fov-modal-cancel').addEventListener('click', function(){
    document.getElementById('fov-modal').hidden = true;
    _fovScene = null;
  });

  document.getElementById('fov-modal-ok').addEventListener('click', function(){
    var fov = parseInt(document.getElementById('fov-input').value, 10);
    if (!fov || fov < 90 || fov > 280) {
      document.getElementById('fov-input').focus();
      return;
    }
    document.getElementById('fov-modal').hidden = true;
    if (_fovScene) confirmReproject(_fovScene, 'fisheye', fov);
    _fovScene = null;
  });

  document.getElementById('fov-input').addEventListener('keydown', function(e){
    if (e.key === 'Enter') document.getElementById('fov-modal-ok').click();
    if (e.key === 'Escape') document.getElementById('fov-modal-cancel').click();
  });

  function confirmReproject(sd, targetProjection, fisheyeFov) {
    // If nothing will be lost, skip the confirmation and process immediately
    var hasHotspots = sd.hotspots && sd.hotspots.length > 0;
    var hasPlanDot  = !!sd.planDot;
    if (!hasHotspots && !hasPlanDot) {
      reprojectScene(sd, targetProjection, fisheyeFov || 180);
      return;
    }

    _reprojScene  = sd;
    _reprojTarget = targetProjection;
    _reprojFov    = fisheyeFov || 180;

    // Update modal title and description
    var targetLabel = PROJ_LABELS[targetProjection] || targetProjection;
    document.querySelector('#reproject-modal h3').textContent = 'Switch to ' + targetLabel + '?';
    var desc = document.getElementById('reproject-desc');
    var descriptions = {
      flat:    'The image will be re-processed as a flat 2D scene.',
      cube:    'The image will be re-processed as a 360° equirectangular panorama.',
      fisheye: 'The image will be re-processed as a fisheye hemisphere (FOV: ' + _reprojFov + '°).'
    };
    desc.textContent = descriptions[targetProjection] || '';

    // Build loss list
    var losses = [];
    var infoCount = sd.hotspots.filter(function(h){ return h.type==='info'; }).length;
    var linkCount = sd.hotspots.filter(function(h){ return h.type==='link'; }).length;
    if (infoCount) losses.push(infoCount + ' info hotspot' + (infoCount>1?'s':''));
    if (linkCount) losses.push(linkCount + ' link hotspot' + (linkCount>1?'s':''));
    if (hasPlanDot) losses.push('floor plan dot position');

    var list = document.getElementById('reproject-loss-list');
    list.innerHTML = '';
    losses.forEach(function(txt){
      var li = document.createElement('li'); li.textContent = txt; list.appendChild(li);
    });
    document.getElementById('reproject-modal').hidden = false;
  }

  document.getElementById('reproject-cancel').addEventListener('click', function(){
    document.getElementById('reproject-modal').hidden = true;
    _reprojScene = _reprojTarget = _reprojFov = null;
  });

  document.getElementById('reproject-confirm').addEventListener('click', function(){
    document.getElementById('reproject-modal').hidden = true;
    if (_reprojScene) reprojectScene(_reprojScene, _reprojTarget, _reprojFov);
    _reprojScene = _reprojTarget = _reprojFov = null;
  });

  function reprojectScene(sd, targetProjection, fisheyeFov) {
    var modal = document.getElementById('processing-modal');
    var label = document.getElementById('processing-label');
    var fill  = document.getElementById('progress-fill');
    var targetLabel = PROJ_LABELS[targetProjection] || targetProjection;
    modal.hidden = false;
    label.textContent = 'Re-processing as ' + targetLabel + '…';
    fill.style.width = '10%';

    var iv = setInterval(function(){
      var c = parseFloat(fill.style.width) || 10;
      if (c < 75) fill.style.width = (c + Math.random() * 3) + '%';
    }, 400);

    var body = { projection: targetProjection };
    if (targetProjection === 'fisheye') body.fisheyeFov = fisheyeFov || 180;

    fetch('/api/reprocess/' + sd.id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function(r){ return r.json(); })
      .then(function(result){
        clearInterval(iv);
        if (result.error) throw new Error(result.error);
        fill.style.width = '90%';

        setTimeout(function(){
          // Tear down old Marzipano scene
          var oldMs = state.marzScenes[sd.id];
          if (oldMs) { try { state.marzViewer.destroyScene(oldMs); } catch(e){} }
          delete state.marzScenes[sd.id];

          // Update scene data in-place — id stays the same (reprocess reuses it)
          // Use explicit assignment for every field — don't rely on || fallbacks
          // since old values (e.g. undefined levels on a flat scene) could mask errors
          if (result.levels   !== undefined) sd.levels   = result.levels;
          if (result.faceSize !== undefined) sd.faceSize = result.faceSize;
          sd.previewUrl  = (result.previewUrl  || sd.previewUrl) + '?t=' + Date.now();
          sd.sourceUrl   = result.sourceUrl   || sd.sourceUrl;
          sd.isPano      = !!result.isPano;
          sd.projection  = result.projection  || (targetProjection === 'flat' ? 'flat' : 'cube');
          sd.flat        = result.flat        || null;
          sd.fisheyeFov  = targetProjection === 'fisheye' ? (fisheyeFov || 180) : null;
          sd.hotspots    = [];
          sd.planDot     = null;
          sd.initialView = result.suggestedInitialView ||
            (targetProjection === 'flat' ? { x:0.5, y:0.5, zoom:1 } : { yaw:0, pitch:0, fov:1.5707963 });
          sd.initialViewSet = false;

          // Validate cube scene has required fields before activating
          if (sd.projection === 'cube' && (!sd.levels || !sd.levels.length || !sd.faceSize)) {
            modal.hidden = true; fill.style.width = '0%';
            alert('Re-processing returned incomplete data. Please try again.');
            return;
          }

          // Update sidebar thumbnail
          var item = document.querySelector('#scene-list [data-id="' + sd.id + '"]');
          if (item) {
            var thumb = item.querySelector('.scene-thumb');
            if (thumb) thumb.src = sd.previewUrl;
          }

          fill.style.width = '100%';
          modal.hidden = true; fill.style.width = '0%';

          try {
            activateScene(sd.id);
          } catch(e) {
            console.error('activateScene after reproject:', e);
            alert('Scene re-processed but could not be displayed: ' + e.message);
          }
          updatePreviewOverlay();
        }, 200);
      })
      .catch(function(err){
        clearInterval(iv);
        modal.hidden = true; fill.style.width = '0%';
        alert('Re-processing failed: ' + err.message);
      });
  }

  // ── Preview overlay ────────────────────────────────────────────────────────
  function updatePreviewOverlay(){
    var hasScene=state.scenes.length>0; $('#preview-overlay').hidden=!hasScene; if(!hasScene) return;
    var logoEl=$('#preview-logo');
    if(state.logoData){ logoEl.src=state.logoData; logoEl.hidden=false; } else { logoEl.hidden=true; }
    function setBtn(id, inputId, textColor, bgColor){ var el2=$('#'+id), t=document.getElementById(inputId) ? document.getElementById(inputId).value.trim() : ''; if(t){ el2.textContent=t; el2.style.color=textColor; el2.style.background=bgColor; el2.hidden=false; } else { el2.hidden=true; } }
    setBtn('preview-btn1','setting-btn1-text',state.btn1TextColor,state.btn1BgColor);
    setBtn('preview-btn2','setting-btn2-text',state.btn2TextColor,state.btn2BgColor);
    setBtn('preview-btn3','setting-btn3-text',state.btn3TextColor,state.btn3BgColor);
    var pw=$('#preview-plan-wrap'), pi=$('#preview-plan-img');
    if(state.planData){ pi.src=state.planData; pw.hidden=false; applyPlanSize(); updatePreviewPlanDots(); } else { pw.hidden=true; }
    updateEditorCompass();
  }
  function updatePreviewPlanDots(){
    var canvas=$('#preview-plan-canvas'); if(!canvas) return;
    var wrap=$('#preview-plan-wrap'); if(!wrap||wrap.hidden) return;
    canvas.width=wrap.offsetWidth||200; canvas.height=wrap.offsetHeight||150;
    var ctx=canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height);
    var r=state.dotSize||4;
    state.scenes.forEach(function(sd){
      if(!sd.planDot) return;
      var x=sd.planDot.x*canvas.width, y=sd.planDot.y*canvas.height;
      var isActive=sd.id===state.activeSceneId;
      drawPlanSymbol(ctx,x,y,r,isActive?state.dotActiveColor:state.dotInactiveColor,state.dotType,sd.planDot.rotation||0,isActive);
    });
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  function doExport(){
    if(!state.scenes.length){ alert('Add at least one panorama first.'); return; }
    var ordered=state.scenes.slice();
    if(state.firstSceneId) ordered.sort(function(a,b){ return a.id===state.firstSceneId?-1:b.id===state.firstSceneId?1:0; });
    var s = {
      title:$('#project-title').value||'Panorama Tour',
      autorotate:$('#setting-autorotate').checked, fullscreen:$('#setting-fullscreen').checked, mouseMode:$('#setting-mousemode').value,
      logoData:state.logoData||null, logoUrl:$('#setting-logo-url').value||'', logoNewTab:$('#setting-logo-newtab').checked,
      btn1Text:$('#setting-btn1-text').value||'', btn1Url:$('#setting-btn1-url').value||'', btn1NewTab:$('#setting-btn1-newtab').checked,
      btn1TextColor:state.btn1TextColor, btn1BgColor:state.btn1BgColor,
      btn2Text:$('#setting-btn2-text').value||'', btn2Url:$('#setting-btn2-url').value||'', btn2NewTab:$('#setting-btn2-newtab').checked,
      btn2TextColor:state.btn2TextColor, btn2BgColor:state.btn2BgColor,
      btn3Text:$('#setting-btn3-text').value||'', btn3Url:$('#setting-btn3-url').value||'', btn3NewTab:$('#setting-btn3-newtab').checked,
      btn3TextColor:state.btn3TextColor, btn3BgColor:state.btn3BgColor,
      hotspotColors:JSON.parse(JSON.stringify(state.hotspotColors)),
      planData:state.planData||null, firstSceneId:state.firstSceneId||'',
      dotType:state.dotType||'circle',
      planSize:state.planSize||200, dotSize:state.dotSize||4,
      dotActiveColor:state.dotActiveColor||'#00cc44', dotInactiveColor:state.dotInactiveColor||'#ffffff',
    };
    var modal=$('#processing-modal'), fill=$('#progress-fill');
    modal.hidden=false; $('#processing-label').textContent='Generating ZIP…'; fill.style.width='20%';
    fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenes:ordered,settings:s})})
      .then(function(r){ fill.style.width='80%'; return r.blob(); })
      .then(function(blob){
        fill.style.width='100%'; modal.hidden=true; fill.style.width='0%';
        var url=URL.createObjectURL(blob), a=document.createElement('a');
        a.href=url; a.download=(s.title||'tour').replace(/[^a-z0-9]/gi,'-')+'.zip';
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        $('#export-modal').hidden=false;
      })
      .catch(function(err){ modal.hidden=true; fill.style.width='0%'; alert('Export failed: '+err.message); });
  }

  function openTestPreview() {
    if(!state.scenes.length){ alert('Add at least one scene first.'); return; }
    // Open immediately from user gesture to avoid popup blockers.
    var previewWin = window.open('about:blank', '_blank');
    if(!previewWin){
      alert('Popup blocked. Please allow popups to open preview.');
      return;
    }
    try { previewWin.document.write('<title>PanoPath Preview</title><p style="font-family:sans-serif;padding:16px">Preparing preview...</p>'); } catch(e) {}

    var ordered=state.scenes.slice();
    if(state.firstSceneId) ordered.sort(function(a,b){ return a.id===state.firstSceneId?-1:b.id===state.firstSceneId?1:0; });
    fetch('/api/preview-session',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ scenes: ordered, settings: collectSettings() })
    })
      .then(function(r){ return r.json(); })
      .then(function(result){
        if(result.error) throw new Error(result.error);
        previewWin.location.href = result.url;
      })
      .catch(function(err){
        try { previewWin.close(); } catch(e) {}
        alert('Preview failed: '+err.message);
      });
  }

  function openLoadModal(){
    $('#load-modal').hidden=false;
    refreshSavedProjectsList();
  }

  function refreshSavedProjectsList(){
    var list=$('#saved-projects-list');
    list.innerHTML='<div class="saved-empty">Loading…</div>';
    fetch('/api/projects')
      .then(function(r){ return r.json(); })
      .then(function(data){
        if(!data.projects.length){
          list.innerHTML='<div class="saved-empty">No saved projects yet.<br>Use Save Project to save your work.</div>';
          return;
        }
        list.innerHTML='';
        data.projects.forEach(function(p){
          var item=el('div','saved-project-item');
          var info=el('div','saved-project-info');
          info.appendChild(el('div','saved-project-name',p.name));
          var date=p.savedAt?new Date(p.savedAt).toLocaleString():'';
          info.appendChild(el('div','saved-project-meta',(p.sceneCount||0)+' scenes'+(date?' · '+date:'')));
          var del=el('button','saved-project-del','✕'); del.title='Delete';
          del.addEventListener('click',function(e){
            e.stopPropagation();
            if(!confirm('Delete "'+p.name+'"?')) return;
            fetch('/api/projects/'+encodeURIComponent(p.filename),{method:'DELETE'})
              .then(function(){ refreshSavedProjectsList(); });
          });
          item.appendChild(info); item.appendChild(del);
          item.addEventListener('click',function(){
            fetch('/api/projects/'+encodeURIComponent(p.filename))
              .then(function(r){ return r.json(); })
              .then(function(project){ $('#load-modal').hidden=true; loadProject(project); });
          });
          list.appendChild(item);
        });
      })
      .catch(function(){ list.innerHTML='<div class="saved-empty">Could not load projects.</div>'; });
  }

  function collectSettings(){
    return {
      title:$('#project-title').value||'Panorama Tour',
      autorotate:$('#setting-autorotate').checked, fullscreen:$('#setting-fullscreen').checked,
      zoom:$('#setting-zoom').checked, compass:$('#setting-compass').checked,
      mouseMode:$('#setting-mousemode').value,
      logoData:state.logoData||null, logoUrl:$('#setting-logo-url').value||'', logoNewTab:$('#setting-logo-newtab').checked,
      btn1Text:$('#setting-btn1-text').value||'', btn1Url:$('#setting-btn1-url').value||'', btn1NewTab:$('#setting-btn1-newtab').checked,
      btn1TextColor:state.btn1TextColor, btn1BgColor:state.btn1BgColor,
      btn2Text:$('#setting-btn2-text').value||'', btn2Url:$('#setting-btn2-url').value||'', btn2NewTab:$('#setting-btn2-newtab').checked,
      btn2TextColor:state.btn2TextColor, btn2BgColor:state.btn2BgColor,
      btn3Text:$('#setting-btn3-text').value||'', btn3Url:$('#setting-btn3-url').value||'', btn3NewTab:$('#setting-btn3-newtab').checked,
      btn3TextColor:state.btn3TextColor, btn3BgColor:state.btn3BgColor,
      hotspotColors:JSON.parse(JSON.stringify(state.hotspotColors)),
      planData:state.planData||null, firstSceneId:state.firstSceneId||'',
      dotType:state.dotType||'circle',
      planSize:state.planSize||200, dotSize:state.dotSize||4,
      dotActiveColor:state.dotActiveColor||'#00cc44', dotInactiveColor:state.dotInactiveColor||'#ffffff',
    };
  }

  function doSaveProject(){
    var name=$('#save-name-input').value.trim();
    if(!name){ alert('Enter a project name.'); return; }
    if(!state.scenes.length){ alert('Add at least one scene before saving.'); return; }
    var project={version:1, settings:collectSettings(), scenes:state.scenes};
    fetch('/api/projects/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,project:project})})
      .then(function(r){ return r.json(); })
      .then(function(result){
        if(result.error) throw new Error(result.error);
        $('#save-modal').hidden=true;
        var btn=$('#save-btn'); btn.textContent='Saved!';
        setTimeout(function(){ btn.textContent='Save project'; },1500);
      })
      .catch(function(err){ alert('Save failed: '+err.message); });
  }

  // ── Load project ───────────────────────────────────────────────────────────
  function loadProject(project){
    if(!project.scenes||!project.scenes.length){ alert('No scenes found.'); return; }
    fetch('/api/import-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenes:project.scenes})})
      .then(function(r){ return r.json(); })
      .then(function(data){
        var missing=data.results.filter(function(r){ return !r.exists; });
        if(missing.length) alert('Warning: '+missing.length+' scene(s) have missing tiles.');
        state.scenes.forEach(function(s){ var ms=state.marzScenes[s.id]; if(ms){ try{ state.marzViewer.destroyScene(ms); }catch(e){} } });
        state.scenes=[]; state.marzScenes={}; state.activeSceneId=null; state.firstSceneId=null; state.logoData=null; state.planData=null;
        $$('.scene-item').forEach(function(el){ el.remove(); }); $('#drop-hint').style.display='';
        $('#viewer-empty').hidden=false; $('#viewer-toolbar').hidden=true;
        $('#props-inner').innerHTML='<div class="props-empty">Select a scene to edit</div>';
        if(project.settings){
          var s=project.settings;
          if(s.title) $('#project-title').value=s.title;
          $('#setting-autorotate').checked=!!s.autorotate; $('#setting-fullscreen').checked=s.fullscreen!==false;
          $('#setting-zoom').checked=s.zoom!==false; $('#setting-compass').checked=s.compass!==false;
          if(s.mouseMode) $('#setting-mousemode').value=s.mouseMode;
          if(s.logoUrl) $('#setting-logo-url').value=s.logoUrl;
          if(s.logoNewTab) $('#setting-logo-newtab').checked=!!s.logoNewTab;
          $('#setting-btn1-text').value=s.btn1Text||s.brandText||'';
          $('#setting-btn1-url').value=s.btn1Url||s.brandUrl||'';
          $('#setting-btn1-newtab').checked=!!s.btn1NewTab;
          if(s.btn1TextColor){ state.btn1TextColor=s.btn1TextColor; $('#btn1-text-color').value=s.btn1TextColor; }
          if(s.btn1BgColor){   state.btn1BgColor=s.btn1BgColor;     $('#btn1-bg-color').value=s.btn1BgColor; }
          $('#setting-btn2-text').value=s.btn2Text||s.brand2Text||'';
          $('#setting-btn2-url').value=s.btn2Url||s.brand2Url||'';
          $('#setting-btn2-newtab').checked=!!s.btn2NewTab;
          if(s.btn2TextColor){ state.btn2TextColor=s.btn2TextColor; $('#btn2-text-color').value=s.btn2TextColor; }
          if(s.btn2BgColor){   state.btn2BgColor=s.btn2BgColor;     $('#btn2-bg-color').value=s.btn2BgColor; }
          $('#setting-btn3-text').value=s.btn3Text||s.projectsText||'';
          $('#setting-btn3-url').value=s.btn3Url||s.projectsUrl||'';
          $('#setting-btn3-newtab').checked=!!s.btn3NewTab;
          if(s.btn3TextColor){ state.btn3TextColor=s.btn3TextColor; $('#btn3-text-color').value=s.btn3TextColor; }
          if(s.btn3BgColor){   state.btn3BgColor=s.btn3BgColor;     $('#btn3-bg-color').value=s.btn3BgColor; }
          if(s.hotspotColors){
            Object.keys(state.hotspotColors).forEach(function(type){
              if(s.hotspotColors[type]){
                state.hotspotColors[type].bg = s.hotspotColors[type].bg || state.hotspotColors[type].bg;
                state.hotspotColors[type].icon = s.hotspotColors[type].icon || state.hotspotColors[type].icon;
              }
            });
            syncHotspotColorInputs();
            updateAllHotspotPreviews();
          }
          wireBtnColors(1); wireBtnColors(2); wireBtnColors(3);
          if(s.logoData){ state.logoData=s.logoData; $('#logo-preview').src=s.logoData; $('#logo-preview-wrap').hidden=false; }
          if(s.planData){ state.planData=s.planData; $('#plan-preview').src=s.planData; $('#plan-preview-wrap').hidden=false; $('#plan-controls').style.display=''; }
          state.dotType=s.dotType||'circle';
          $$('.dot-type-btn').forEach(function(btn){ btn.classList.toggle('active', btn.dataset.type===state.dotType); });
          $('#dot-rotation-row').style.display = state.dotType==='arrow' ? '' : 'none';
          if(s.planSize){ state.planSize=s.planSize; $('#plan-size-slider').value=s.planSize; applyPlanSize(); }
          if(s.dotSize){ state.dotSize=s.dotSize; $('#dot-size-slider').value=s.dotSize; }
          if(s.dotActiveColor){ state.dotActiveColor=s.dotActiveColor; $('#dot-active-color').value=s.dotActiveColor; }
          if(s.dotInactiveColor){ state.dotInactiveColor=s.dotInactiveColor; $('#dot-inactive-color').value=s.dotInactiveColor; }
          $('#setting-compass').checked = s.compass !== false;
          drawDotPreviews(); state.firstSceneId=s.firstSceneId||null;
        }
        var valid=project.scenes.filter(function(s){ return !missing.find(function(m){ return m.id===s.id; }); });
        valid.forEach(function(sc){
          var normalized = normalizeLoadedScene(sc);
          state.scenes.push(normalized);
          addSceneToSidebar(normalized);
        });
        if(!state.firstSceneId&&state.scenes.length) state.firstSceneId=state.scenes[0].id;
        updateFirstSceneBadges(); updatePreviewOverlay();
        refreshSceneRendering();
        if(state.scenes.length) activateScene(state.scenes[0].id);
        alert('Project loaded: '+state.scenes.length+' scene(s).');
      })
      .catch(function(err){ alert('Import error: '+err.message); });
  }

})();
