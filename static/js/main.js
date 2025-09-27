document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration & DOM Elements ---
    const { MEETING_ID, MY_USERNAME, MY_ROLL_NUMBER, MEETING_LINK } = window.appConfig;
    const WS_URL = `ws://${window.location.host}/ws/${MEETING_ID}/${MY_USERNAME}/${MY_ROLL_NUMBER}`;

    const videoGrid = document.getElementById('video-grid');
    const localVideo = document.getElementById('local-video');
    const toast = document.getElementById('toast');
    
    // Side Panel Elements
    const participantsPanel = document.getElementById('participants-panel');
    const participantsList = document.getElementById('participants-list');
    const chatPanel = document.getElementById('chat-panel');
    const chatMessages = document.getElementById('chat-messages');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');


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
            document.getElementById('media-error-overlay').classList.remove('hidden');
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
            case 'connected':
                ws.participantId = payload.participant_id;
                console.log(`Connected to meeting with ID: ${ws.participantId}`);
                updateParticipantsList(payload.participants);
                break;

            case 'user-joined':
                const { participant_id, username, roll_number } = payload;
                if (participant_id === ws.participantId) return;

                console.log(`User joined: ${username} (${participant_id})`);
                addParticipantToListUI(username, roll_number, participant_id, false);
                remoteParticipants[participant_id] = { username, roll_number };
                
                console.log(`Creating offer for new participant: ${username}`);
                createOffer(participant_id);
                break;

            case 'offer':
                console.log(`Received offer from ${from_id}`);
                await handleOffer(payload.offer, from_id);
                break;

            case 'answer':
                console.log(`Received answer from ${from_id}`);
                await handleAnswer(payload.answer, from_id);
                break;

            case 'ice-candidate':
                await handleIceCandidate(payload.candidate, from_id);
                break;

            case 'user-left':
                console.log('User left:', payload.participant_id);
                handleUserLeft(payload.participant_id);
                break;
            
            case 'chat-message':
                appendChatMessage(payload.username, payload.message, payload.is_system_message);
                break;

            default:
                console.warn("Received unknown message type:", type);
                break;
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
            const participantElement = document.getElementById(`participant-${leftParticipant.roll_number}`);
            if (participantElement) {
                participantElement.remove();
            }
            delete remoteParticipants[participantId];
        }
    };

    // --- UI & Media Controls ---
    const setupUIEventListeners = () => {
        const ids = [
            ['mic-btn', toggleMic],
            ['cam-btn', toggleCam],
            ['screen-btn', toggleScreenShare],
            ['leave-btn', leaveMeeting],
            ['copy-link-btn', copyMeetingLink],
            ['qr-btn', toggleQrModal],
            ['close-qr-modal-btn', toggleQrModal],
            ['participants-toggle-btn', toggleParticipantsPanel],
            ['chat-toggle-btn', toggleChatPanel],
        ];
        ids.forEach(([id, fn]) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', fn);
        });

        if (chatForm) {
            chatForm.addEventListener('submit', (e) => {
                e.preventDefault();
                sendChatMessage();
            });
        }
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
                const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                const screenTrack = screenStream.getVideoTracks()[0];
                
                replaceTrack(screenTrack, localStream.getVideoTracks()[0]);
                localVideo.srcObject = new MediaStream([screenTrack]); // Show screen locally
                isScreenSharing = true;
                document.getElementById('screen-btn').classList.add('bg-blue-600');
                showToast("You are sharing your screen.");

                screenTrack.onended = () => stopScreenShare();
            } catch (err) {
                console.error("Screen share error:", err);
                isScreenSharing = false;
                document.getElementById('screen-btn').classList.remove('bg-blue-600');
            }
        }
    };
    
    const stopScreenShare = () => {
        const cameraTrack = localStream.getVideoTracks()[0];
        const currentTrack = localVideo.srcObject.getVideoTracks()[0];
        replaceTrack(cameraTrack, currentTrack);
        localVideo.srcObject = localStream;
        isScreenSharing = false;
        document.getElementById('screen-btn').classList.remove('bg-blue-600');
        showToast("Screen sharing stopped.");
    }

    const replaceTrack = (newTrack, oldTrack) => {
        for (const pc of Object.values(peerConnections)) {
            const sender = pc.getSenders().find(s => s.track === oldTrack);
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
            qrContainer.innerHTML = '';
            const canvas = document.createElement('canvas');
            qrContainer.appendChild(canvas);
            QRCode.toCanvas(canvas, MEETING_LINK, { width: 220, errorCorrectionLevel: 'H' }, (err) => {
                if (err) console.error(err);
            });
            document.getElementById('qr-link-text').innerText = MEETING_LINK;
        }
        modal.classList.toggle('hidden');
    };
    
    const toggleParticipantsPanel = () => {
        participantsPanel.classList.remove('hidden');
        chatPanel.classList.add('hidden');
    };
    
    const toggleChatPanel = () => {
        chatPanel.classList.remove('hidden');
        participantsPanel.classList.add('hidden');
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
        const count = document.querySelectorAll('#video-grid .video-container').length;
        videoGrid.className = `flex-1 p-4 grid gap-4 layout-videos-${Math.max(1, count)}`;
    };

    const updateParticipantsList = (participants) => {
        participantsList.innerHTML = ''; 
        Object.entries(participants).forEach(([id, p]) => {
            const isYou = id === ws.participantId;
            addParticipantToListUI(p.username, p.roll_number, id, isYou);

            if (!isYou) {
                remoteParticipants[id] = p;
                if (!peerConnections[id]) {
                    console.log(`New participant detected: ${p.username}. Creating offer.`);
                    createOffer(id);
                }
            }
        });
    };

    const addParticipantToListUI = (username, roll_number, participantId, isYou) => {
        const existingEl = document.getElementById(`participant-${roll_number}`);
        if(existingEl) return;

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

    const sendChatMessage = () => {
        const message = chatInput.value.trim();
        if (message && ws.readyState === WebSocket.OPEN) {
            sendMessage({
                type: 'chat-message',
                message: message,
            });
            appendChatMessage(MY_USERNAME, message, false, true);
            chatInput.value = '';
        }
    };

    const appendChatMessage = (username, message, isSystemMessage, isMe = false) => {
        const messageEl = document.createElement('div');
        let wrapperClass = 'flex justify-start';
        let messageClass = 'bg-gray-200 dark:bg-gray-700';

        if (isSystemMessage) {
            wrapperClass = 'flex justify-center';
            messageEl.innerHTML = `<span class="text-sm text-gray-500 italic">${message}</span>`;
        } else {
            if (isMe) {
                wrapperClass = 'flex justify-end';
                messageClass = 'bg-indigo-500 text-white';
                username = 'You';
            }
            messageEl.innerHTML = `
                <div class="font-bold text-sm">${username}</div>
                <div class="break-words">${message}</div>
            `;
        }
        
        messageEl.className = `p-2 rounded-lg max-w-xs text-sm ${messageClass}`;
        
        const wrapper = document.createElement('div');
        wrapper.className = wrapperClass;
        wrapper.appendChild(messageEl);

        chatMessages.appendChild(wrapper);
        chatMessages.scrollTop = chatMessages.scrollHeight; // Scroll to bottom
    };


    // --- Start the application ---
    init();
});
