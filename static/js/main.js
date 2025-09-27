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
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ 
                video: { width: 640, height: 480 }, 
                audio: { 
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true 
                } 
            });
            localVideo.srcObject = localStream;
            console.log('Local media started successfully');
        } catch (error) {
            console.error('Failed to get local media:', error);
            throw error;
        }
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

        console.log('Received message:', type, message);

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
                
                // Wait a bit before creating offer to ensure both sides are ready
                setTimeout(() => {
                    console.log(`Creating offer for new participant: ${username}`);
                    createOffer(participant_id);
                }, 100);
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
                console.log(`Received ICE candidate from ${from_id}`);
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
            console.log('Sending message:', message.type, message);
            ws.send(JSON.stringify(message));
        } else {
            console.error('WebSocket not ready, message not sent:', message);
        }
    };

    // --- WebRTC Core Logic ---
    const createPeerConnection = (participantId) => {
        if (peerConnections[participantId]) {
            console.log(`Peer connection already exists for ${participantId}`);
            return peerConnections[participantId];
        }

        console.log(`Creating new peer connection for ${participantId}`);
        const pc = new RTCPeerConnection(peerConfig);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log(`Sending ICE candidate to ${participantId}:`, event.candidate);
                sendMessage({
                    type: 'ice-candidate',
                    candidate: event.candidate,
                    to: participantId,
                });
            } else {
                console.log('All ICE candidates have been sent');
            }
        };

        pc.ontrack = (event) => {
            console.log(`Received track from ${participantId}:`, event.track.kind);
            handleRemoteTrack(participantId, event.track);
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`ICE connection state for ${participantId}:`, pc.iceConnectionState);
        };

        pc.onconnectionstatechange = () => {
            console.log(`Connection state for ${participantId}:`, pc.connectionState);
        };

        // Add local stream tracks to peer connection
        if (localStream) {
            localStream.getTracks().forEach(track => {
                console.log(`Adding local track (${track.kind}) to peer connection for ${participantId}`);
                pc.addTrack(track, localStream);
            });
        } else {
            console.error('Local stream not available when creating peer connection');
        }

        peerConnections[participantId] = pc;
        return pc;
    };

    const createOffer = async (participantId) => {
        try {
            const pc = createPeerConnection(participantId);
            console.log(`Creating offer for ${participantId}`);
            
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            
            await pc.setLocalDescription(offer);
            console.log(`Local description set for ${participantId}, sending offer`);
            
            sendMessage({ 
                type: 'offer', 
                offer: offer, 
                to: participantId 
            });
        } catch (error) {
            console.error(`Error creating offer for ${participantId}:`, error);
        }
    };

    const handleOffer = async (offer, participantId) => {
        try {
            const pc = createPeerConnection(participantId);
            console.log(`Handling offer from ${participantId}`);
            
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            console.log(`Remote description set for ${participantId}`);
            
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            console.log(`Created and set local description (answer) for ${participantId}`);
            
            sendMessage({ 
                type: 'answer', 
                answer: answer, 
                to: participantId 
            });
        } catch (error) {
            console.error(`Error handling offer from ${participantId}:`, error);
        }
    };

    const handleAnswer = async (answer, participantId) => {
        const pc = peerConnections[participantId];
        if (pc) {
            try {
                console.log(`Handling answer from ${participantId}`);
                await pc.setRemoteDescription(new RTCSessionDescription(answer));
                console.log(`Remote description (answer) set for ${participantId}`);
            } catch (error) {
                console.error(`Error handling answer from ${participantId}:`, error);
            }
        } else {
            console.error(`No peer connection found for ${participantId} when handling answer`);
        }
    };

    const handleIceCandidate = async (candidate, participantId) => {
        const pc = peerConnections[participantId];
        if (pc && candidate) {
            try {
                // Wait for remote description to be set before adding ICE candidates
                if (pc.remoteDescription) {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                    console.log(`Added ICE candidate from ${participantId}`);
                } else {
                    console.log(`Queueing ICE candidate from ${participantId} - remote description not set yet`);
                    // Store candidate to add later when remote description is set
                    if (!pc.pendingCandidates) {
                        pc.pendingCandidates = [];
                    }
                    pc.pendingCandidates.push(candidate);
                    
                    // Check again after a short delay
                    setTimeout(async () => {
                        if (pc.remoteDescription && pc.pendingCandidates) {
                            for (const pendingCandidate of pc.pendingCandidates) {
                                try {
                                    await pc.addIceCandidate(new RTCIceCandidate(pendingCandidate));
                                    console.log(`Added queued ICE candidate from ${participantId}`);
                                } catch (err) {
                                    console.error(`Error adding queued ICE candidate:`, err);
                                }
                            }
                            pc.pendingCandidates = [];
                        }
                    }, 100);
                }
            } catch(error) {
                console.error(`Error adding ICE candidate from ${participantId}:`, error);
            }
        } else if (!pc) {
            console.error(`No peer connection found for ${participantId} when handling ICE candidate`);
        }
    };

    const handleUserLeft = (participantId) => {
        console.log(`Handling user left: ${participantId}`);
        
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
    const handleRemoteTrack = (participantId, track) => {
        console.log(`Handling remote track from ${participantId}: ${track.kind}`);
        
        let videoContainer = document.getElementById(`video-container-${participantId}`);
        if (!videoContainer) {
            console.log(`Creating video container for ${participantId}`);
            videoContainer = document.createElement('div');
            videoContainer.id = `video-container-${participantId}`;
            videoContainer.className = 'video-container relative rounded-lg overflow-hidden bg-gray-700 shadow-lg';

            const video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.muted = false;  // Don't mute remote video elements
            video.className = 'w-full h-full object-cover';
            video.srcObject = new MediaStream();

            // Separate audio element for better audio handling
            const audio = document.createElement('audio');
            audio.autoplay = true;
            audio.controls = false;
            audio.muted = false;
            audio.srcObject = new MediaStream();

            const nameTag = document.createElement('div');
            nameTag.className = 'absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-sm px-2 py-1 rounded-md';
            nameTag.textContent = remoteParticipants[participantId]?.username || 'Guest';

            videoContainer.appendChild(video);
            videoContainer.appendChild(audio);
            videoContainer.appendChild(nameTag);
            videoGrid.appendChild(videoContainer);
            updateGridLayout();
        }

        // Add track to the appropriate media element
        if (track.kind === 'video') {
            const videoElement = videoContainer.querySelector('video');
            videoElement.srcObject.addTrack(track);
            videoElement.play().catch(e => console.log('Video play failed:', e));
        } else if (track.kind === 'audio') {
            const audioElement = videoContainer.querySelector('audio');
            audioElement.srcObject.addTrack(track);
            audioElement.play().catch(e => console.log('Audio play failed:', e));
        }
    };

    const removeRemoteVideo = (participantId) => {
        const container = document.getElementById(`video-container-${participantId}`);
        if (container) {
            const videoElement = container.querySelector('video');
            const audioElement = container.querySelector('audio');
            
            if (videoElement && videoElement.srcObject) {
                videoElement.srcObject.getTracks().forEach(track => track.stop());
            }
            if (audioElement && audioElement.srcObject) {
                audioElement.srcObject.getTracks().forEach(track => track.stop());
            }
            
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
                // Don't automatically create offers here - wait for user-joined message
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