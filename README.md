# Video Background Remover

Local browser tool for previewing and exporting transparent-background video.

## Run

```sh
npm start
```

Open `http://localhost:5177`.

## Export

The server streams the uploaded source video to a temporary file, runs the local `ffmpeg`, then the browser streams the ProRes 4444 `.mov` output into the save-location picker. Frames are not cached in browser memory.

Requires local `ffmpeg` and `ffprobe` on `PATH`.
