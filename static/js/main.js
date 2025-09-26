document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration & DOM Elements ---
    const { MEETING_ID, MY_USERNAME, MY_ROLL_NUMBER, MEETING_LINK } = window.appConfig;
    const WS_URL = `ws://${window.location.host}/ws/${MEETING_ID}/${MY_USERNAME}/${MY_ROLL_NUMBER}`;

    const videoGrid = document.getElementById('video-grid');
    const localVideo = document.getElementById('local-video');
    const toast = document.getElementById('toast');
    const participantsPanel = document.getElementById('participants-panel');
    const participantsList = document.getElementById('participants-list');

    // --- State Management ---
    let localStream;
    let ws;
    const peerConnections = {};
    let remoteParticipants = {};
    let isAudioMuted = false;
    let isVideoMuted = false;
    let isScreenSharing = false;

    // --- WebRTC Configuration ---
    const peerConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
    };

    // --- Main Initialization ---
    const init = async () => {
        try {
            await startLocalMedia();
            setupWebSocket();
            setupUIEventListeners();
            updateGridLayout();
        } catch (error) {
            console.error("Initialization failed:", error);
            alert("Could not start video. Please check permissions and try again.");
        }
    };

    const startLocalMedia = async () => {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
    };

    // --- WebSocket Signaling ---
    const setupWebSocket = () => {
        ws = new WebSocket(WS_URL);
        ws.onopen = () => console.log("WebSocket connected.");
        ws.onmessage = handleWebSocketMessage;
        ws.onclose = () => {
            console.log("WebSocket disconnected.");
            alert("You have been disconnected from the meeting.");
            window.location.href = '/';
        };
        ws.onerror = (error) => console.error("WebSocket error:", error);
    };

    const handleWebSocketMessage = async (event) => {
        const message = JSON.parse(event.data);
        const { type, from_id, ...payload } = message;

        switch (type) {
            case 'user-joined':
                console.log('User joined:', payload.participant_id, payload);
                updateParticipantsList(payload.participants);
                break;
            case 'offer':
                await handleOffer(payload.offer, from_id);
                break;
            case 'answer':
                await handleAnswer(payload.answer, from_id);
                break;
            case 'ice-candidate':
                await handleIceCandidate(payload.candidate, from_id);
                break;
            case 'user-left':
                console.log('User left:', payload.participant_id);
                handleUserLeft(payload.participant_id);
                break;
            default:
                console.warn("Unknown message type:", type);
        }
    };
    
    const sendMessage = (message) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    };

    // --- WebRTC Core Logic ---
    const createPeerConnection = (participantId) => {
        if (peerConnections[participantId]) {
            return peerConnections[participantId];
        }

        const pc = new RTCPeerConnection(peerConfig);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendMessage({
                    type: 'ice-candidate',
                    candidate: event.candidate,
                    to: participantId,
                });
            }
        };

        pc.ontrack = (event) => {
            addRemoteStream(participantId, event.streams[0]);
        };
        
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });

        peerConnections[participantId] = pc;
        return pc;
    };

    const createOffer = async (participantId) => {
        const pc = createPeerConnection(participantId);
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendMessage({ type: 'offer', offer: offer, to: participantId });
        } catch (error) {
            console.error(`Error creating offer for ${participantId}:`, error);
        }
    };

    const handleOffer = async (offer, participantId) => {
        const pc = createPeerConnection(participantId);
         try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendMessage({ type: 'answer', answer: answer, to: participantId });
        } catch (error) {
            console.error(`Error handling offer from ${participantId}:`, error);
        }
    };

    const handleAnswer = async (answer, participantId) => {
        const pc = peerConnections[participantId];
        if (pc) {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(answer));
            } catch (error) {
                console.error(`Error handling answer from ${participantId}:`, error);
            }
        }
    };

    const handleIceCandidate = async (candidate, participantId) => {
        const pc = peerConnections[participantId];
        if (pc && pc.remoteDescription && candidate) {
             try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch(error) {
                console.error(`Error adding ICE candidate from ${participantId}:`, error);
            }
        }
    };

    const handleUserLeft = (participantId) => {
        if (peerConnections[participantId]) {
            peerConnections[participantId].close();
            delete peerConnections[participantId];
        }
        removeRemoteVideo(participantId);
        
        const leftParticipant = remoteParticipants[participantId];
        if(leftParticipant){
            showToast(`${leftParticipant.username} has left the meeting.`);
            const participantElement = document.getElementById(`participant-${leftParticipant.roll_number}`);
            if (participantElement) {
                participantElement.remove();
            }
            delete remoteParticipants[participantId];
        }
    };

    // --- UI & Media Controls ---
    const setupUIEventListeners = () => {
        document.getElementById('mic-btn').addEventListener('click', toggleMic);
        document.getElementById('cam-btn').addEventListener('click', toggleCam);
        document.getElementById('screen-btn').addEventListener('click', toggleScreenShare);
        document.getElementById('leave-btn').addEventListener('click', leaveMeeting);
        document.getElementById('copy-link-btn').addEventListener('click', copyMeetingLink);
        document.getElementById('qr-btn').addEventListener('click', toggleQrModal);
        document.getElementById('close-qr-modal-btn').addEventListener('click', toggleQrModal);
        document.getElementById('participants-btn').addEventListener('click', toggleParticipantsPanel);
        document.getElementById('close-participants-btn').addEventListener('click', toggleParticipantsPanel);
    };

    const toggleMic = () => {
        if (!localStream) return;
        isAudioMuted = !isAudioMuted;
        localStream.getAudioTracks()[0].enabled = !isAudioMuted;
        document.getElementById('mic-on-icon').classList.toggle('hidden', isAudioMuted);
        document.getElementById('mic-off-icon').classList.toggle('hidden', !isAudioMuted);
        document.getElementById('mic-btn').classList.toggle('bg-red-600', isAudioMuted);
    };

    const toggleCam = () => {
        if (!localStream) return;
        isVideoMuted = !isVideoMuted;
        localStream.getVideoTracks()[0].enabled = !isVideoMuted;
        document.getElementById('cam-on-icon').classList.toggle('hidden', isVideoMuted);
        document.getElementById('cam-off-icon').classList.toggle('hidden', !isVideoMuted);
        document.getElementById('cam-btn').classList.toggle('bg-red-600', isVideoMuted);
    };

    const toggleScreenShare = async () => {
        if (isScreenSharing) {
            stopScreenShare();
        } else {
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                const screenTrack = screenStream.getVideoTracks()[0];
                
                replaceTrack(screenTrack);
                localVideo.srcObject = new MediaStream([screenTrack]); // Show screen locally
                isScreenSharing = true;
                document.getElementById('screen-btn').classList.add('sharing');

                screenTrack.onended = () => stopScreenShare();
            } catch (err) {
                console.error("Screen share error:", err);
                isScreenSharing = false;
                 document.getElementById('screen-btn').classList.remove('sharing');
            }
        }
    };
    
    const stopScreenShare = () => {
        const cameraTrack = localStream.getVideoTracks()[0];
        replaceTrack(cameraTrack);
        localVideo.srcObject = localStream;
        isScreenSharing = false;
        document.getElementById('screen-btn').classList.remove('sharing');
    }

    const replaceTrack = (newTrack) => {
        for (const pc of Object.values(peerConnections)) {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === newTrack.kind);
            if (sender) {
                sender.replaceTrack(newTrack);
            }
        }
    };

    const leaveMeeting = () => {
        Object.values(peerConnections).forEach(pc => pc.close());
        if (ws) ws.close();
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        window.location.href = '/';
    };
    
    const copyMeetingLink = () => {
        navigator.clipboard.writeText(MEETING_LINK).then(() => {
            showToast("Link copied to clipboard!");
        }).catch(err => {
            console.error('Failed to copy: ', err);
            showToast("Failed to copy link.", true);
        });
    };
    
    const toggleQrModal = () => {
        const modal = document.getElementById('qr-modal');
        if (modal.classList.contains('hidden')) {
            const qrContainer = document.getElementById('qr-code-container');
            qrContainer.innerHTML = ''; // Clear previous QR code
            QRCode.toCanvas(qrContainer, MEETING_LINK, { width: 220, errorCorrectionLevel: 'H' }, (err) => {
                if (err) console.error(err);
            });
            document.getElementById('qr-link-text').innerText = MEETING_LINK;
        }
        modal.classList.toggle('hidden');
    };
    
    const toggleParticipantsPanel = () => {
        participantsPanel.classList.toggle('hidden');
    };

    const showToast = (message, isError = false) => {
        toast.textContent = message;
        toast.className = `fixed bottom-24 right-5 text-white py-2 px-4 rounded-lg shadow-xl transition-all duration-300 ease-in-out z-30 ${isError ? 'bg-red-500' : 'bg-green-500'}`;
        toast.classList.remove('opacity-0', 'translate-y-10');
        setTimeout(() => {
            toast.classList.add('opacity-0', 'translate-y-10');
        }, 3000);
    };
    
    // --- Dynamic UI Updates ---
    const addRemoteStream = (participantId, stream) => {
        if (document.getElementById(`video-container-${participantId}`)) return;

        const container = document.createElement('div');
        container.id = `video-container-${participantId}`;
        container.className = 'video-container relative rounded-lg overflow-hidden bg-gray-700 shadow-lg';

        const video = document.createElement('video');
        video.srcObject = stream;
        video.autoplay = true;
        video.playsInline = true;
        video.className = 'w-full h-full object-cover';

        const nameTag = document.createElement('div');
        nameTag.className = 'absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-sm px-2 py-1 rounded-md';
        nameTag.textContent = remoteParticipants[participantId]?.username || 'Guest';

        container.appendChild(video);
        container.appendChild(nameTag);
        videoGrid.appendChild(container);
        updateGridLayout();
    };

    const removeRemoteVideo = (participantId) => {
        const container = document.getElementById(`video-container-${participantId}`);
        if (container) {
            container.remove();
            updateGridLayout();
        }
    };

    const updateGridLayout = () => {
        const count = document.querySelectorAll('.video-container').length;
        videoGrid.className = `flex-1 p-4 grid gap-4 layout-videos-${count}`;
    };

    const updateParticipantsList = (participants) => {
        const newRemoteParticipants = {};
        participantsList.innerHTML = ''; 

        Object.entries(participants).forEach(([id, p]) => {
            const isYou = p.roll_number === MY_ROLL_NUMBER && p.username === MY_USERNAME;
            addParticipantToListUI(p.username, p.roll_number, id, isYou);

            if (!isYou) {
                newRemoteParticipants[id] = p;
                if (!peerConnections[id]) {
                    console.log(`New participant detected: ${p.username}. Creating offer.`);
                    createOffer(id);
                }
            }
        });
        remoteParticipants = newRemoteParticipants;
    };

    const addParticipantToListUI = (username, roll_number, participantId, isYou) => {
        const participantEl = document.createElement('div');
        participantEl.id = `participant-${roll_number}`;
        participantEl.className = 'flex items-center space-x-3 p-2 rounded-md';
        participantEl.innerHTML = `
            <div class="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-white font-bold text-sm">
                ${username[0].toUpperCase()}
            </div>
            <div>
                <p class="font-semibold text-sm">${username} ${isYou ? '(You)' : ''}</p>
                <p class="text-xs text-gray-500">${roll_number}</p>
            </div>
        `;
        participantsList.appendChild(participantEl);
    };

    // --- Start the application ---
    init();
});

