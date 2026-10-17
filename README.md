# Spendwise

A personal budgeting app with accounts, monthly category budgets, transaction tracking, recurring-payment reminders, and spending reports. It uses Express and PostgreSQL.

## Run locally with Docker

1. Install Docker and Docker Compose.
2. From this folder, start the app and database:

   ```sh
   docker compose -f zenith-compose.yml up --build
   ```

3. Open [http://localhost:3000](http://localhost:3000), create an account, and add an account such as checking or savings.

The database is persisted in a Docker volume. To choose a stronger database password, create a `.env` file with:

```env
POSTGRES_PASSWORD=choose-a-long-random-password
```

Keep the same password for subsequent runs, since it is used to connect to the existing database volume.

## Run with a PostgreSQL server already installed

Requires Node.js 22 or newer and PostgreSQL. Create a database and set `DATABASE_URL`, then run:

```sh
npm install
python -m pip install -r model/requirements.txt
```

In one terminal, start the predictor:

```sh
python model/serve.py
```

In another terminal, start Spendwise with your PostgreSQL connection:

```sh
DATABASE_URL=postgres://username:password@localhost:5432/spendwise \
PREDICTOR_URL=http://127.0.0.1:5000 npm start
```

The server creates its tables at startup. `npm run dev` can replace `npm start`.

## Features

- Email/password signup and login with hashed passwords and server-side sessions.
- Multiple accounts with starting balances; balances update from recorded income, expenses, and transfers.
- Monthly budgets by category, with remaining amounts and overspending indicators.
- Income, expense, and account-to-account transfer transactions.
- Monthly totals and a per-category spending report.
- Recurring schedule reminders for regular income and expenses. Schedules do not automatically create transactions.
- Investment recommendations from the supplied scikit-learn model. Open **Investment advice** in the sidebar and select **Predict investment**; account history prefills annual income, average monthly expenses, investment-account balance, and debt-account balance.

## Investment predictions

The predictor runs as an internal Python service in Docker Compose. The model artifact must be at `model/investment_recommender.joblib`; do not use joblib/pickle files from an untrusted source.

The model pipeline expects 15 fields: age, annual income, dependents, credit score, total debt, monthly expenses, emergency-fund months, investment portfolio, time horizon, target amount, risk tolerance, trust in institutions, employment status, marital status, and primary goal. Spendwise prefills annual income and average monthly expenses from income/expense transactions in the last 12 months, excluding future-dated transactions. It annualizes/averages over the months represented by the transaction history (up to 12), and displays that coverage. Investment portfolio is derived from current investment-account balances; debt is derived from negative credit/loan account balances. Budgets, schedules, and transfers are not counted as income or expenses. The estimates can be edited before prediction.

The selected-month Reports view is a separate calendar-month summary; it is not used directly as a model input because the model requires annual income and monthly expense estimates. Demographic/profile inputs are saved after a successful prediction and reused on later visits. Other columns in the training CSV, including the target and post-session fields, are not model inputs.
