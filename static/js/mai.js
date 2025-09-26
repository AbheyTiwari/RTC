const videoGrid = document.getElementById('video-grid');
const localVideo = document.getElementById('local-video');
const participantsList = document.getElementById('participants-list');

const micBtn = document.getElementById('mic-btn');
const camBtn = document.getElementById('cam-btn');
const screenBtn = document.getElementById('screen-btn');
const leaveBtn = document.getElementById('leave-btn');
const participantsBtn = document.getElementById('participants-btn');
const participantsPanel = document.getElementById('participants-panel');

const micOnIcon = document.getElementById('mic-on-icon');
const micOffIcon = document.getElementById('mic-off-icon');
const camOnIcon = document.getElementById('cam-on-icon');
const camOffIcon = document.getElementById('cam-off-icon');

// Global state
let localStream;
let screenStream;
let isScreenSharing = false;
const peers = {}; // key: participant_id, value: RTCPeerConnection
const participants = {}; // key: participant_id, value: { username, roll_number }


// --- WebSocket Connection ---
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}/ws/${MEETING_ID}/${MY_USERNAME}/${MY_ROLL_NUMBER}`;
const ws = new WebSocket(wsUrl);

ws.onopen = () => {
    console.log("Connected to signaling server");
    initializeLocalMedia();
};

ws.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    const fromId = message.from;

    switch (message.type) {
        case 'user-joined':
            handleUserJoined(message);
            break;
        case 'user-left':
            handleUserLeft(message);
            break;
        case 'offer':
            await handleOffer(fromId, message.offer);
            break;
        case 'answer':
            await handleAnswer(fromId, message.answer);
            break;
        case 'ice-candidate':
            await handleIceCandidate(fromId, message.candidate);
            break;
        default:
            console.warn("Unknown message type:", message.type);
    }
};

ws.onclose = () => {
    console.log("Disconnected from signaling server");
    // Clean up all connections and UI
    for (const pid in peers) {
        if (peers.hasOwnProperty(pid)) {
            peers[pid].close();
            removeVideoElement(pid);
        }
    }
};

function sendMessage(type, payload, to) {
    ws.send(JSON.stringify({ type, ...payload, to }));
}

// --- WebRTC Functions ---

const peerConnectionConfig = {
    iceServers: [
        { 'urls': 'stun:stun.l.google.com:19302' },
        { 'urls': 'stun:stun1.l.google.com:19302' }
    ]
};

async function createPeerConnection(participantId) {
    const pc = new RTCPeerConnection(peerConnectionConfig);

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendMessage('ice-candidate', { candidate: event.candidate }, participantId);
        }
    };

    pc.ontrack = (event) => {
        addRemoteStream(participantId, event.streams[0]);
    };

    // Add local tracks to the connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    peers[participantId] = pc;
    return pc;
}

function handleUserJoined(message) {
    const participantId = message.participant_id;
    console.log(`User ${participantId} (${message.username}) joined`);
    
    // Update participant list
    participants[participantId] = { username: message.username, roll_number: message.roll_number };
    updateParticipantsList(message.participants);
    
    // Create offer to connect to the new user
    createOffer(participantId);
}

async function createOffer(participantId) {
    const pc = await createPeerConnection(participantId);
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendMessage('offer', { offer: offer }, participantId);
    } catch (error) {
        console.error("Error creating offer:", error);
    }
}

async function handleOffer(fromId, offer) {
    console.log(`Received offer from ${fromId}`);
    const pc = await createPeerConnection(fromId);
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendMessage('answer', { answer: answer }, fromId);
    } catch (error) {
        console.error("Error handling offer:", error);
    }
}

async function handleAnswer(fromId, answer) {
    console.log(`Received answer from ${fromId}`);
    const pc = peers[fromId];
    if (pc) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (error) {
            console.error("Error handling answer:", error);
        }
    }
}

async function handleIceCandidate(fromId, candidate) {
    const pc = peers[fromId];
    if (pc && candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('Error adding received ice candidate', error);
        }
    }
}

function handleUserLeft(message) {
    const participantId = message.participant_id;
    console.log(`User ${participantId} left`);
    
    if (peers[participantId]) {
        peers[participantId].close();
        delete peers[participantId];
    }
    if (participants[participantId]) {
        delete participants[participantId];
    }
    
    removeVideoElement(participantId);
    updateParticipantsListAfterLeave(participantId);
}


// --- Media Stream and UI Functions ---

async function initializeLocalMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
    } catch (error) {
        console.error("Error accessing local media.", error);
        alert("Could not access your camera and microphone. Please check permissions.");
    }
}

async function startScreenShare() {
    if (isScreenSharing) return;
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        isScreenSharing = true;
        screenBtn.classList.add('sharing');
        
        // Replace video track for all peers
        const screenTrack = screenStream.getVideoTracks()[0];
        replaceTrackForAllPeers(screenTrack);

        // Also update local video display
        localVideo.srcObject = screenStream;

        screenTrack.onended = () => {
            stopScreenShare();
        };

    } catch (error) {
        console.error("Error starting screen share:", error);
    }
}

function stopScreenShare() {
    if (!isScreenSharing) return;

    // Replace back to camera track for all peers
    const cameraTrack = localStream.getVideoTracks()[0];
    replaceTrackForAllPeers(cameraTrack);
    
    // Stop screen share tracks
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
    isScreenSharing = false;
    screenBtn.classList.remove('sharing');
    
    // Restore local video display
    localVideo.srcObject = localStream;
}

function replaceTrackForAllPeers(newTrack) {
    for (const pid in peers) {
        const sender = peers[pid].getSenders().find(s => s.track.kind === newTrack.kind);
        if (sender) {
            sender.replaceTrack(newTrack);
        }
    }
}

function addRemoteStream(participantId, stream) {
    if (document.getElementById(`video-container-${participantId}`)) {
        // Already exists
        return;
    }
    const container = document.createElement('div');
    container.id = `video-container-${participantId}`;
    container.className = 'video-container relative rounded-lg overflow-hidden bg-gray-800 shadow-lg';
    
    const remoteVideo = document.createElement('video');
    remoteVideo.srcObject = stream;
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;
    remoteVideo.className = 'w-full h-full object-cover';
    
    const nameTag = document.createElement('div');
    nameTag.className = 'absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-sm px-2 py-1 rounded-md';
    const participantInfo = participants[participantId] || {username: 'Guest'};
    nameTag.innerText = participantInfo.username;
    
    container.appendChild(remoteVideo);
    container.appendChild(nameTag);
    videoGrid.appendChild(container);
    
    updateVideoGridLayout();
}

function removeVideoElement(participantId) {
    const videoElement = document.getElementById(`video-container-${participantId}`);
    if (videoElement) {
        videoElement.remove();
        updateVideoGridLayout();
    }
}

function updateVideoGridLayout() {
    const numVideos = videoGrid.children.length;
    videoGrid.className = `flex-1 p-4 grid gap-4 layout-videos-${Math.min(numVideos, 12)}`;
}

function updateParticipantsList(currentParticipants) {
    participantsList.innerHTML = ''; // Clear current list
    
    // Add myself first
    addParticipantToList(MY_USERNAME, MY_ROLL_NUMBER, true);

    for (const pid in currentParticipants) {
        // Check if pid is not the one associated with the local user.
        // This relies on the websocket client's port being unique.
        // A more robust solution might pass a unique ID from the backend.
        if (currentParticipants.hasOwnProperty(pid)) {
             addParticipantToList(currentParticipants[pid].username, currentParticipants[pid].roll_number);
        }
    }
}

function updateParticipantsListAfterLeave(leftParticipantId) {
    const element = document.getElementById(`participant-${leftParticipantId}`);
    if(element) element.remove();
}


function addParticipantToList(username, roll_number, isMe = false) {
    const item = document.createElement('div');
    item.className = 'flex items-center space-x-3 p-2 rounded-lg bg-gray-200 dark:bg-gray-700';
    item.id = `participant-${roll_number}`; // Use roll number for unique ID
    
    const name = document.createElement('span');
    name.className = 'font-medium';
    name.textContent = `${username} ${isMe ? '(You)' : ''}`;

    const roll = document.createElement('span');
    roll.className = 'text-xs text-gray-500 dark:text-gray-400';
    roll.textContent = `(${roll_number})`;
    
    item.appendChild(name);
    item.appendChild(roll);
    participantsList.appendChild(item);
}


// --- Event Listeners for Controls ---

micBtn.addEventListener('click', () => {
    const enabled = localStream.getAudioTracks()[0].enabled;
    localStream.getAudioTracks()[0].enabled = !enabled;
    micOnIcon.classList.toggle('hidden', !enabled);
    micOffIcon.classList.toggle('hidden', enabled);
    micBtn.classList.toggle('bg-red-600', enabled);
});

camBtn.addEventListener('click', () => {
    const enabled = localStream.getVideoTracks()[0].enabled;
    localStream.getVideoTracks()[0].enabled = !enabled;
    camOnIcon.classList.toggle('hidden', !enabled);

    camOffIcon.classList.toggle('hidden', enabled);
    camBtn.classList.toggle('bg-red-600', enabled);
});

screenBtn.addEventListener('click', () => {
    if (isScreenSharing) {
        stopScreenShare();
    } else {
        startScreenShare();
    }
});

leaveBtn.addEventListener('click', () => {
    ws.close();
    window.location.href = '/';
});

participantsBtn.addEventListener('click', () => {
    participantsPanel.classList.toggle('translate-x-full');
});


// Initial setup call
updateVideoGridLayout();
