// Content script wrapped in IIFE to avoid global namespace pollution
(function() {

  // --- COMBINED STATE ---
  const state = {
      activeTab: null,       // Still relevant for tracking the active Meet tab
      socket: null,          // WebSocket connection
      connected: false,      // Connection status
      settings: null,       // User settings
      transcriptionActive: false,
      audioContext: null,
      processor: null,
      mediaStream: null,
      controlsInjected: false, // Flag for UI injection
      overlay: null,          // Transcription overlay
      transcriptionButton: null // The button element
  };

  // --- HELPER FUNCTIONS (Moved from background.js) ---

  // Process audio data (no changes needed)
  function processAudio(audioProcessingEvent, socket) {
      if (socket.readyState !== WebSocket.OPEN) return;

      const inputBuffer = audioProcessingEvent.inputBuffer;
      const inputData = inputBuffer.getChannelData(0);

      const pcmData = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 32768 : s * 32767;
      }
      socket.send(pcmData.buffer);
  }

  // Connect to WebSocket (adapted for content script)
  function connectWebSocket(stream, tabId) {
      console.log("Connecting to WebSocket server:", state.settings.serverUrl);
      state.socket = new WebSocket(state.settings.serverUrl);

      state.socket.addEventListener('open', () => {
          state.connected = true;
          console.log('Connected to Whisper WebSocket server');

          if (!state.audioContext) {
              state.audioContext = new AudioContext();
          }
          const source = state.audioContext.createMediaStreamSource(stream);
          const bufferSize = 4096;
          state.processor = state.audioContext.createScriptProcessor(bufferSize, 1, 1);
          state.processor.onaudioprocess = (e) => processAudio(e, state.socket);
          source.connect(state.processor);
          state.processor.connect(state.audioContext.destination);

          if (state.settings.language) {
              state.socket.send(`language:${state.settings.language}`);
          }
      });

      state.socket.addEventListener('message', (event) => {
          console.log('Received transcription:', event.data);
          updateTranscript(event.data); // Use the content script function
      });

      state.socket.addEventListener('close', () => {
          state.connected = false;
          console.log('Disconnected from Whisper WebSocket server');
          // No need to send message to self, we're in the content script
      });

      state.socket.addEventListener('error', (error) => {
          console.error('WebSocket error:', error);
           // No need to send message to self, we're in the content script
      });
  }


  // Stop transcription (adapted for content script)
  function stopTranscription() {
      if (!state.transcriptionActive) return;

      console.log("Stopping transcription...");
      if (state.socket) {
          state.socket.close();
          state.socket = null;
      }

      state.connected = false;
      state.transcriptionActive = false;

      // No need to send message, we're already in the content script
      removeTranscriptionOverlay();

      if (state.processor) {
          state.processor.disconnect();
          state.processor = null;
      }
      if (state.audioContext) {
          state.audioContext.close();
          state.audioContext = null;
      }
      if (state.mediaStream) {
          state.mediaStream.getTracks().forEach(track => track.stop());
          state.mediaStream = null;
      }
  }

   // --- CONTENT SCRIPT LOGIC (Adapted) ---
  // Start transcription (adapted for combined script)
  async function startTranscription() {
    if (state.transcriptionActive) {
      console.log("Transcription already active");
      return;
  }

  try {
      console.log("Starting transcription... Requesting Permissions");

      // Request permissions (important, as discussed before)
      chrome.permissions.request({ permissions: ['tabCapture'] }, async (granted) => {
          if (granted) {
              console.log("Tab Capture permission granted");
              const stream = await chrome.tabCapture.capture({ audio: true, video: false });
              if (!stream) {
                  console.error('Failed to capture tab audio - stream is null');
                   updateTranscript("Error: Failed to capture audio."); // Show error in UI
                  return;
              }
              console.log("captured stream", stream)

              state.mediaStream = stream;
              connectWebSocket(stream, state.activeTab); //  `tabId` is now `state.activeTab`
              state.transcriptionActive = true;
              // No need to send message, we're already in the content script
          } else {
              console.error("Tab Capture Permission Denied!");
              updateTranscript("Error: Permission Denied"); // Show error in UI

          }
      });
  } catch (error) {
      console.error('Failed to start transcription:', error);
      updateTranscript("Error: " + error.message); // Show error in UI

  }
}


  // --- UI-RELATED FUNCTIONS (From original content.js) ---

  function waitForMeetInterface() {
      const observer = new MutationObserver(() => {
          const controls = document.querySelector('[data-is-muted]')?.parentElement;
          if (controls && !state.controlsInjected) {
              console.log("Google Meet controls found, injecting transcription button");
              injectTranscriptionControls(controls);
              observer.disconnect();
          }
      });

      observer.observe(document, { childList: true, subtree: true });
  }

  function injectTranscriptionControls(controls) {
      const buttonContainer = document.createElement('div');
      buttonContainer.className = 'transcription-button-container';

      const button = document.createElement('button');
      button.className = 'transcription-button';
      button.setAttribute('data-tooltip', 'Start Transcription');

      const icon = document.createElement('img');
      icon.src = chrome.runtime.getURL('icons/microphone.svg');
      icon.alt = 'Transcribe';
      button.appendChild(icon);

      button.addEventListener('click', toggleTranscription);

      buttonContainer.appendChild(button);
      controls.appendChild(buttonContainer);

      state.transcriptionButton = button;
      state.controlsInjected = true;
      console.log("Transcription button injected");
  }

  function toggleTranscription() {
      state.transcribing = !state.transcribing;

      if (state.transcribing) {
          state.transcriptionButton.setAttribute('data-tooltip', 'Stop Transcription');
          startTranscription(); // Call the combined startTranscription
          createTranscriptionOverlay();
      } else {
          state.transcriptionButton.setAttribute('data-tooltip', 'Start Transcription');
          stopTranscription();  // Call the combined stopTranscription
          removeTranscriptionOverlay();
      }
  }

  function createTranscriptionOverlay() {
      state.overlay = document.createElement('div');
      state.overlay.id = 'transcription-overlay';
      state.overlay.innerHTML = `
          <div class="header">
              <h3>Live Transcription</h3>
              <button class="close-button">
                  <img src="${chrome.runtime.getURL('icons/close.svg')}" alt="Close">
              </button>
          </div>
          <div class="transcript-container"></div>
      `;

      document.body.appendChild(state.overlay);
      state.overlay.querySelector('.close-button').addEventListener('click', toggleTranscription);
      console.log("Transcription overlay created");
  }

  function updateTranscript(text) {
      if (!state.overlay) return;

      const container = state.overlay.querySelector('.transcript-container');
      const entry = document.createElement('div');
      entry.className = 'transcript-entry';
      entry.textContent = text;

      container.appendChild(entry);
      container.scrollTop = container.scrollHeight;
      console.log("Transcript updated:", text);
  }


  function removeTranscriptionOverlay() {
      if (state.overlay) {
          state.overlay.remove();
          state.overlay = null;
          console.log("Transcription overlay removed");
      }
  }


  // --- MESSAGE HANDLING (Adapted) ---

  function handleMessage(message, sender, sendResponse) {
      console.log("Content script received message:", message);
      switch (message.type) {
          case 'get_connection_status':
              sendResponse({ connected: state.connected });
              return true; // Keep the message channel open for async response

          case 'settings_updated':
              state.settings = message.settings;
              return true; // Acknowledge receipt

          // These cases are no longer needed, as the actions happen directly:
          // case 'start_transcription':
          // case 'stop_transcription':
          // case 'audio_data':
          case 'transcription_result': //updateTranscript is now being called directly by websocket
               updateTranscript(message.text);
               break;
          case 'transcription_started':
              state.transcriptionButton.classList.add('active');
               break;
          case 'transcription_stopped':
              state.transcriptionButton.classList.remove('active');
              removeTranscriptionOverlay();
               break;
           case 'transcription_error': // Log and potentially show error in UI.
               console.error("Transcription error:", message.error);
               updateTranscript("Error: " + message.error);
              break;
      }
  }

  // --- INITIALIZATION ---

  async function init() {
      console.log("Content script initialized");

      // Load settings
      const data = await chrome.storage.sync.get('settings');
      state.settings = data.settings || {
          serverUrl: 'ws://localhost:8080/ws',
          language: '',
          autoStart: false
      };
        // Get the current tab ID.  VERY IMPORTANT for tabCapture.
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
          if (tabs && tabs[0]) {
              state.activeTab = tabs[0].id;
               // Listen for messages (from popup, primarily)
              chrome.runtime.onMessage.addListener(handleMessage);
              // Start waiting for the Meet UI
              waitForMeetInterface();

          } else {
              console.error("Could not get current tab ID");
          }
      });
  }

  init(); // Call the initialization function

})();