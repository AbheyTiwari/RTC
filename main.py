import os
import uuid
from typing import Dict, List

import uvicorn
from fastapi import (FastAPI, WebSocket, WebSocketDisconnect, Request, Form,
                     Depends, HTTPException)
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketState
import json

import database as db
import models
from database import SessionLocal, engine

# Create all database tables
models.Base.metadata.create_all(bind=engine)

app = FastAPI()

# Mount static files (CSS, JS)
app.mount("/static", StaticFiles(directory="static"), name="static")

# Setup Jinja2 templates
templates = Jinja2Templates(directory="templates")

# --- Database Dependency ---
def get_db():
    database = SessionLocal()
    try:
        yield database
    finally:
        database.close()

# --- Connection Manager for WebSockets ---
class ConnectionManager:
    def __init__(self):
        # meeting_id -> {participant_id -> websocket}
        self.active_connections: Dict[str, Dict[str, WebSocket]] = {}
        # meeting_id -> {participant_id -> {username, roll_number}}
        self.participant_details: Dict[str, Dict[str, dict]] = {}

    async def connect(self, websocket: WebSocket, meeting_id: str, username: str, roll_number: str):
        await websocket.accept()
        participant_id = str(uuid.uuid4())
        websocket.state.participant_id = participant_id

        if meeting_id not in self.active_connections:
            self.active_connections[meeting_id] = {}
            self.participant_details[meeting_id] = {}

        await websocket.send_json({
            "type": "connected",
            "participant_id": participant_id,
            "participants": self.participant_details[meeting_id]
        })

        self.active_connections[meeting_id][participant_id] = websocket
        self.participant_details[meeting_id][participant_id] = {"username": username, "roll_number": roll_number}

        system_join_message = {
            "type": "chat-message",
            "username": "System",
            "message": f"{username} has joined the meeting.",
            "is_system_message": True,
        }
        await self.broadcast(meeting_id, system_join_message)

        webrtc_join_message = {
            "type": "user-joined",
            "participant_id": participant_id,
            "username": username,
            "roll_number": roll_number,
        }
        await self.broadcast(meeting_id, webrtc_join_message, sender_id=participant_id)


    def disconnect(self, websocket: WebSocket, meeting_id: str):
        participant_id = getattr(websocket.state, 'participant_id', None)
        if not participant_id: return

        if meeting_id in self.active_connections and participant_id in self.active_connections[meeting_id]:
            del self.active_connections[meeting_id][participant_id]
            if participant_id in self.participant_details[meeting_id]:
                del self.participant_details[meeting_id][participant_id]
            
            if not self.active_connections[meeting_id]:
                del self.active_connections[meeting_id]
                del self.participant_details[meeting_id]

    async def broadcast(self, meeting_id: str, message: dict, sender_id: str = None):
        if meeting_id in self.active_connections:
            for pid, connection in self.active_connections[meeting_id].items():
                if pid != sender_id and connection.client_state == WebSocketState.CONNECTED:
                    await connection.send_json(message)

    async def send_to_peer(self, meeting_id: str, target_id: str, message: dict):
        if meeting_id in self.active_connections and target_id in self.active_connections[meeting_id]:
            connection = self.active_connections[meeting_id][target_id]
            if connection.client_state == WebSocketState.CONNECTED:
                await connection.send_json(message)

manager = ConnectionManager()


# --- HTML Routes ---

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.post("/create-meeting", response_class=RedirectResponse)
async def create_meeting_post(request: Request, meeting_name: str = Form(None), db_session: Session = Depends(get_db)):
    if not meeting_name or meeting_name.isspace():
        from coolname import generate_slug
        meeting_name = generate_slug(2)

    new_meeting = models.Meeting(name=meeting_name)
    db_session.add(new_meeting)
    db_session.commit()
    db_session.refresh(new_meeting)
    
    return RedirectResponse(url=f"/meeting/{new_meeting.id}", status_code=303)


@app.get("/meeting/{meeting_id}", response_class=HTMLResponse)
async def get_meeting_page(request: Request, meeting_id: uuid.UUID, db_session: Session = Depends(get_db)):
    meeting = db_session.query(models.Meeting).filter(models.Meeting.id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return templates.TemplateResponse("join_room.html", {"request": request, "meeting": meeting})

@app.post("/join/{meeting_id}", response_class=HTMLResponse)
async def join_meeting_post(
    request: Request, 
    meeting_id: uuid.UUID,
    username: str = Form(...),
    roll_number: str = Form(...),
    db_session: Session = Depends(get_db)
):
    meeting = db_session.query(models.Meeting).filter(models.Meeting.id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    existing_participant = db_session.query(models.Participant).filter(
        models.Participant.meeting_id == meeting_id,
        models.Participant.roll_number == roll_number
    ).first()

    if existing_participant:
        error_message = f"Roll number '{roll_number}' is already in use in this meeting."
        return templates.TemplateResponse(
            "join_room.html", 
            {"request": request, "meeting": meeting, "error": error_message}
        )
    
    participant = models.Participant(
        username=username,
        roll_number=roll_number,
        meeting_id=meeting_id
    )
    db_session.add(participant)
    db_session.commit()
    db_session.refresh(participant)

    meeting_link = str(request.url_for('get_meeting_page', meeting_id=meeting_id))

    return templates.TemplateResponse(
        "meeting.html", {
        "request": request,
        "meeting": meeting,
        "meeting_id": str(meeting_id),
        "username": username,
        "roll_number": roll_number,
        "meeting_link": meeting_link
    })

# --- WebSocket Signaling Route ---

@app.websocket("/ws/{meeting_id}/{username}/{roll_number}")
async def websocket_endpoint(websocket: WebSocket, meeting_id: str, username: str, roll_number: str):
    await manager.connect(websocket, meeting_id, username, roll_number)
    sender_id = getattr(websocket.state, 'participant_id', None)

    try:
        while True:
            data = await websocket.receive_json()
            data_type = data.get("type")

            if data_type == 'chat-message':
                message_payload = {
                    "type": "chat-message",
                    "username": username,
                    "message": data.get("message", ""),
                    "is_system_message": False
                }
                await manager.broadcast(meeting_id, message_payload)
            else: # WebRTC signaling
                target_id = data.get("to")
                data["from_id"] = sender_id
                
                if target_id:
                    await manager.send_to_peer(meeting_id, target_id, data)

    except WebSocketDisconnect:
        sender_username = manager.participant_details.get(meeting_id, {}).get(sender_id, {}).get('username', 'Someone')
        manager.disconnect(websocket, meeting_id)
        
        if sender_id:
            # System message for chat
            await manager.broadcast(meeting_id, {
                "type": "chat-message",
                "username": "System",
                "message": f"{sender_username} has left the meeting.",
                "is_system_message": True,
            })
            # WebRTC cleanup message
            await manager.broadcast(meeting_id, {
                "type": "user-left",
                "participant_id": sender_id
            }, sender_id=sender_id)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

