# syntax=docker/dockerfile:1.7
# GPU image: MODEL_BACKEND=local (BiRefNet + Real-ESRGAN x2/x4 + OpenCV EAST), weights baked in.
#   docker build -t vio-gpu-service .
#   docker run --gpus all -p 8000:8000 -e GPU_SERVICE_SECRET=... vio-gpu-service
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

# Pin BiRefNet to a commit hash in production (the value is also used at runtime, offline).
ARG BIREFNET_REVISION=main
ARG EAST_URL="https://www.dropbox.com/s/r2ingd0l3zt8hxs/frozen_east_text_detection.tar.gz?dl=1"
ARG EAST_SHA256=9b486f3c3eee77b4c8cc91a83892c37026cca7d29b79bf3b93772ccd2db58454
ARG REALESRGAN_X4_URL=https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
ARG REALESRGAN_X4_SHA256=4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1
ARG REALESRGAN_X2_URL=https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth
ARG REALESRGAN_X2_SHA256=49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends software-properties-common gnupg ca-certificates curl \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3.11 python3.11-venv libgomp1 \
 && apt-get purge -y --auto-remove software-properties-common gnupg \
 && rm -rf /var/lib/apt/lists/*

RUN python3.11 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

RUN useradd --system --uid 10001 --create-home --home-dir /home/app app \
 && mkdir -p /models /srv \
 && chown app:app /models /srv

WORKDIR /srv
COPY requirements.txt requirements-gpu.txt ./
RUN pip install --upgrade pip && pip install -r requirements-gpu.txt

# Weights are downloaded as the runtime user so no chown layer duplicates them.
ENV MODELS_DIR=/models \
    HF_HOME=/models/hf \
    BIREFNET_REVISION=${BIREFNET_REVISION}
USER app
RUN curl -fsSL --retry 3 -o /models/RealESRGAN_x4plus.pth "${REALESRGAN_X4_URL}" \
 && echo "${REALESRGAN_X4_SHA256}  /models/RealESRGAN_x4plus.pth" | sha256sum -c - \
 && curl -fsSL --retry 3 -o /models/RealESRGAN_x2plus.pth "${REALESRGAN_X2_URL}" \
 && echo "${REALESRGAN_X2_SHA256}  /models/RealESRGAN_x2plus.pth" | sha256sum -c - \
 && curl -fsSL --retry 3 -o /tmp/east.tar.gz "${EAST_URL}" \
 && tar -xzf /tmp/east.tar.gz -C /models frozen_east_text_detection.pb \
 && echo "${EAST_SHA256}  /models/frozen_east_text_detection.pb" | sha256sum -c - \
 && rm /tmp/east.tar.gz \
 && python -c "from huggingface_hub import snapshot_download; snapshot_download('ZhengPeng7/BiRefNet', revision='${BIREFNET_REVISION}')"

COPY --chown=app:app app ./app

ENV MODEL_BACKEND=local \
    EAST_MODEL_PATH=/models/frozen_east_text_detection.pb \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--timeout-keep-alive", "75"]
