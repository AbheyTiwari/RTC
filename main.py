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
        self.active_connections: Dict[str, List[WebSocket]] = {}
        self.participant_details: Dict[str, Dict[str, str]] = {}

    async def connect(self, websocket: WebSocket, meeting_id: str, username: str, roll_number: str):
        await websocket.accept()
        if meeting_id not in self.active_connections:
            self.active_connections[meeting_id] = []
            self.participant_details[meeting_id] = {}
        self.active_connections[meeting_id].append(websocket)
        participant_id = websocket.scope["client"][1] 
        self.participant_details[meeting_id][str(participant_id)] = {"username": username, "roll_number": roll_number}
        
        # Announce new participant to others in the same meeting
        join_notification = {
            "type": "user-joined",
            "participant_id": str(participant_id),
            "username": username,
            "roll_number": roll_number,
            "participants": self.participant_details[meeting_id]
        }
        await self.broadcast(meeting_id, join_notification, websocket)


    def disconnect(self, websocket: WebSocket, meeting_id: str):
        participant_id = websocket.scope["client"][1]
        if meeting_id in self.active_connections:
            self.active_connections[meeting_id].remove(websocket)
            if str(participant_id) in self.participant_details[meeting_id]:
                del self.participant_details[meeting_id][str(participant_id)]
            if not self.active_connections[meeting_id]:
                del self.active_connections[meeting_id]
                del self.participant_details[meeting_id]

    async def broadcast(self, meeting_id: str, message: dict, sender: WebSocket = None):
        if meeting_id in self.active_connections:
            for connection in self.active_connections[meeting_id]:
                if connection != sender and connection.client_state == WebSocketState.CONNECTED:
                    await connection.send_json(message)

manager = ConnectionManager()


# --- HTML Routes ---

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    """Serves the main page to create or join a meeting."""
    return templates.TemplateResponse("index.html", {"request": request})

@app.post("/create-meeting", response_class=RedirectResponse)
async def create_meeting_post(request: Request, meeting_name: str = Form(None), db_session: Session = Depends(get_db)):
    """Creates a new meeting and redirects to the join page."""
    if not meeting_name:
        # Generate a creative, readable name if none provided
        from coolname import generate_slug
        meeting_name = generate_slug(2) + "-" + str(uuid.uuid4().fields[-1])[:4]
    
    new_meeting = models.Meeting(name=meeting_name)
    db_session.add(new_meeting)
    db_session.commit()
    db_session.refresh(new_meeting)
    
    return RedirectResponse(url=f"/meeting/{new_meeting.id}", status_code=303)


@app.get("/meeting/{meeting_id}", response_class=HTMLResponse)
async def get_meeting_page(request: Request, meeting_id: uuid.UUID, db_session: Session = Depends(get_db)):
    """Serves the page for a user to enter their details before joining."""
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
    """Handles participant joining, validation, and renders the meeting room."""
    meeting = db_session.query(models.Meeting).filter(models.Meeting.id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    # Check if roll number already exists for this meeting
    existing_participant = db_session.query(models.Participant).filter(
        models.Participant.meeting_id == meeting_id,
        models.Participant.roll_number == roll_number
    ).first()

    if existing_participant:
        error_message = f"Roll number '{roll_number}' is already taken in this meeting."
        return templates.TemplateResponse(
            "join_room.html", 
            {"request": request, "meeting": meeting, "error": error_message}
        )
    
    # Save participant to the database
    participant = models.Participant(
        username=username,
        roll_number=roll_number,
        meeting_id=meeting_id
    )
    db_session.add(participant)
    db_session.commit()
    db_session.refresh(participant)
    
    meeting_link = request.url_for('get_meeting_page', meeting_id=meeting_id)

    return templates.TemplateResponse(
        "meeting.html", {
        "request": request,
        "meeting_id": str(meeting_id),
        "participant_id": participant.id,
        "username": username,
        "roll_number": roll_number,
        "meeting_link": meeting_link
    })

# --- WebSocket Signaling Route ---

@app.websocket("/ws/{meeting_id}/{username}/{roll_number}")
async def websocket_endpoint(websocket: WebSocket, meeting_id: str, username: str, roll_number: str):
    await manager.connect(websocket, meeting_id, username, roll_number)
    participant_id = websocket.scope["client"][1]
    
    try:
        while True:
            data = await websocket.receive_json()
            # Forward the message to other clients in the same meeting room
            await manager.broadcast(meeting_id, data, websocket)

    except WebSocketDisconnect:
        manager.disconnect(websocket, meeting_id)
        # Notify others that this participant has left
        await manager.broadcast(meeting_id, {
            "type": "user-left",
            "participant_id": str(participant_id)
        })

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
