# bluesky-bot console (run.py -> backend/app.py) + real Google Chrome.
#
# Chrome opens headed on the VM's webtop desktop: the desktop's X socket is
# mounted in at /tmp/.X11-unix and DISPLAY points at it (see docker-compose.yml
# and docker/entrypoint.sh). No display server of its own in this image.
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        curl ca-certificates procps tzdata \
        fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
 && curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY . .
RUN sed -i 's/\r$//' docker/entrypoint.sh && chmod +x docker/entrypoint.sh \
 && mkdir -p /app/profiles backend/data

ENV PYTHONUNBUFFERED=1 \
    XBOT_HOST=0.0.0.0 \
    XBOT_PORT=4300 \
    XBOT_HEADLESS=0 \
    XBOT_NO_BROWSER=1 \
    XBOT_BROWSER_CHANNEL=chrome \
    XBOT_PROFILE_CACHE=/app/profiles \
    DISPLAY=:1

EXPOSE 4300

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["python", "run.py"]
