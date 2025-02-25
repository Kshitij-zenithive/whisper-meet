// Popup script with proper connection status handling
document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const statusCircle = document.getElementById('status-circle');
  const statusText = document.getElementById('status-text');
  const serverUrlInput = document.getElementById('server-url');
  const languageSelect = document.getElementById('language');
  const autoStartCheckbox = document.getElementById('auto-start');
  const saveSettingsButton = document.getElementById('save-settings');
  const testConnectionButton = document.getElementById('test-connection');

  // Default settings
  const DEFAULT_SETTINGS = {
    serverUrl: 'ws://localhost:8080/ws',
    language: '',
    autoStart: false
  };

  // Load saved settings
  await loadSettings();
  await updateConnectionStatus();

  // Function to update connection status
  async function updateConnectionStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'get_connection_status' });
      updateStatusUI(response.connected ? 'connected' : 'disconnected',
                    response.connected ? 'Connected' : 'Not connected');
    } catch (error) {
      updateStatusUI('disconnected', 'Not connected');
    }
  }

  // Function to update status UI
  function updateStatusUI(status, message) {
    statusCircle.className = 'status-circle ' + status;
    statusText.textContent = message;
  }

  // Function to load settings
  async function loadSettings() {
    const data = await chrome.storage.sync.get('settings');
    const settings = data.settings || DEFAULT_SETTINGS;

    serverUrlInput.value = settings.serverUrl;
    languageSelect.value = settings.language;
    autoStartCheckbox.checked = settings.autoStart;
  }

  // Event Listeners
  saveSettingsButton.addEventListener('click', async () => {
    const settings = {
      serverUrl: serverUrlInput.value.trim() || DEFAULT_SETTINGS.serverUrl,
      language: languageSelect.value,
      autoStart: autoStartCheckbox.checked
    };

    await chrome.storage.sync.set({ settings });
    chrome.runtime.sendMessage({ type: 'settings_updated', settings });

    saveSettingsButton.textContent = 'Saved!';
    setTimeout(() => {
      saveSettingsButton.textContent = 'Save Settings';
    }, 1500);
  });

  testConnectionButton.addEventListener('click', async () => {
    const serverUrl = serverUrlInput.value.trim() || DEFAULT_SETTINGS.serverUrl;
    updateStatusUI('connecting', 'Connecting...');

    try {
      const socket = new WebSocket(serverUrl);
      
      const timeout = setTimeout(() => {
        socket.close();
        updateStatusUI('disconnected', 'Connection timed out');
      }, 5000);

      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        updateStatusUI('connected', 'Connected successfully');
        setTimeout(() => socket.close(), 1000);
      });

      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        updateStatusUI('disconnected', 'Connection failed');
      });
    } catch (error) {
      updateStatusUI('disconnected', 'Invalid WebSocket URL');
    }
  });
});