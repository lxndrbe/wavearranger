import './style.css';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js';

// --- Default Configuration & State ---
const DEFAULT_LABELS = [
  { name: 'Intro',    color: '#3b82f6', category: 'sections' },
  { name: 'Build-up', color: '#f59e0b', category: 'sections' },
  { name: 'Peak',     color: '#ef4444', category: 'sections' },
  { name: 'Break',    color: '#8b5cf6', category: 'sections' },
  { name: 'Drop',     color: '#ec4899', category: 'sections' },
  { name: 'Outro',    color: '#6b7280', category: 'sections' },
];

let state = {
  ws: null,
  wsRegions: null,
  labels: [],
  activeLabel: null,
  markerMode: false,
  bpm: 126.0,
  trackTitle: 'Untitled Track',
  duration: 0,
  obsidianPath: '',
  obsidianTags: 'track-arrangement, techno-analyzer',
  filenameTemplate: '{title} - Arrangement.md',
  selectedRegionId: null
};

// --- DOM Elements ---
let el = {};

function initDOMElements() {
  el = {
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('file-input'),
    analyzerContainer: document.getElementById('analyzer-container'),
    trackTitleInput: document.getElementById('track-title-input'),
    bpmInput: document.getElementById('global-bpm'),
    statDuration: document.getElementById('stat-duration'),
    statBars: document.getElementById('stat-bars'),
    statCurrentBar: document.getElementById('stat-current-bar'),
    timelineRulerInner: document.getElementById('timeline-ruler-inner'),
    waveform: document.getElementById('waveform'),
    
    // Playback Controls
    btnPlayPause: document.getElementById('btn-play-pause'),
    btnStop: document.getElementById('btn-stop'),
    timeCurrent: document.getElementById('time-current'),
    timeTotal: document.getElementById('time-total'),
    zoomSlider: document.getElementById('zoom-slider'),
    volumeSlider: document.getElementById('volume-slider'),
    
    // Label Sidebar
    groupSections: document.getElementById('group-sections'),
    groupCustom: document.getElementById('group-custom'),
    addLabelForm: document.getElementById('add-label-form'),
    newLabelName: document.getElementById('new-label-name'),
    newLabelColor: document.getElementById('new-label-color'),
    
    // Actions
    btnExportMarkdown: document.getElementById('btn-export-markdown'),
    btnSaveObsidian: document.getElementById('btn-save-obsidian'),
    btnSettings: document.getElementById('btn-settings'),
    
    // Settings Modal
    modalSettings: document.getElementById('modal-settings'),
    obsidianPathInput: document.getElementById('obsidian-path'),
    obsidianTagsInput: document.getElementById('obsidian-tags'),
    exportFilenameInput: document.getElementById('export-filename'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    
    // Export Modal
    modalExport: document.getElementById('modal-export'),
    markdownPreview: document.getElementById('markdown-preview'),
    btnDownloadMd: document.getElementById('btn-download-md'),
    btnCopyMd: document.getElementById('btn-copy-md'),
    
    // Toast
    toastContainer: document.getElementById('toast-container')
  };
}

// --- BPM Detection (Web Audio API) ---
async function detectBPM(file) {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    audioCtx.close();
  }

  // Mix down to mono
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;
  const mono = new Float32Array(length);
  for (let c = 0; c < numChannels; c++) {
    const ch = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += ch[i] / numChannels;
  }

  // Low-pass filter (simple IIR) to isolate kick frequencies ~150 Hz
  const rc = 1.0 / (2 * Math.PI * 150);
  const dt = 1.0 / sampleRate;
  const alpha = dt / (rc + dt);
  const filtered = new Float32Array(length);
  filtered[0] = mono[0];
  for (let i = 1; i < length; i++) {
    filtered[i] = filtered[i - 1] + alpha * (mono[i] - filtered[i - 1]);
  }

  // RMS energy in 50 ms windows, 25 ms hop
  const winSamples = Math.round(sampleRate * 0.05);
  const hopSamples = Math.round(sampleRate * 0.025);
  const energies = [];
  for (let i = 0; i + winSamples < length; i += hopSamples) {
    let e = 0;
    for (let j = i; j < i + winSamples; j++) e += filtered[j] * filtered[j];
    energies.push(e / winSamples);
  }

  // Adaptive peak picking: local max above mean * 1.5, min 280 ms apart
  const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
  const threshold = mean * 1.5;
  const minGap = Math.round(0.28 / (hopSamples / sampleRate));
  const peaks = [];
  let lastPeak = -minGap;
  for (let i = 1; i < energies.length - 1; i++) {
    if (
      energies[i] > threshold &&
      energies[i] >= energies[i - 1] &&
      energies[i] >= energies[i + 1] &&
      i - lastPeak > minGap
    ) {
      peaks.push(i);
      lastPeak = i;
    }
  }

  if (peaks.length < 4) return null; // not enough beats found

  // Convert inter-peak intervals to BPM values
  const hopSec = hopSamples / sampleRate;
  const bpmValues = [];
  for (let i = 1; i < peaks.length; i++) {
    const intervalSec = (peaks[i] - peaks[i - 1]) * hopSec;
    const bpm = 60 / intervalSec;
    // Accept 1x and 2x (double-time) in range 90–180
    if (bpm >= 90 && bpm <= 180) bpmValues.push(bpm);
    else if (bpm * 2 >= 90 && bpm * 2 <= 180) bpmValues.push(bpm * 2);
    else if (bpm / 2 >= 90 && bpm / 2 <= 180) bpmValues.push(bpm / 2);
  }

  if (bpmValues.length === 0) return null;

  // Histogram: round to nearest 0.5, pick mode
  const hist = {};
  bpmValues.forEach(b => {
    const key = (Math.round(b * 2) / 2).toFixed(1);
    hist[key] = (hist[key] || 0) + 1;
  });
  const bestBpm = parseFloat(
    Object.entries(hist).sort((a, b) => b[1] - a[1])[0][0]
  );
  return Math.round(bestBpm * 10) / 10;
}

// --- Helper Utilities ---
function hexToRgba(hex, alpha = 0.25) {
  hex = hex.replace('#', '');
  let r, g, b;
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
  } else {
    r = parseInt(hex.substring(0, 2), 16);
    g = parseInt(hex.substring(2, 4), 16);
    b = parseInt(hex.substring(4, 6), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexToRgbString(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  let r = parseInt(hex.substring(0, 2), 16);
  let g = parseInt(hex.substring(2, 4), 16);
  let b = parseInt(hex.substring(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function formatTime(sec) {
  if (isNaN(sec) || sec === null) return '00:00.0';
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  const tenths = Math.floor((sec % 1) * 10);
  
  const mStr = minutes.toString().padStart(2, '0');
  const sStr = seconds.toString().padStart(2, '0');
  return `${mStr}:${sStr}.${tenths}`;
}

function getBarNumber(time, bpmValue) {
  const barDuration = 240.0 / bpmValue; // 4 beats * 60 / BPM
  return 1.0 + (time / barDuration);
}

function formatBarString(time, bpmValue) {
  const beatDuration = 60.0 / bpmValue;
  const totalBeats = time / beatDuration;
  const bar = Math.floor(totalBeats / 4) + 1;
  const beat = Math.floor(totalBeats % 4) + 1;
  return `Bar ${bar}.${beat}`;
}

// --- Toast Notifications ---
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  else if (type === 'error') icon = '❌';
  
  toast.innerHTML = `<span class="toast-icon">${icon}</span> <span class="toast-text">${message}</span>`;
  el.toastContainer.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// --- Setup LocalStorage State ---
function loadState() {
  // Load BPM
  const savedBpm = localStorage.getItem('arranger_bpm');
  if (savedBpm) {
    state.bpm = parseFloat(savedBpm);
  }
  
  // Load Labels
  const savedLabels = localStorage.getItem('arranger_labels');
  if (savedLabels) {
    try {
      state.labels = JSON.parse(savedLabels);
    } catch (e) {
      state.labels = [...DEFAULT_LABELS];
    }
  } else {
    state.labels = [...DEFAULT_LABELS];
  }
  
  // Set default active label
  state.activeLabel = state.labels[0];
  
  // Settings
  state.obsidianPath = localStorage.getItem('arranger_obsidian_path') || '';
  state.obsidianTags = localStorage.getItem('arranger_obsidian_tags') || 'track-arrangement, techno-analyzer';
  state.filenameTemplate = localStorage.getItem('arranger_filename_template') || '{title} - Arrangement.md';
}

function saveLabelsToStorage() {
  localStorage.setItem('arranger_labels', JSON.stringify(state.labels));
}

// --- Render Label Toolbar Buttons ---
function renderLabelToolbar() {
  el.groupSections.innerHTML = '';
  el.groupCustom.innerHTML = '';

  state.labels.forEach((label) => {
    const btn = document.createElement('button');
    btn.className = `lbl-btn ${!state.markerMode && state.activeLabel?.name === label.name ? 'active' : ''}`;
    btn.style.setProperty('--lbl-color', label.color);
    btn.style.setProperty('--lbl-color-rgb', hexToRgbString(label.color));
    btn.innerHTML = `<span class="lbl-badge"></span> <span>${label.name}</span>`;

    btn.addEventListener('click', () => {
      state.activeLabel = label;
      state.markerMode = false;

      document.querySelectorAll('.lbl-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('btn-marker-mode').classList.remove('active');
      btn.classList.add('active');

      if (state.wsRegions && state._updateInteractionMode) {
        state._updateInteractionMode();
      }
    });

    if (label.category === 'sections') {
      el.groupSections.appendChild(btn);
    } else {
      el.groupCustom.appendChild(btn);
    }
  });
}

// --- Render Regions Table ---
function updateRegionsTable() {
  const tbody = document.getElementById('regions-list-body');
  if (!tbody) return;
  if (!state.wsRegions) return;

  const regions = [...state.wsRegions.getRegions()].sort((a, b) => a.start - b.start);

  if (regions.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-state">
        <td colspan="7">Sections: Label wählen + auf Waveform ziehen. Elemente/Custom: Ctrl+Klick.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  const barDuration = 240.0 / state.bpm;

  regions.forEach((region) => {
    const isMarker = region.isMarker === true;
    const startBar = 1.0 + (region.start / barDuration);
    const endBar   = 1.0 + (region.end   / barDuration);
    const totalBars = (region.end - region.start) / barDuration;
    const labelName  = region.customLabel || 'Unnamed';
    const labelColor = region.customColor || '#8b5cf6';

    const tr = document.createElement('tr');
    tr.dataset.id = region.id;
    if (isMarker) tr.classList.add('marker-row');
    if (state.selectedRegionId === region.id) tr.classList.add('active-row');

    if (isMarker) {
      tr.innerHTML = `
        <td class="bar-num"><input class="bar-input" type="number" value="${Math.round(startBar)}" min="1" step="1" title="Bar (editable)" /></td>
        <td class="bar-num text-muted">—</td>
        <td class="bar-num text-muted">—</td>
        <td>
          <span class="table-badge marker-badge" style="--badge-color: ${labelColor}; --badge-color-rgb: ${hexToRgbString(labelColor)}">
            <span class="table-badge-dot"></span>
            ${labelName}
          </span>
        </td>
        <td class="timecode-val">${formatTime(region.start)}</td>
        <td><input class="desc-input" type="text" value="${region.customDescription || ''}" placeholder="Notiz…" /></td>
        <td class="actions-cell">
          <button class="btn btn-secondary btn-sm btn-play-action" title="Zu Marker springen">▶ Play</button>
          <button class="btn btn-secondary btn-sm btn-danger" title="Delete marker">🗑️ Delete</button>
        </td>
      `;

      const inputBar = tr.querySelector('.bar-input');
      function applyMarkerEdit() {
        const newTime = (parseInt(inputBar.value) - 1) * barDuration;
        if (isNaN(newTime) || newTime < 0) return;
        region.setOptions({ start: newTime, end: newTime + 0.01 });
        tr.querySelector('.timecode-val').textContent = formatTime(region.start);
      }
      inputBar.addEventListener('change', applyMarkerEdit);
      inputBar.addEventListener('keydown', (e) => { if (e.key === 'Enter') { inputBar.blur(); applyMarkerEdit(); } });
      inputBar.addEventListener('click', (e) => e.stopPropagation());

      const descMarker = tr.querySelector('.desc-input');
      descMarker.addEventListener('input', () => { region.customDescription = descMarker.value; });
      descMarker.addEventListener('click', (e) => e.stopPropagation());

      tr.querySelector('.btn-play-action').addEventListener('click', () => {
        if (state.ws) state.ws.setTime(region.start);
      });

    } else {
      tr.innerHTML = `
        <td class="bar-num"><input class="bar-input" type="number" value="${Math.round(startBar)}" min="1" step="1" title="Bar From (editable)" /></td>
        <td class="bar-num"><input class="bar-input" type="number" value="${Math.round(endBar)}" min="1" step="1" title="Bar To (editable)" /></td>
        <td class="bar-num total-bars">${totalBars.toFixed(1)}</td>
        <td>
          <span class="table-badge" style="--badge-color: ${labelColor}; --badge-color-rgb: ${hexToRgbString(labelColor)}">
            <span class="table-badge-dot"></span>
            ${labelName}
          </span>
        </td>
        <td class="timecode-val">${formatTime(region.start)} – ${formatTime(region.end)}</td>
        <td><input class="desc-input" type="text" value="${region.customDescription || ''}" placeholder="Notiz…" /></td>
        <td class="actions-cell">
          <button class="btn btn-secondary btn-sm btn-play-action" title="Play section">▶ Play</button>
          <button class="btn btn-secondary btn-sm btn-danger" title="Delete section">🗑️ Delete</button>
        </td>
      `;

      const inputFrom = tr.querySelector('td:nth-child(1) .bar-input');
      const inputTo   = tr.querySelector('td:nth-child(2) .bar-input');

      function applyBarEdit() {
        const newStart = (parseInt(inputFrom.value) - 1) * barDuration;
        const newEnd   = (parseInt(inputTo.value)   - 1) * barDuration;
        if (isNaN(newStart) || isNaN(newEnd) || newEnd <= newStart) return;
        snapping = true;
        region.setOptions({ start: newStart, end: newEnd });
        snapping = false;
        tr.querySelector('.timecode-val').textContent = `${formatTime(region.start)} – ${formatTime(region.end)}`;
        tr.querySelector('.total-bars').textContent = ((region.end - region.start) / barDuration).toFixed(1);
      }

      [inputFrom, inputTo].forEach(inp => {
        inp.addEventListener('change', applyBarEdit);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { inp.blur(); applyBarEdit(); } });
        inp.addEventListener('click', (e) => e.stopPropagation());
      });

      const descInput = tr.querySelector('.desc-input');
      descInput.addEventListener('input', () => { region.customDescription = descInput.value; });
      descInput.addEventListener('click', (e) => e.stopPropagation());

      tr.querySelector('.btn-play-action').addEventListener('click', () => {
        if (state.ws) {
          state.ws.setTime(region.start);
          state.ws.play();
          const checkEnd = () => {
            if (state.ws.getCurrentTime() >= region.end) {
              state.ws.pause();
              state.ws.un('timeupdate', checkEnd);
            }
          };
          state.ws.un('timeupdate', checkEnd);
          state.ws.on('timeupdate', checkEnd);
        }
      });
    }

    tr.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.classList.contains('bar-input')) return;
      state.selectedRegionId = region.id;
      document.querySelectorAll('.regions-table tbody tr').forEach(r => r.classList.remove('active-row'));
      tr.classList.add('active-row');
      if (state.ws) state.ws.setTime(region.start);
    });

    tr.querySelector('.btn-danger').addEventListener('click', () => {
      region.remove();
      updateRegionsTable();
      updateGlobalStats();
    });

    tbody.appendChild(tr);
  });
}

// --- Render Timeline Ruler ---
function renderTimeline() {
  if (!state.ws || state.duration === 0) return;
  
  const scrollWidth = state.ws.renderer.scrollContainer.scrollWidth;
  el.timelineRulerInner.style.width = `${scrollWidth}px`;
  
  const pxPerSec = scrollWidth / state.duration;
  const barDuration = 240.0 / state.bpm;
  const barWidthPx = barDuration * pxPerSec;
  const totalBars = state.duration / barDuration;
  
  // Decide label interval based on pixels per bar width to avoid clutter
  let interval = 8;
  if (barWidthPx > 60) interval = 1;
  else if (barWidthPx > 30) interval = 2;
  else if (barWidthPx > 15) interval = 4;
  else if (barWidthPx > 7) interval = 8;
  else if (barWidthPx > 3) interval = 16;
  else interval = 32;
  
  el.timelineRulerInner.innerHTML = '';
  
  const fragment = document.createDocumentFragment();
  
  // Generate ruler marks
  for (let bar = 1; bar <= totalBars + 1; bar++) {
    const time = (bar - 1) * barDuration;
    const leftPx = time * pxPerSec;
    
    const isInterval = (bar - 1) % interval === 0;
    if (isInterval) {
      // Tick line
      const tick = document.createElement('div');
      tick.className = 'timeline-tick bar';
      tick.style.left = `${leftPx}px`;
      fragment.appendChild(tick);
      
      // Label text
      const label = document.createElement('div');
      label.className = 'timeline-label';
      label.innerText = `${bar}`;
      label.style.left = `${leftPx}px`;
      fragment.appendChild(label);
    } else if (barWidthPx > 10) {
      // Sub-tick
      const tick = document.createElement('div');
      tick.className = 'timeline-tick';
      tick.style.left = `${leftPx}px`;
      tick.style.opacity = '0.25';
      fragment.appendChild(tick);
    }
  }
  
  el.timelineRulerInner.appendChild(fragment);
}

// --- Update global track stats ---
function updateGlobalStats() {
  if (state.duration === 0) return;
  
  const barDuration = 240.0 / state.bpm;
  const totalBars = state.duration / barDuration;
  
  el.statDuration.innerText = formatTime(state.duration);
  el.statBars.innerText = totalBars.toFixed(1);
  el.timeTotal.innerText = formatTime(state.duration);
}

// --- WaveSurfer Loading & Setup ---
function loadAudioFile(url) {
  // Show loading indicator or update DOM
  showToast('Loading audio file...', 'info');
  
  // Destroy previous WaveSurfer instance if exists
  if (state.ws) {
    try {
      state.ws.destroy();
    } catch (e) {
      console.error('Error destroying WaveSurfer:', e);
    }
  }
  
  // Create WaveSurfer
  state.ws = WaveSurfer.create({
    container: '#waveform',
    waveColor: 'rgba(168, 85, 247, 0.35)',
    progressColor: 'rgba(34, 211, 238, 0.75)',
    cursorColor: '#f87171',
    cursorWidth: 2,
    barWidth: 2,
    barGap: 1,
    height: 130,
    normalize: true,
    dragToSeek: false,
    autoCenter: true
  });
  
  // Initialize Regions plugin
  state.wsRegions = state.ws.registerPlugin(RegionsPlugin.create());
  
  // Enable drag selection only for section labels
  function updateInteractionMode() {
    if (!state.markerMode && state.activeLabel?.category === 'sections') {
      state.wsRegions.enableDragSelection({ color: hexToRgba(state.activeLabel.color, 0.25) });
    } else {
      state.wsRegions.disableDragSelection();
    }
  }
  updateInteractionMode();
  state._updateInteractionMode = updateInteractionMode;

  // Ctrl+Click on waveform → place marker (marker mode only)
  el.waveform.addEventListener('click', (e) => {
    if (!state.markerMode || !state.ws) return;
    if (!e.ctrlKey) return;
    const rect = el.waveform.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const scrollLeft = state.ws.renderer.scrollContainer.scrollLeft;
    const totalWidth  = state.ws.renderer.scrollContainer.scrollWidth;
    const clickedTime = ((x + scrollLeft) / totalWidth) * state.duration;
    const barDuration = 240.0 / state.bpm;
    const snappedTime = Math.round(clickedTime / barDuration) * barDuration;

    const marker = state.wsRegions.addRegion({
      start: snappedTime,
      end: snappedTime + 0.01,
      color: 'transparent',
      drag: false,
      resize: false,
    });
    const markerNum = state.wsRegions.getRegions().filter(r => r.isMarker).length;
    marker.isMarker    = true;
    marker.customLabel = `Marker ${markerNum}`;
    marker.customColor = '#22d3ee';

    const labelDiv = document.createElement('div');
    labelDiv.className = 'wavesurfer-marker-label';
    labelDiv.innerText = marker.customLabel;
    marker.setOptions({ content: labelDiv });

    updateRegionsTable();
  });
  
  // WaveSurfer Event Listeners
  state.ws.on('ready', () => {
    state.duration = state.ws.getDuration();
    
    // Configure controls
    el.zoomSlider.value = 10;
    state.ws.zoom(10);
    
    // Reset ruler translation
    el.timelineRulerInner.style.transform = 'translateX(0px)';
    
    // Show workspace, hide dropzone
    el.dropzone.classList.add('hidden');
    el.analyzerContainer.classList.remove('hidden');
    
    // Initial stats and ruler render
    updateGlobalStats();
    renderTimeline();
    updateRegionsTable();
    
    // Volume setup
    const initialVolume = parseFloat(el.volumeSlider.value) / 100;
    state.ws.setVolume(initialVolume);
    
    showToast('Audio loaded successfully!', 'success');
  });
  
  state.ws.on('timeupdate', () => {
    const curTime = state.ws.getCurrentTime();
    el.timeCurrent.innerText = formatTime(curTime);
    el.statCurrentBar.innerText = formatBarString(curTime, state.bpm).replace('Bar ', '');
  });
  
  state.ws.on('play', () => {
    el.btnPlayPause.innerHTML = '<span class="icon">⏸</span>';
    el.btnPlayPause.className = 'btn btn-ctrl btn-play playing';
  });
  
  state.ws.on('pause', () => {
    el.btnPlayPause.innerHTML = '<span class="icon">▶</span>';
    el.btnPlayPause.className = 'btn btn-ctrl btn-play';
  });
  
  // Sync scrolling between timeline ruler and waveform scroll
  state.ws.renderer.scrollContainer.addEventListener('scroll', () => {
    const scrollLeft = state.ws.renderer.scrollContainer.scrollLeft;
    el.timelineRulerInner.style.transform = `translateX(-${scrollLeft}px)`;
  });
  
  // Resize timeline on zoom event
  state.ws.on('zoom', () => {
    renderTimeline();
    // Re-sync scroll
    const scrollLeft = state.ws.renderer.scrollContainer.scrollLeft;
    el.timelineRulerInner.style.transform = `translateX(-${scrollLeft}px)`;
  });
  
  // Regions events
  let snapping = false;

  function snapRegionToBars(region) {
    if (snapping) return;
    const barDuration = 240.0 / state.bpm;
    const snappedStart = Math.round(region.start / barDuration) * barDuration;
    const snappedEnd   = Math.round(region.end   / barDuration) * barDuration;
    // Ensure at least 1 bar wide and start != end
    const safeEnd = snappedEnd > snappedStart ? snappedEnd : snappedStart + barDuration;
    if (Math.abs(region.start - snappedStart) > 0.001 || Math.abs(region.end - safeEnd) > 0.001) {
      snapping = true;
      region.setOptions({ start: snappedStart, end: safeEnd });
      snapping = false;
    }
  }

  state.wsRegions.on('region-created', (region) => {
    if (!region.customLabel) {
      region.customLabel = state.activeLabel.name;
      region.customColor = state.activeLabel.color;

      region.setOptions({
        color: hexToRgba(state.activeLabel.color, 0.25),
        drag: true,
        resize: true
      });

      const labelDiv = document.createElement('div');
      labelDiv.className = 'wavesurfer-region-label';
      labelDiv.innerText = state.activeLabel.name;
      region.setOptions({ content: labelDiv });
    }

    snapRegionToBars(region);
    updateRegionsTable();
  });

  state.wsRegions.on('region-updated', (region) => {
    snapRegionToBars(region);
    updateRegionsTable();
  });
  
  state.wsRegions.on('region-clicked', (region, e) => {
    e.stopPropagation(); // Stop click-to-seek waveform
    state.selectedRegionId = region.id;
    
    // Highlight in table
    const trs = document.querySelectorAll('#regions-table tbody tr');
    trs.forEach((tr) => {
      if (tr.dataset.id === region.id) {
        tr.classList.add('active-row');
        tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        tr.classList.remove('active-row');
      }
    });
    
    // Seek to start
    state.ws.setTime(region.start);
  });
  
  // Load track
  state.ws.load(url);
}

// --- Generate Markdown Content ---
function generateMarkdown() {
  const today = new Date().toISOString().split('T')[0];
  const barDuration = 240.0 / state.bpm;
  const totalTrackBars = state.duration / barDuration;
  const tagsList = state.obsidianTags.split(',').map(t => t.trim()).filter(Boolean);
  
  let md = `---\n`;
  md += `title: "${state.trackTitle}"\n`;
  md += `bpm: ${state.bpm}\n`;
  md += `total_bars: ${totalTrackBars.toFixed(1)}\n`;
  md += `date: ${today}\n`;
  if (tagsList.length > 0) {
    md += `tags:\n`;
    tagsList.forEach((tag) => {
      md += `  - ${tag}\n`;
    });
  }
  md += `---\n\n`;
  
  md += `# Track Arrangement: ${state.trackTitle}\n\n`;
  
  md += `## Metadata\n`;
  md += `- **BPM**: ${state.bpm}\n`;
  md += `- **Total Bars**: ${totalTrackBars.toFixed(1)} bars\n`;
  md += `- **Duration**: ${formatTime(state.duration)} (${Math.round(state.duration)} seconds)\n`;
  md += `- **Analyzed on**: ${today}\n\n`;
  
  md += `## Arrangement Table\n\n`;
  md += `| Label | Bar From | Bar To | Bars | Timecode | Description |\n`;
  md += `| :--- | :---: | :---: | :---: | :--- | :--- |\n`;

  if (state.wsRegions) {
    const regions = [...state.wsRegions.getRegions()].sort((a, b) => a.start - b.start);
    regions.forEach((region) => {
      const label     = region.customLabel || 'Unnamed';
      const color     = region.customColor || '#8b5cf6';
      const desc      = region.customDescription || '';
      const isMarker  = region.isMarker === true;
      const startBar  = Math.round(1.0 + (region.start / barDuration));
      const endBar    = isMarker ? '—' : Math.round(1.0 + (region.end / barDuration));
      const lenBars   = isMarker ? '—' : Math.round((region.end - region.start) / barDuration);
      const timecode  = isMarker ? formatTime(region.start) : `${formatTime(region.start)} – ${formatTime(region.end)}`;
      const colorDot  = `<font color="${color}">⬤</font>`;
      md += `| ${colorDot} **${label}** | ${startBar} | ${endBar} | ${lenBars} | \`${timecode}\` | ${desc} |\n`;
    });
  }
  
  return md;
}

// --- Action Event Handlers ---
function setupHandlers() {
  // Drag & drop handlers
  el.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.dropzone.classList.add('dragover');
  });
  
  el.dropzone.addEventListener('dragleave', () => {
    el.dropzone.classList.remove('dragover');
  });
  
  el.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('dragover');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  });
  
  el.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  });
  
  async function handleFile(file) {
    state.trackTitle = file.name.replace(/\.[^/.]+$/, "");
    el.trackTitleInput.value = state.trackTitle;

    const url = URL.createObjectURL(file);

    showToast('Analysiere BPM...', 'info');
    try {
      const detectedBpm = await detectBPM(file);
      if (detectedBpm) {
        state.bpm = detectedBpm;
        el.bpmInput.value = detectedBpm;
        localStorage.setItem('arranger_bpm', detectedBpm);
        showToast(`BPM erkannt: ${detectedBpm}`, 'success');
      } else {
        showToast('BPM nicht erkannt – bitte manuell setzen', 'error');
      }
    } catch (e) {
      console.error('BPM detection failed:', e);
      showToast('BPM-Analyse fehlgeschlagen – bitte manuell setzen', 'error');
    }

    loadAudioFile(url);
  }
  
  // Track details changes
  el.trackTitleInput.addEventListener('change', () => {
    state.trackTitle = el.trackTitleInput.value.trim() || 'Untitled Track';
  });
  
  // Marker Mode Button
  document.getElementById('btn-marker-mode').addEventListener('click', () => {
    state.markerMode = !state.markerMode;
    document.getElementById('btn-marker-mode').classList.toggle('active', state.markerMode);
    if (state.markerMode) {
      document.querySelectorAll('.lbl-btn').forEach(b => b.classList.remove('active'));
      if (state.wsRegions && state._updateInteractionMode) state._updateInteractionMode();
    } else {
      if (state.wsRegions && state._updateInteractionMode) state._updateInteractionMode();
    }
  });

  // TAP BPM
  let tapTimes = [];
  let tapTimeout = null;
  document.getElementById('btn-tap').addEventListener('click', () => {
    const now = performance.now();
    tapTimes.push(now);
    // Reset after 2s of no tapping
    clearTimeout(tapTimeout);
    tapTimeout = setTimeout(() => { tapTimes = []; }, 2000);

    if (tapTimes.length > 1) {
      const intervals = [];
      for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.round((60000 / avgInterval) * 10) / 10;
      if (bpm >= 20 && bpm <= 300) {
        state.bpm = bpm;
        el.bpmInput.value = bpm;
        localStorage.setItem('arranger_bpm', bpm);
        updateGlobalStats();
        renderTimeline();
        updateRegionsTable();
      }
    }
  });

  // BPM settings
  el.bpmInput.addEventListener('input', () => {
    const parsed = parseFloat(el.bpmInput.value);
    if (!isNaN(parsed) && parsed > 0) {
      state.bpm = parsed;
      localStorage.setItem('arranger_bpm', state.bpm);
      
      // Update displays
      updateGlobalStats();
      renderTimeline();
      updateRegionsTable();
    }
  });
  
  // Playback Buttons
  el.btnPlayPause.addEventListener('click', () => {
    if (state.ws) {
      state.ws.playPause();
    }
  });
  
  el.btnStop.addEventListener('click', () => {
    if (state.ws) {
      state.ws.stop();
    }
  });
  
  // Sliders
  el.zoomSlider.addEventListener('input', () => {
    if (state.ws) {
      const zoomVal = parseInt(el.zoomSlider.value);
      state.ws.zoom(zoomVal);
    }
  });
  
  el.volumeSlider.addEventListener('input', () => {
    if (state.ws) {
      const volVal = parseFloat(el.volumeSlider.value) / 100;
      state.ws.setVolume(volVal);
    }
  });
  
  // Add Custom Label Form
  el.addLabelForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = el.newLabelName.value.trim();
    const color = el.newLabelColor.value;
    
    if (name) {
      // Check if duplicate name
      const exists = state.labels.some(l => l.name.toLowerCase() === name.toLowerCase());
      if (exists) {
        showToast('Label with this name already exists', 'error');
        return;
      }
      
      const newLabel = {
        name: name,
        color: color,
        category: 'custom'
      };
      
      state.labels.push(newLabel);
      saveLabelsToStorage();
      
      // Reset form
      el.newLabelName.value = '';
      
      // Re-render
      renderLabelToolbar();
      showToast(`Added custom label: ${name}`, 'success');
    }
  });
  
  // Settings Button & Modals
  el.btnSettings.addEventListener('click', () => {
    el.obsidianPathInput.value = state.obsidianPath;
    el.obsidianTagsInput.value = state.obsidianTags;
    el.exportFilenameInput.value = state.filenameTemplate;
    el.modalSettings.classList.remove('hidden');
  });
  
  el.btnSaveSettings.addEventListener('click', () => {
    state.obsidianPath = el.obsidianPathInput.value.trim();
    state.obsidianTags = el.obsidianTagsInput.value.trim();
    state.filenameTemplate = el.exportFilenameInput.value.trim();
    
    localStorage.setItem('arranger_obsidian_path', state.obsidianPath);
    localStorage.setItem('arranger_obsidian_tags', state.obsidianTags);
    localStorage.setItem('arranger_filename_template', state.filenameTemplate);
    
    el.modalSettings.classList.add('hidden');
    showToast('Settings saved successfully', 'success');
  });
  
  // Generate Markdown action
  el.btnExportMarkdown.addEventListener('click', () => {
    if (state.duration === 0) {
      showToast('No audio loaded to analyze.', 'error');
      return;
    }
    const md = generateMarkdown();
    el.markdownPreview.value = md;
    el.modalExport.classList.remove('hidden');
  });
  
  // Copy Markdown to Clipboard
  el.btnCopyMd.addEventListener('click', () => {
    navigator.clipboard.writeText(el.markdownPreview.value)
      .then(() => {
        showToast('Markdown copied to clipboard!', 'success');
      })
      .catch((err) => {
        showToast('Failed to copy text: ' + err, 'error');
      });
  });
  
  // Download Markdown file
  el.btnDownloadMd.addEventListener('click', () => {
    const md = el.markdownPreview.value;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
    const link = document.createElement('a');
    
    const filename = state.filenameTemplate.replace('{title}', state.trackTitle);
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Markdown download started', 'success');
  });
  
  // Save directly to Obsidian via Vite Local Server API
  el.btnSaveObsidian.addEventListener('click', async () => {
    if (state.duration === 0) {
      showToast('No audio loaded to save.', 'error');
      return;
    }
    
    if (!state.obsidianPath) {
      showToast('Please set your Obsidian folder path in Settings first.', 'error');
      el.btnSettings.click();
      return;
    }
    
    const md = generateMarkdown();
    const filename = state.filenameTemplate.replace('{title}', state.trackTitle);
    
    showToast('Saving to Obsidian...', 'info');
    
    try {
      const response = await fetch('/api/save-obsidian', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          folderPath: state.obsidianPath,
          fileName: filename,
          content: md
        })
      });
      
      const result = await response.json();
      
      if (response.ok && result.success) {
        showToast(`Saved to Obsidian: ${filename}`, 'success');
      } else {
        throw new Error(result.error || 'Failed to save file');
      }
    } catch (error) {
      console.error(error);
      showToast(`Error saving to Obsidian: ${error.message}`, 'error');
    }
  });
}

// --- App Entry Point ---
document.addEventListener('DOMContentLoaded', () => {
  initDOMElements();
  loadState();
  renderLabelToolbar();
  setupHandlers();
  
  // Initialize BPM input value from state
  el.bpmInput.value = state.bpm;
});
