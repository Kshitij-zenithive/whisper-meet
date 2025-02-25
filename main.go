// main.go
package main

import (
	"context"
	"encoding/binary"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/ggerganov/whisper.cpp/bindings/go/pkg/whisper"
	"github.com/gorilla/websocket"
)

// Application constants
const (
	SampleRate         = 16000 // Whisper expects 16kHz audio
	AudioChannels      = 1     // Mono audio
	BitsPerSample      = 16    // 16-bit PCM
	AudioChunkDuration = 2 * time.Second
)

// Config holds the application configuration
type Config struct {
	ModelPath  string // Path to the Whisper model
	ListenAddr string // Address to listen on
	Language   string // Language code
}

// WhisperContext wraps the Whisper context and model
type WhisperContext struct {
	Model   whisper.Model
	Context whisper.Context
}

// AppState holds the application state
type AppState struct {
	config   Config
	upgrader websocket.Upgrader
	contexts sync.Pool
}

func main() {
	// Parse command line flags
	config := parseFlags()
	fmt.Printf("Starting server with model: %s on addr: %s\n", config.ModelPath, config.ListenAddr)

	// Validate that the model file exists
	if _, err := os.Stat(config.ModelPath); os.IsNotExist(err) {
		log.Fatalf("Model file not found at %s. Download models from https://huggingface.co/ggerganov/whisper.cpp", config.ModelPath)
	}

	// Initialize application state
	app := &AppState{
		config: config,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}

	// Initialize the model pool
	app.contexts = sync.Pool{
		New: func() interface{} {
			// Load the model
			model, err := whisper.New(config.ModelPath)
			if err != nil {
				log.Printf("ERROR: Failed to load model: %v", err)
				return nil
			}

			// Create an initial context
			ctx, err := model.NewContext()
			if err != nil {
				log.Printf("ERROR: Failed to create context: %v", err)
				model.Close()
				return nil
			}

			// Configure the context if a language was specified
			if config.Language != "" {
				if err := ctx.SetLanguage(config.Language); err != nil {
					log.Printf("WARNING: Failed to set language to %s: %v", config.Language, err)
				}
			}

			return &WhisperContext{
				Model:   model,
				Context: ctx,
			}
		},
	}

	// Set up HTTP routes
	http.HandleFunc("/ws", app.handleWebSocket)

	// Create server with graceful shutdown
	server := &http.Server{
		Addr:    config.ListenAddr,
		Handler: http.DefaultServeMux,
	}

	// Listen for interrupt signal
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	// Start server in a goroutine
	go func() {
		log.Printf("Server listening on %s", config.ListenAddr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Wait for interrupt signal
	<-stop
	log.Println("Shutting down server...")

	// Create a deadline for graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Attempt graceful shutdown
	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server gracefully stopped")
}

// parseFlags parses the command line flags and returns the configuration
func parseFlags() Config {
	var config Config
	flag.StringVar(&config.ModelPath, "model", filepath.Join("models", "ggml-large-v3-turbo-q5_0.bin"), "Path to the Whisper model file")
	flag.StringVar(&config.ListenAddr, "addr", ":8080", "Address to listen on")
	flag.StringVar(&config.Language, "lang", "", "Language code (leave empty for auto-detection)")
	flag.Parse()
	return config
}

// handleWebSocket handles WebSocket connections
func (app *AppState) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade HTTP connection to WebSocket
	conn, err := app.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer func() {
		err := conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
		if err != nil {
			log.Printf("Error during closing websocket: %v", err)
		}
		conn.Close()
	}()

	log.Println("Client connected")

	// Get a Whisper context from the pool
	ctxInterface := app.contexts.Get()
	if ctxInterface == nil {
		log.Println("ERROR: Failed to get a Whisper context from the pool")
		conn.WriteMessage(websocket.TextMessage, []byte("Error: Server unable to process audio"))
		return
	}
	whisperCtx := ctxInterface.(*WhisperContext)
	defer app.contexts.Put(whisperCtx)

	// Buffer to accumulate audio data
	audioBuffer := make([]float32, 0, int(AudioChunkDuration.Seconds()*SampleRate))

	// Process messages from the client
	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		if messageType == websocket.BinaryMessage {
			// Process binary audio data
			samples := len(message) / (BitsPerSample / 8)
			for i := 0; i < samples; i++ {
				value := binary.LittleEndian.Uint16(message[i*2 : (i+1)*2])
				audioBuffer = append(audioBuffer, float32(int16(value))/32768.0)
			}

			// Process audio when we have enough data
			if len(audioBuffer) >= int(AudioChunkDuration.Seconds()*SampleRate) {
				if err := whisperCtx.Context.Process(audioBuffer, nil, nil); err != nil {
					log.Printf("ERROR: Whisper processing failed: %v", err)
					conn.WriteMessage(websocket.TextMessage, []byte("Error: Server unable to process audio"))
				}

				var segments []string
				for {
					segment, err := whisperCtx.Context.NextSegment()
					if err != nil {
						break // No more segments
					}
					segments = append(segments, segment.Text)
				}

				if len(segments) > 0 {
					combinedText := ""
					for _, segment := range segments {
						combinedText += segment + " "
					}
					log.Printf("Sending transcription: %s", combinedText)
					if err := conn.WriteMessage(websocket.TextMessage, []byte(combinedText)); err != nil {
						log.Printf("Write error: %v", err)
						break
					}
				}

				// Clear the buffer for the next chunk
				audioBuffer = audioBuffer[:0]
			}
		} else if messageType == websocket.TextMessage {
			// Handle text messages for commands or metadata
			cmd := string(message)
			log.Printf("Received text command: %s", cmd)
			switch cmd {
			case "reset":
				// Reinitialize the Whisper context
				newCtx, err := whisperCtx.Model.NewContext()
				if err != nil {
					log.Printf("ERROR: Failed to create new context: %v", err)
					conn.WriteMessage(websocket.TextMessage, []byte("Error: Reset failed"))
					continue
				}
				whisperCtx.Context = newCtx
				log.Println("Context reset successfully")
				conn.WriteMessage(websocket.TextMessage, []byte("Transcription reset"))
			default:
				// Handle other commands or ignore unknown commands
				log.Printf("Unknown command: %s", cmd)
				conn.WriteMessage(websocket.TextMessage, []byte("Unknown command"))
			}
		}
	}

	log.Println("Client disconnected")
}
