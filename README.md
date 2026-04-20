# ChitChat — Audio Room Web App

A real-time audio chat room application built entirely in Python (FastAPI) with vanilla HTML/CSS/JS frontend.

## Features

- Create and join audio rooms in real-time
- WebRTC peer-to-peer audio between participants
- Live speaking detection with visual indicators
- Mute / Deafen controls with keyboard shortcuts
- Max 20 participants per room
- Auto-cleanup when rooms empty
- No kick/remove — anyone can join, only you can leave
- Dark theme with ambient gradients

## Prerequisites

- **Python 3.10+** — [Download Python](https://www.python.org/downloads/)
- **pip** — comes bundled with Python
- A modern browser (Chrome, Firefox, Edge) with microphone access

## Setup & Run

### 1. Clone / navigate to the project

```bash
cd project2
```

### 2. Create a virtual environment (recommended)

```bash
python -m venv venv
```

Activate it:

- **Windows (PowerShell):**
  ```powershell
  .\venv\Scripts\Activate.ps1
  ```
- **Windows (CMD):**
  ```cmd
  venv\Scripts\activate.bat
  ```
- **Linux / macOS:**
  ```bash
  source venv/bin/activate
  ```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Run the server

```bash
uvicorn app:app --host 0.0.0.0 --port 3001 --reload
```

### 5. Open in browser

Navigate to **http://localhost:3001**

> To test audio between users, open two browser tabs (or two different browsers).

## Keyboard Shortcuts (while in a call)

| Key   | Action       |
|-------|-------------|
| `M`   | Toggle mute  |
| `D`   | Toggle deafen|
| `Esc` | Leave room   |

## Project Structure

```
project2/
├── app.py                  # FastAPI server (REST + WebSocket + WebRTC signaling)
├── requirements.txt        # Python dependencies
├── README.md               # This file
├── templates/
│   └── index.html          # Single-page HTML template
└── static/
    ├── css/
    │   └── style.css       # All styles (dark theme, animations)
    └── js/
        └── app.js          # Client logic (UI, WebSocket, WebRTC, speaking detection)
```

## How It Works

1. **Backend** — FastAPI serves the HTML page, REST endpoints for room CRUD, and a WebSocket for real-time updates + WebRTC signaling relay.
2. **Frontend** — Vanilla JS manages UI state, connects to WebSocket for live room updates, and uses WebRTC for peer-to-peer audio.
3. **Audio** — When you join a room, the browser captures your microphone. WebRTC peer connections are established with every other participant in a full-mesh topology. Speaking detection uses `AudioContext` + `AnalyserNode` to detect voice activity.
4. **Mute** — Disables your local audio track (peers stop hearing you).
5. **Deafen** — Mutes all remote audio elements (you stop hearing others).

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Mic access denied" in console | Allow microphone permission in browser settings |
| No audio between tabs on same machine | Use two different browsers (e.g., Chrome + Firefox) |
| WebSocket connection fails | Make sure the server is running on port 3001 |
| Page won't load | Check that all files are in place and `uvicorn` is running |
