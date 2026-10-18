FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY model/requirements.txt ./model/requirements.txt
RUN python3 -m venv /opt/predictor-venv \
    && /opt/predictor-venv/bin/pip install --no-cache-dir -r model/requirements.txt
COPY server.js ./
COPY public ./public
COPY model/serve.py ./model/serve.py
COPY model/investment_recommender.joblib ./model/investment_recommender.joblib
EXPOSE 3000
CMD ["node", "server.js"]
