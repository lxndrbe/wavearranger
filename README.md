# WaveArranger

A browser-based track arrangement analyzer for DJs and producers, built on top of [WaveSurfer.js](https://wavesurfer.js.org/).

Load an audio file, mark sections and set markers, take notes — then export everything as Obsidian-compatible Markdown.

---

## Features

- **Waveform visualization** powered by WaveSurfer.js
- **Automatic BPM detection** via Web Audio API (low-pass filter + peak analysis)
- **TAP BPM** button for manual tempo tapping
- **Bar-snapping regions** — drag on the waveform to mark sections (Intro, Drop, Break, etc.)
- **Numbered markers** — Ctrl+Click to drop a marker at any bar position
- **Inline editing** — edit Bar From / Bar To and add notes directly in the arrangement table
- **Markdown export** with color-coded labels, bar numbers, timecodes and descriptions — ready for Obsidian
- **Dark DAW theme** — Glassmorphism UI with neon accents

## Built With

- [WaveSurfer.js](https://wavesurfer.js.org/) — audio waveform rendering & regions plugin
- [Vite](https://vitejs.dev/) — build tooling
- Web Audio API — BPM detection

## Getting Started

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` in your browser.

## Usage

1. Drag & drop an audio file (MP3, WAV, FLAC, AIFF) onto the dropzone
2. BPM is detected automatically — correct it manually or use the **TAP** button
3. Select a **Section** label in the sidebar, then click & drag on the waveform to mark a region
4. Activate **Marker** mode, then **Ctrl+Click** to drop numbered markers
5. Add notes in the Description column
6. Click **Generate Markdown** to export your arrangement

## Export Format

The Markdown export is compatible with [Obsidian](https://obsidian.md/) and includes YAML frontmatter with BPM, total bars, date and tags, plus a color-coded arrangement table.

## License

MIT
