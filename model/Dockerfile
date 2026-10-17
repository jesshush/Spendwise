FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY serve.py ./
COPY investment_recommender.joblib ./investment_recommender.joblib
EXPOSE 5000
CMD ["python", "-u", "serve.py"]
