# Build stage
FROM golang:1.23.6 AS builder

# Install comprehensive build dependencies including cmake
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    cmake \
    pkg-config \
    libtool \
    autoconf \
    automake \
    libopenblas-dev \
    # Additional dependencies that might be needed
    libsndfile1-dev \
    libfftw3-dev \
    && rm -rf /var/lib/apt/lists/*

# Clone whisper.cpp
WORKDIR /src
RUN git clone https://github.com/ggerganov/whisper.cpp.git

# Build whisper.cpp using CMake for better dependency management
WORKDIR /src/whisper.cpp
# First create build directory and generate CMake files
RUN mkdir -p build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release \
          -DBUILD_SHARED_LIBS=ON \
          -DWHISPER_BUILD_EXAMPLES=OFF \
          -DWHISPER_BUILD_TESTS=OFF \
          .. && \
    # Build the library
    cmake --build . --config Release && \
    # Install to system paths for easier integration
    cmake --install . --prefix /usr/local

# Copy Go application source
WORKDIR /app
COPY . .

# Set environment variables to help Go find the whisper library
ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig
ENV LD_LIBRARY_PATH=/usr/local/lib:$LD_LIBRARY_PATH
ENV C_INCLUDE_PATH=/usr/local/include:$C_INCLUDE_PATH
ENV CPLUS_INCLUDE_PATH=/usr/local/include:$CPLUS_INCLUDE_PATH

# Build the Go application with appropriate CGO flags
# These paths refer to where CMake installed the headers and libraries
RUN CGO_CFLAGS="-I/usr/local/include" \
    CGO_LDFLAGS="-L/usr/local/lib -lwhisper" \
    go build -v -o whisper-server

# Runtime stage - use a newer Debian or Ubuntu base image
FROM debian:bookworm-slim

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libopenblas64-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy built executable from builder stage
COPY --from=builder /app/whisper-server /app/

# Copy ALL shared libraries from the builder stage
COPY --from=builder /usr/local/lib/lib*.so* /usr/local/lib/

# Copy include files
COPY --from=builder /usr/local/include/whisper.h /usr/local/include/

# Copy your custom model file
COPY models/ggml-large-v3-turbo-q5_0.bin /app/models/

# Configure library paths
ENV LD_LIBRARY_PATH=/usr/local/lib:$LD_LIBRARY_PATH

# Command to run the server
CMD ["./whisper-server"]