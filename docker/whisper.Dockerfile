FROM fedirz/faster-whisper-server:0.6.0-rc.3-cpu
USER root
# Docker initializes a new named volume with this directory's ownership.
RUN mkdir -p /models && chown ubuntu:ubuntu /models
USER ubuntu
