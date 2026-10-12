FROM ghcr.io/osgeo/gdal:ubuntu-small-3.8.5
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv python3-pip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN python3 -m venv --system-site-packages /opt/venv
ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1
COPY pyproject.toml ./
COPY hail ./hail
RUN pip install --no-cache-dir .
CMD ["python", "-m", "hail.main"]
