# Live Meeting Transcription

A Chrome extension for real-time transcription of Google Meet meetings using Whisper.

# Architecture

The extension consists of three main components:
1. Background script
2. Content script
3. Popup UI

# Design

The extension uses Material Design principles.

## Setup

1. Clone the repository.
2. Place your Whisper model file in the `models/` directory.
3. Build and run the Docker container:
   ```bash
   docker-compose up --build

# User Guide

1. Install the extension.
2. Open Google Meet.
3. Click the transcription button.

# Internationalization

Use i18next for translations.

# Privacy

We do not collect or store any user data.