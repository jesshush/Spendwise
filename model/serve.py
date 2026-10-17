import json
import math
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import joblib
import pandas as pd


MODEL_PATH = Path(
    os.environ.get(
        "MODEL_PATH",
        str(Path(__file__).with_name("investment_recommender.joblib")),
    )
)
NUMERIC_FIELDS = (
    "age",
    "annual_income_usd",
    "dependents_count",
    "credit_score",
    "total_debt_usd",
    "monthly_expenses_usd",
    "emergency_fund_months",
    "investment_portfolio_usd",
    "time_horizon_years",
    "target_amount_usd",
    "risk_tolerance_1_10",
    "trust_in_institutions_1_10",
)
CATEGORICAL_FIELDS = ("employment_status", "marital_status", "primary_goal")
FEATURES = NUMERIC_FIELDS + CATEGORICAL_FIELDS
EXPECTED_FEATURES = set(FEATURES)


def load_artifact():
    if not MODEL_PATH.is_file():
        raise FileNotFoundError(f"Model file not found: {MODEL_PATH}")
    artifact = joblib.load(MODEL_PATH)
    if not isinstance(artifact, dict) or not {"pipeline", "features", "target"} <= artifact.keys():
        raise ValueError("Model file must contain pipeline, features, and target entries.")
    if artifact["target"] != "recommended_products":
        raise ValueError("Model target must be recommended_products.")
    features = artifact["features"]
    if not isinstance(features, list) or set(features) != EXPECTED_FEATURES:
        raise ValueError("Model input features do not match the supported profile fields.")
    return artifact


artifact = load_artifact()
model = artifact["pipeline"]
FEATURES = tuple(artifact["features"])


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            return self.send_json(404, {"error": "Endpoint not found."})
        self.send_json(200, {"status": "ok"})

    def do_POST(self):
        if self.path != "/predict":
            return self.send_json(404, {"error": "Endpoint not found."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 32768:
                return self.send_json(400, {"error": "Invalid request size."})
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict) or any(name not in payload for name in FEATURES):
                return self.send_json(400, {"error": "All model input fields are required."})
            row = {name: payload[name] for name in FEATURES}
            for name in NUMERIC_FIELDS:
                if (isinstance(row[name], bool) or not isinstance(row[name], (int, float))
                        or not math.isfinite(row[name])):
                    return self.send_json(400, {"error": f"{name} must be a number."})
            if any(not isinstance(row[name], str) or not row[name].strip() for name in CATEGORICAL_FIELDS):
                return self.send_json(400, {"error": "Categorical model inputs must be non-empty text."})

            frame = pd.DataFrame([row], columns=FEATURES)
            recommendation = str(model.predict(frame)[0])
            if hasattr(model, "predict_proba"):
                probabilities = model.predict_proba(frame)[0]
                ranked = sorted(
                    zip(model.classes_, probabilities),
                    key=lambda item: float(item[1]),
                    reverse=True,
                )
                alternatives = [
                    {"recommendation": str(label), "confidence": float(probability)}
                    for label, probability in ranked[1:3]
                ]
                confidence = next(
                    float(probability) for label, probability in ranked if str(label) == recommendation
                )
            else:
                alternatives = []
                confidence = 1.0
            self.send_json(
                200,
                {
                    "recommendation": recommendation,
                    "confidence": confidence,
                    "alternatives": alternatives,
                },
            )
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError, TypeError) as error:
            self.send_json(400, {"error": f"Invalid prediction input: {error}"})
        except Exception as error:
            print(f"Prediction failed: {error}", flush=True)
            self.send_json(500, {"error": "The model failed to produce a prediction."})

    def log_message(self, format_string, *args):
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 5000), Handler)
    print("Investment prediction service listening on port 5000", flush=True)
    server.serve_forever()
