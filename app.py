"""ChitChat — Audio room server (FastAPI + WebSocket)."""

import asyncio
import json
import time
import uuid
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# ── State ───────────────────────────────────────────────
MAX_PARTICIPANTS = 20

# rooms[room_id] = { id, name, participants: {pid: {id,name,muted,ws}}, created_at }
rooms: dict[str, dict[str, Any]] = {}
clients: set[WebSocket] = set()


def room_to_json(room: dict) -> dict:
    return {
        "id": room["id"],
        "name": room["name"],
        "createdAt": room["created_at"],
        "participants": [
            {"id": p["id"], "name": p["name"], "muted": p.get("muted", False)}
            for p in room["participants"].values()
        ],
    }


async def broadcast(data: dict):
    msg = json.dumps(data)
    dead = []
    for ws in clients:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def broadcast_room_list():
    await broadcast({"type": "rooms", "rooms": [room_to_json(r) for r in rooms.values()]})


async def send_to_participant(room_id: str, pid: str, data: dict):
    room = rooms.get(room_id)
    if not room:
        return
    p = room["participants"].get(pid)
    if p and p.get("ws"):
        try:
            await p["ws"].send_text(json.dumps(data))
        except Exception:
            pass


# ── Page route ──────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


# ── REST API ────────────────────────────────────────────
@app.get("/api/rooms")
async def list_rooms():
    return [room_to_json(r) for r in rooms.values()]


@app.post("/api/rooms")
async def create_room(request: Request):
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        return {"error": "Name required"}, 400
    room_id = str(uuid.uuid4())
    rooms[room_id] = {
        "id": room_id,
        "name": name,
        "participants": {},
        "created_at": int(time.time() * 1000),
    }
    await broadcast_room_list()
    return room_to_json(rooms[room_id])


@app.post("/api/rooms/{room_id}/join")
async def join_room(room_id: str, request: Request):
    room = rooms.get(room_id)
    if not room:
        return {"error": "Room not found"}, 404
    if len(room["participants"]) >= MAX_PARTICIPANTS:
        return {"error": "Room full"}, 403
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        return {"error": "Name required"}, 400
    pid = str(uuid.uuid4())
    room["participants"][pid] = {"id": pid, "name": name, "muted": False, "ws": None}
    await broadcast_room_list()
    await broadcast({"type": "room_update", "room": room_to_json(room)})
    return {"participantId": pid, "room": room_to_json(room)}


@app.post("/api/rooms/{room_id}/leave")
async def leave_room(room_id: str, request: Request):
    room = rooms.get(room_id)
    if not room:
        return {"error": "Room not found"}, 404
    body = await request.json()
    pid = body.get("participantId")
    room["participants"].pop(pid, None)
    if not room["participants"]:
        rooms.pop(room_id, None)
    else:
        await broadcast({"type": "room_update", "room": room_to_json(room)})
    await broadcast_room_list()
    return {"ok": True}


# ── WebSocket ───────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    bound_room_id = None
    bound_pid = None

    # Send current rooms
    await ws.send_text(json.dumps({"type": "rooms", "rooms": [room_to_json(r) for r in rooms.values()]}))

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")

            if msg_type == "speaking":
                await broadcast({
                    "type": "speaking",
                    "roomId": data.get("roomId"),
                    "participantId": data.get("participantId"),
                    "speaking": data.get("speaking"),
                })

            elif msg_type == "mute_update":
                room = rooms.get(data.get("roomId", ""))
                if room:
                    p = room["participants"].get(data.get("participantId", ""))
                    if p:
                        p["muted"] = data.get("muted", False)
                    await broadcast({"type": "room_update", "room": room_to_json(room)})

            elif msg_type == "bind":
                bound_room_id = data.get("roomId")
                bound_pid = data.get("participantId")
                room = rooms.get(bound_room_id)
                if room:
                    p = room["participants"].get(bound_pid)
                    if p:
                        p["ws"] = ws
                    # Send existing peers list
                    existing = [pid for pid in room["participants"] if pid != bound_pid]
                    await ws.send_text(json.dumps({
                        "type": "peers",
                        "peers": existing,
                        "roomId": bound_room_id,
                    }))
                    # Notify existing peers
                    for pid, participant in room["participants"].items():
                        if pid != bound_pid and participant.get("ws"):
                            try:
                                await participant["ws"].send_text(json.dumps({
                                    "type": "new_peer",
                                    "peerId": bound_pid,
                                    "roomId": bound_room_id,
                                }))
                            except Exception:
                                pass

            elif msg_type in ("rtc_offer", "rtc_answer", "rtc_ice"):
                room = rooms.get(data.get("roomId", ""))
                if room:
                    target = room["participants"].get(data.get("targetId", ""))
                    if target and target.get("ws"):
                        try:
                            await target["ws"].send_text(json.dumps({
                                "type": msg_type,
                                "fromId": data.get("fromId"),
                                "roomId": data.get("roomId"),
                                "offer": data.get("offer"),
                                "answer": data.get("answer"),
                                "candidate": data.get("candidate"),
                            }))
                        except Exception:
                            pass

    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)
        # Auto-leave on disconnect
        if bound_room_id and bound_pid:
            room = rooms.get(bound_room_id)
            if room:
                room["participants"].pop(bound_pid, None)
                if not room["participants"]:
                    rooms.pop(bound_room_id, None)
                else:
                    await broadcast({"type": "room_update", "room": room_to_json(room)})
                await broadcast_room_list()
