/* ── ChitChat Client ─────────────────────────────────── */

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const COLORS = [
  "#7c5cfc","#fc5c7d","#4ade80","#f59e0b","#06b6d4",
  "#e879f9","#fb923c","#a78bfa","#34d399","#f472b6",
];

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return COLORS[Math.abs(h) % COLORS.length];
}

function initials(name) {
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

// ── State ──────────────────────────────────────────────
let rooms = [];
let currentRoom = null;
let myParticipantId = null;
let myName = "";
let muted = false;
let deafened = false;
let speakingMap = {};
let timerInterval = null;
let timerStart = null;

// WebRTC
let localStream = null;       // raw mic stream
let processedStream = null;   // noise-filtered stream sent to peers
let peers = {};               // { peerId: RTCPeerConnection }
let remoteAudios = {};        // { peerId: HTMLAudioElement }
let analyserCtx = null;
let analyserInterval = null;
let wasSpeaking = false;
let audioProcessingCtx = null; // AudioContext for noise filtering

// Device selection
let selectedMicId = null;
let selectedSpeakerId = null;

// WebSocket
let ws = null;

// ── DOM refs ───────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Init ───────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  connectWS();
  setupCreateForm();
  setupModal();
  setupKeyboard();
});

// ── WebSocket ──────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === "rooms") {
      rooms = data.rooms;
      renderRoomGrid();
    }

    if (data.type === "room_update") {
      rooms = rooms.map(r => r.id === data.room.id ? data.room : r);
      // If room was deleted (no participants), remove it
      if (data.room.participants.length === 0) {
        rooms = rooms.filter(r => r.id !== data.room.id);
      }
      renderRoomGrid();
      if (currentRoom && currentRoom.id === data.room.id) {
        currentRoom = data.room;
        renderCallPanel();
      }
    }

    if (data.type === "speaking") {
      speakingMap[data.participantId] = data.speaking;
      if (currentRoom) renderCallPanel();
    }

    // WebRTC signaling
    if (data.type === "peers") handlePeers(data);
    if (data.type === "new_peer") { /* they will send offer via peers list */ }
    if (data.type === "rtc_offer") handleRtcOffer(data);
    if (data.type === "rtc_answer") handleRtcAnswer(data);
    if (data.type === "rtc_ice") handleRtcIce(data);
  };

  ws.onclose = () => {
    setTimeout(connectWS, 2000);
  };
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ── REST helpers ───────────────────────────────────────
async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Create form ────────────────────────────────────────
function setupCreateForm() {
  const form = $("#create-form");
  const input = $("#create-input");
  const btn = $("#create-btn");

  input.addEventListener("input", () => {
    btn.disabled = !input.value.trim();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    showModal("create", { roomName: name });
    input.value = "";
    btn.disabled = true;
  });
}

// ── Room Grid ──────────────────────────────────────────
function renderRoomGrid() {
  const grid = $("#room-grid");
  const empty = $("#empty-state");
  const countBadge = $("#room-count");

  countBadge.textContent = `${rooms.length} room${rooms.length !== 1 ? "s" : ""} live`;

  if (rooms.length === 0) {
    grid.innerHTML = "";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  grid.innerHTML = rooms.map(room => {
    const isFull = room.participants.length >= 20;
    const shown = room.participants.slice(0, 5);
    const overflow = room.participants.length - 5;

    return `
      <div class="room-card ${isFull ? "full" : ""}" data-room-id="${room.id}">
        <div class="room-card-border"></div>
        <div class="card-header">
          <div class="card-name">${esc(room.name)}</div>
          <span class="card-live"><span class="card-live-dot"></span>LIVE</span>
        </div>
        <div class="card-avatars">
          <div class="avatar-stack">
            ${shown.map(p => {
              const c = hashColor(p.name);
              return `<div class="mini-avatar" style="background:${c}22;color:${c}" title="${esc(p.name)}">${initials(p.name)}</div>`;
            }).join("")}
          </div>
          ${overflow > 0 ? `<span class="overflow-count">+${overflow}</span>` : ""}
        </div>
        <div class="card-footer">
          <span class="card-count font-mono">${room.participants.length}/20</span>
          <button class="join-btn" ${isFull ? "disabled" : ""} onclick="onJoinClick('${room.id}')">${isFull ? "Full" : "Join"}</button>
        </div>
      </div>
    `;
  }).join("");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ── Modal ──────────────────────────────────────────────
let modalContext = null; // { mode, roomName?, roomId? }

function setupModal() {
  $("#modal-cancel").addEventListener("click", hideModal);
  $("#modal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#modal-input").value.trim();
    if (!name) return;
    handleNameConfirm(name);
  });
  $("#modal-input").addEventListener("input", () => {
    $("#modal-confirm").disabled = !$("#modal-input").value.trim();
  });
}

function showModal(mode, ctx) {
  modalContext = { mode, ...ctx };
  $("#modal-confirm").textContent = mode === "create" ? "Create & Join" : "Join";
  $("#modal-input").value = myName || "";
  $("#modal-confirm").disabled = !myName;
  $("#modal-overlay").classList.remove("hidden");
  $("#modal-input").focus();
}

function hideModal() {
  $("#modal-overlay").classList.add("hidden");
  modalContext = null;
}

function onJoinClick(roomId) {
  if (currentRoom) return;
  showModal("join", { roomId });
}

async function handleNameConfirm(name) {
  myName = name;

  // Save context before hiding modal (hideModal sets modalContext to null)
  const ctx = modalContext;
  hideModal();

  // Start mic
  await startMic();

  let roomId;
  if (ctx.mode === "create") {
    const created = await apiPost("/api/rooms", { name: ctx.roomName });
    roomId = created.id;
  } else {
    roomId = ctx.roomId;
  }

  const joinData = await apiPost(`/api/rooms/${roomId}/join`, { name });
  myParticipantId = joinData.participantId;
  currentRoom = joinData.room;
  muted = false;
  deafened = false;
  speakingMap = {};

  // Bind WS for signaling
  wsSend({ type: "bind", roomId: currentRoom.id, participantId: myParticipantId });

  showCallPanel();
}

// ── Call Panel ─────────────────────────────────────────
function showCallPanel() {
  timerStart = Date.now();
  timerInterval = setInterval(updateTimer, 1000);
  renderCallPanel();
  $("#call-panel").classList.remove("hidden");
  // Pre-populate device lists
  enumerateDevices();
}

function hideCallPanel() {
  $("#call-panel").classList.add("hidden");
  $("#device-panel").classList.add("hidden");
  $("#ctrl-settings")?.classList.remove("active");
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function updateTimer() {
  if (!timerStart) return;
  const elapsed = Math.floor((Date.now() - timerStart) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const el = $("#call-timer");
  if (el) el.textContent = `${mm}:${ss}`;
}

function renderCallPanel() {
  if (!currentRoom) return;

  $("#call-room-name").textContent = currentRoom.name;
  $("#call-count").textContent = `${currentRoom.participants.length}/20`;

  // Participants
  const grid = $("#participants-grid");
  grid.innerHTML = currentRoom.participants.map(p => {
    const c = hashColor(p.name);
    const isYou = p.id === myParticipantId;
    const isSpeaking = speakingMap[p.id];
    const isMuted = p.muted;

    return `
      <div class="ptile ${isYou ? "is-you" : ""}">
        <div class="ptile-avatar-wrap">
          <div class="ptile-avatar ${isSpeaking ? "speaking" : ""}"
               style="background:${c}22;color:${c};border:2px solid ${isSpeaking ? "var(--green)" : c + "44"}">
            ${initials(p.name)}
          </div>
          ${isMuted ? '<span class="ptile-mute-badge">🔇</span>' : ""}
        </div>
        <span class="ptile-name">${esc(p.name)}${isYou ? '<span class="ptile-you">(You)</span>' : ""}</span>
      </div>
    `;
  }).join("");

  // Control buttons state
  const muteBtn = $("#ctrl-mute");
  muteBtn.className = `ctrl-btn ${muted ? "mute-on" : "mute-off"}`;
  muteBtn.textContent = muted ? "🔇" : "🎤";

  const deafBtn = $("#ctrl-deafen");
  deafBtn.className = `ctrl-btn ${deafened ? "deafen-on" : "deafen-off"}`;
  deafBtn.textContent = deafened ? "🔕" : "🔊";
}

// ── Controls ───────────────────────────────────────────
function toggleMute() {
  muted = !muted;
  // Mute both raw and processed streams
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }
  if (processedStream) {
    processedStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }
  wsSend({ type: "mute_update", roomId: currentRoom.id, participantId: myParticipantId, muted });
  renderCallPanel();
}

function toggleDeafen() {
  deafened = !deafened;
  Object.values(remoteAudios).forEach(audio => { audio.muted = deafened; });
  renderCallPanel();
}

async function leaveRoom() {
  if (!currentRoom || !myParticipantId) return;
  rtcCleanup();
  await apiPost(`/api/rooms/${currentRoom.id}/leave`, { participantId: myParticipantId });
  currentRoom = null;
  myParticipantId = null;
  muted = false;
  deafened = false;
  speakingMap = {};
  hideCallPanel();
}

// ── Keyboard Shortcuts ─────────────────────────────────
function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (!currentRoom) return;
    if (e.target.tagName === "INPUT") return;
    if (e.key === "m" || e.key === "M") toggleMute();
    if (e.key === "d" || e.key === "D") toggleDeafen();
    if (e.key === "Escape") leaveRoom();
  });
}

// ── WebRTC: Mic Capture + Noise Processing ─────────────
async function startMic() {
  try {
    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1,
      latency: { ideal: 0.01 },
      sampleSize: 16,
    };
    if (selectedMicId) {
      audioConstraints.deviceId = { exact: selectedMicId };
    }
    localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    // Build audio processing chain: mic → highpass → lowpass → compressor → gate → destination
    audioProcessingCtx = new AudioContext({ sampleRate: 48000 });
    const source = audioProcessingCtx.createMediaStreamSource(localStream);

    // High-pass filter: cut rumble/hum below 80Hz
    const highpass = audioProcessingCtx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 80;
    highpass.Q.value = 0.7;

    // Low-pass filter: cut hiss/noise above 8kHz (voice is mostly below this)
    const lowpass = audioProcessingCtx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 8000;
    lowpass.Q.value = 0.7;

    // Compressor: even out loud/quiet parts, reduce harsh peaks
    const compressor = audioProcessingCtx.createDynamicsCompressor();
    compressor.threshold.value = -30;   // start compressing at -30dB
    compressor.knee.value = 12;         // soft knee
    compressor.ratio.value = 4;         // 4:1 compression
    compressor.attack.value = 0.003;    // fast attack (3ms)
    compressor.release.value = 0.15;    // moderate release (150ms)

    // Noise gate via gain node — controlled by speaking detection
    const gateGain = audioProcessingCtx.createGain();
    gateGain.gain.value = 1.0;

    // Connect chain
    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(compressor);
    compressor.connect(gateGain);

    // Create processed output stream
    const dest = audioProcessingCtx.createMediaStreamDestination();
    gateGain.connect(dest);
    processedStream = dest.stream;

    // Store gate gain for noise gate control
    audioProcessingCtx._gateGain = gateGain;

    // Speaking detection uses the raw mic for accuracy
    startSpeakingDetection(localStream);
  } catch (err) {
    console.error("Mic access denied:", err);
  }
}

function startSpeakingDetection(stream) {
  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
    source.connect(analyser);
    analyserCtx = { ctx, analyser };

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let speakingFrames = 0;
    let silentFrames = 0;
    const SPEAK_THRESHOLD = 12;
    const SPEAK_FRAMES_NEEDED = 3;   // need 3 consecutive frames (~150ms) to trigger speaking
    const SILENT_FRAMES_NEEDED = 8;  // need 8 consecutive frames (~400ms) to trigger silent (debounce)

    analyserInterval = setInterval(() => {
      analyser.getByteFrequencyData(dataArray);
      // Focus on voice frequency range (roughly 85Hz–3kHz)
      // At 48kHz sampleRate with fftSize=1024, each bin ≈ 46.9Hz
      const startBin = 2;    // ~94Hz
      const endBin = 64;     // ~3kHz
      let sum = 0;
      for (let i = startBin; i < endBin; i++) sum += dataArray[i];
      const avg = sum / (endBin - startBin);

      if (avg > SPEAK_THRESHOLD) {
        speakingFrames++;
        silentFrames = 0;
      } else {
        silentFrames++;
        speakingFrames = 0;
      }

      let speaking;
      if (!wasSpeaking && speakingFrames >= SPEAK_FRAMES_NEEDED) {
        speaking = true;
      } else if (wasSpeaking && silentFrames >= SILENT_FRAMES_NEEDED) {
        speaking = false;
      } else {
        speaking = wasSpeaking;
      }

      if (speaking !== wasSpeaking) {
        wasSpeaking = speaking;
        speakingMap[myParticipantId] = speaking;
        wsSend({ type: "speaking", roomId: currentRoom?.id, participantId: myParticipantId, speaking });
        if (currentRoom) renderCallPanel();

        // Noise gate: smoothly ramp gain to suppress background noise when not speaking
        if (audioProcessingCtx && audioProcessingCtx._gateGain) {
          const g = audioProcessingCtx._gateGain.gain;
          const now = audioProcessingCtx.currentTime;
          g.cancelScheduledValues(now);
          if (speaking) {
            g.linearRampToValueAtTime(1.0, now + 0.02);  // open gate fast (20ms)
          } else {
            g.linearRampToValueAtTime(0.05, now + 0.15);  // close gate slowly (150ms), keep tiny residual
          }
        }
      }
    }, 50);
  } catch (err) {
    console.error("AudioContext error:", err);
  }
}

// ── WebRTC: Audio Quality Helpers ──────────────────────
// Boost Opus bitrate on senders to 64kbps for clear voice
function applyAudioBitrate(pc) {
  pc.getSenders().forEach(sender => {
    if (sender.track && sender.track.kind === "audio") {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = 64000;     // 64kbps Opus
      params.encodings[0].ptime = 20;              // 20ms packet time
      sender.setParameters(params).catch(() => {});
    }
  });
}

// Prefer Opus codec in SDP by moving it to the top of the m=audio line
function preferOpus(sdp) {
  const lines = sdp.split("\r\n");
  let audioMLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("m=audio")) { audioMLineIdx = i; break; }
  }
  if (audioMLineIdx === -1) return sdp;

  // Find Opus payload type
  let opusPT = null;
  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+) opus\/48000/i);
    if (match) { opusPT = match[1]; break; }
  }
  if (!opusPT) return sdp;

  // Reorder payload types in m=audio line to put Opus first
  const parts = lines[audioMLineIdx].split(" ");
  // parts = ["m=audio", port, proto, pt1, pt2, ...]
  const headerParts = parts.slice(0, 3);
  const pts = parts.slice(3);
  const reordered = [opusPT, ...pts.filter(p => p !== opusPT)];
  lines[audioMLineIdx] = [...headerParts, ...reordered].join(" ");

  // Add Opus fmtp for high quality if not present
  const fmtpPrefix = `a=fmtp:${opusPT}`;
  let hasFmtp = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(fmtpPrefix)) {
      // Append stereo=0;sprop-stereo=0;maxaveragebitrate=64000;useinbandfec=1;usedtx=1
      if (!lines[i].includes("maxaveragebitrate")) {
        lines[i] += ";maxaveragebitrate=64000;useinbandfec=1;usedtx=1";
      }
      hasFmtp = true;
      break;
    }
  }
  if (!hasFmtp) {
    // Insert after rtpmap for Opus
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(new RegExp(`^a=rtpmap:${opusPT} opus`))) {
        lines.splice(i + 1, 0, `${fmtpPrefix} minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=64000`);
        break;
      }
    }
  }

  return lines.join("\r\n");
}

// ── WebRTC: Peer Connections ───────────────────────────
function createPeer(peerId, initiator) {
  if (peers[peerId]) return peers[peerId];

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers[peerId] = pc;

  // Add processed (noise-filtered) tracks, fallback to raw mic
  const streamToSend = processedStream || localStream;
  if (streamToSend) {
    streamToSend.getTracks().forEach(track => pc.addTrack(track, streamToSend));
  }

  // Remote audio — apply selected speaker device
  pc.ontrack = (e) => {
    let audio = remoteAudios[peerId];
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      audio.preservesPitch = false;
      remoteAudios[peerId] = audio;
    }
    audio.srcObject = e.streams[0];
    audio.volume = 1.0;
    if (deafened) audio.muted = true;
    // Set output device if selected and supported
    if (selectedSpeakerId && audio.setSinkId) {
      audio.setSinkId(selectedSpeakerId).catch(() => {});
    }
  };

  // Apply bitrate once connection is established
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      applyAudioBitrate(pc);
    }
  };

  // ICE candidates
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      wsSend({
        type: "rtc_ice",
        roomId: currentRoom?.id,
        fromId: myParticipantId,
        targetId: peerId,
        candidate: e.candidate,
      });
    }
  };

  // Initiator creates offer with Opus preferred
  if (initiator) {
    pc.createOffer()
      .then(offer => {
        offer.sdp = preferOpus(offer.sdp);
        return pc.setLocalDescription(offer);
      })
      .then(() => {
        wsSend({
          type: "rtc_offer",
          roomId: currentRoom?.id,
          fromId: myParticipantId,
          targetId: peerId,
          offer: pc.localDescription,
        });
      })
      .catch(console.error);
  }

  return pc;
}

function handlePeers(data) {
  // We just joined — connect to all existing peers
  data.peers.forEach(peerId => createPeer(peerId, true));
}

function handleRtcOffer(data) {
  const pc = createPeer(data.fromId, false);
  pc.setRemoteDescription(new RTCSessionDescription(data.offer))
    .then(() => pc.createAnswer())
    .then(answer => {
      answer.sdp = preferOpus(answer.sdp);
      return pc.setLocalDescription(answer);
    })
    .then(() => {
      wsSend({
        type: "rtc_answer",
        roomId: currentRoom?.id,
        fromId: myParticipantId,
        targetId: data.fromId,
        answer: pc.localDescription,
      });
    })
    .catch(console.error);
}

function handleRtcAnswer(data) {
  const pc = peers[data.fromId];
  if (pc) pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(console.error);
}

function handleRtcIce(data) {
  const pc = peers[data.fromId];
  if (pc) pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(console.error);
}

// ── Device Selection ───────────────────────────────────
async function enumerateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const micSelect = $("#mic-select");
    const speakerSelect = $("#speaker-select");

    // Microphones
    const mics = devices.filter(d => d.kind === "audioinput");
    micSelect.innerHTML = mics.map((d, i) => {
      const label = d.label || `Microphone ${i + 1}`;
      const selected = d.deviceId === selectedMicId ? "selected" : "";
      return `<option value="${d.deviceId}" ${selected}>${esc(label)}</option>`;
    }).join("");

    // Speakers
    const speakers = devices.filter(d => d.kind === "audiooutput");
    if (speakers.length > 0) {
      speakerSelect.innerHTML = speakers.map((d, i) => {
        const label = d.label || `Speaker ${i + 1}`;
        const selected = d.deviceId === selectedSpeakerId ? "selected" : "";
        return `<option value="${d.deviceId}" ${selected}>${esc(label)}</option>`;
      }).join("");
      speakerSelect.parentElement.style.display = "";
    } else {
      // setSinkId not supported or no output devices listed
      speakerSelect.parentElement.style.display = "none";
    }
  } catch (err) {
    console.error("enumerateDevices error:", err);
  }
}

function toggleDevicePanel() {
  const panel = $("#device-panel");
  const btn = $("#ctrl-settings");
  const isHidden = panel.classList.contains("hidden");
  if (isHidden) {
    enumerateDevices();
    panel.classList.remove("hidden");
    btn.classList.add("active");
  } else {
    panel.classList.add("hidden");
    btn.classList.remove("active");
  }
}

async function onMicChange(deviceId) {
  selectedMicId = deviceId;
  if (!currentRoom) return;

  // Stop old streams
  if (analyserInterval) { clearInterval(analyserInterval); analyserInterval = null; }
  if (analyserCtx) { analyserCtx.ctx.close().catch(() => {}); analyserCtx = null; }
  if (audioProcessingCtx) { audioProcessingCtx.close().catch(() => {}); audioProcessingCtx = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  processedStream = null;

  // Re-acquire mic with the new device
  await startMic();

  // Replace the track in all peer connections
  const newTrack = (processedStream || localStream)?.getAudioTracks()[0];
  if (newTrack) {
    for (const pc of Object.values(peers)) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === "audio");
      if (sender) {
        await sender.replaceTrack(newTrack);
      }
    }
  }
}

async function onSpeakerChange(deviceId) {
  selectedSpeakerId = deviceId;
  // Apply to all remote audio elements
  for (const audio of Object.values(remoteAudios)) {
    if (audio.setSinkId) {
      try {
        await audio.setSinkId(deviceId);
      } catch (err) {
        console.error("setSinkId error:", err);
      }
    }
  }
}

// ── WebRTC: Cleanup ────────────────────────────────────
function rtcCleanup() {
  if (analyserInterval) { clearInterval(analyserInterval); analyserInterval = null; }
  if (analyserCtx) { analyserCtx.ctx.close().catch(() => {}); analyserCtx = null; }
  if (audioProcessingCtx) { audioProcessingCtx.close().catch(() => {}); audioProcessingCtx = null; }
  Object.values(peers).forEach(pc => pc.close());
  peers = {};
  Object.values(remoteAudios).forEach(a => { a.srcObject = null; });
  remoteAudios = {};
  if (processedStream) { processedStream.getTracks().forEach(t => t.stop()); processedStream = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  wasSpeaking = false;
}
