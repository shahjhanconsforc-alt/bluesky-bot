# bluesky-bot console (run.py -> backend/app.py) + real Google Chrome.
#
# Chrome opens headed on a virtual X display inside this container (Xvfb), and
# that display is served to a browser by noVNC on :6080 - the bot's "desktop".
# No webtop: on the shared KVM host a 6 GB desktop image per VM does not fit.
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        curl ca-certificates procps tzdata \
        xvfb x11vnc fluxbox novnc websockify \
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
    XBOT_BROWSER_CHANNEL=chrome \
    XBOT_PROFILE_CACHE=/app/profiles \
    DISPLAY=:1 \
    SCREEN=1600x900x24

EXPOSE 4300 6080

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["python", "run.py"]
