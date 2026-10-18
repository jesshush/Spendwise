const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const express = require('express');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.PGSSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
});
const PORT = Number(process.env.PORT || 3000);
const PREDICTOR_URL = process.env.PREDICTOR_URL || 'http://127.0.0.1:5000';
const COOKIE_NAME = 'spendwise_session';
const SESSION_DAYS = 30;

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static('public'));

const DEFAULT_CATEGORIES = [
  ['Food', 'Usual Expenses', 'expense'],
  ['Restaurants', 'Usual Expenses', 'expense'],
  ['Entertainment', 'Usual Expenses', 'expense'],
  ['Clothing', 'Usual Expenses', 'expense'],
  ['General', 'Usual Expenses', 'expense'],
  ['Gift', 'Usual Expenses', 'expense'],
  ['Medical', 'Usual Expenses', 'expense'],
  ['Savings', 'Usual Expenses', 'expense'],
  ['Bills', 'Bills', 'expense'],
  ['Housing', 'Bills', 'expense'],
  ['Transport', 'Bills', 'expense'],
  ['Salary', 'Income', 'income'],
];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function cookieValue(req, name) {
  const entry = (req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return null;
  }
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function validMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function positiveAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && amount <= 1000000000;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validText(value, maxLength = 120) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

async function requireUser(req, res, next) {
  try {
    const token = cookieValue(req, COOKIE_NAME);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(401).json({ error: 'Please log in to continue.' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    if (!rows[0]) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Your session expired. Please log in again.' });
    }
    req.user = rows[0];
    return next();
  } catch (error) {
    return next(error);
  }
}

async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [tokenHash, userId],
  );
  setSessionCookie(res, token);
}

app.post('/api/signup', async (req, res, next) => {
  const { name, email, password } = req.body || {};
  if (!validText(name, 80) || typeof email !== 'string'
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Enter your name, a valid email, and a password with at least 8 characters.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name.trim(), email.trim().toLowerCase(), hashPassword(password)],
    );
    const user = rows[0];
    for (const [categoryName, groupName, type] of DEFAULT_CATEGORIES) {
      await client.query(
        'INSERT INTO categories (user_id, name, group_name, type) VALUES ($1, $2, $3, $4)',
        [user.id, categoryName, groupName, type],
      );
    }
    await client.query('COMMIT');
    await createSession(user.id, res);
    return res.status(201).json({ name: user.name, email: user.email });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'That email already has an account.' });
    return next(error);
  } finally {
    client.release();
  }
});

app.post('/api/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, password_hash FROM users WHERE email = $1',
      [email.trim().toLowerCase()],
    );
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Wrong email or password.' });
    }
    await createSession(user.id, res);
    return res.json({ name: user.name, email: user.email });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({ name: req.user.name, email: req.user.email });
});

app.post('/api/logout', async (req, res, next) => {
  try {
    const token = cookieValue(req, COOKIE_NAME);
    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/dashboard', requireUser, async (req, res, next) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  if (!validMonth(month)) return res.status(400).json({ error: 'Month must be in YYYY-MM format.' });
  try {
    const [accounts, categories, transactions, schedules, totals, report] = await Promise.all([
      pool.query(
        `SELECT a.id, a.name, a.type, a.starting_balance,
          a.starting_balance + COALESCE(SUM(
            CASE WHEN t.type = 'income' AND t.account_id = a.id THEN t.amount
                 WHEN t.type = 'expense' AND t.account_id = a.id THEN -t.amount
                 WHEN t.type = 'transfer' AND t.account_id = a.id THEN -t.amount
                 WHEN t.type = 'transfer' AND t.to_account_id = a.id THEN t.amount
                 ELSE 0 END
          ), 0) AS balance
         FROM accounts a LEFT JOIN transactions t
           ON (t.account_id = a.id OR t.to_account_id = a.id)
          AND t.user_id = a.user_id AND t.date <= CURRENT_DATE
         WHERE a.user_id = $1 GROUP BY a.id ORDER BY a.name`,
        [req.user.id],
      ),
      pool.query(
        `SELECT c.id, c.name, c.group_name, c.type,
          COALESCE(b.amount, 0) AS budgeted,
          COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'expense'), 0) AS spent,
          COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'income'), 0) AS earned
         FROM categories c
         LEFT JOIN budgets b ON b.category_id = c.id AND b.user_id = c.user_id AND b.month = $2::date
         LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = c.user_id
          AND t.date >= $2::date AND t.date < ($2::date + interval '1 month')
         WHERE c.user_id = $1
         GROUP BY c.id, b.amount ORDER BY c.group_name, c.name`,
        [req.user.id, `${month}-01`],
      ),
      pool.query(
        `SELECT t.id, t.description, t.amount, t.type, t.date, t.category_id,
          t.account_id, t.to_account_id, c.name AS category_name,
          a.name AS account_name, ta.name AS to_account_name
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN accounts ta ON ta.id = t.to_account_id
         WHERE t.user_id = $1 AND t.date >= $2::date AND t.date < ($2::date + interval '1 month')
         ORDER BY t.date DESC, t.id DESC LIMIT 100`,
        [req.user.id, `${month}-01`],
      ),
      pool.query(
        `SELECT s.id, s.name, s.amount, s.type, s.due_day, s.category_id, s.account_id,
          c.name AS category_name, a.name AS account_name
         FROM schedules s LEFT JOIN categories c ON c.id = s.category_id
         JOIN accounts a ON a.id = s.account_id
         WHERE s.user_id = $1 ORDER BY s.due_day, s.name`,
        [req.user.id],
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0) AS income,
          COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS spent
         FROM transactions WHERE user_id = $1 AND date >= $2::date
          AND date < ($2::date + interval '1 month')`,
        [req.user.id, `${month}-01`],
      ),
      pool.query(
        `SELECT c.name, c.group_name, c.type, COALESCE(SUM(t.amount), 0) AS amount
         FROM transactions t JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = $1 AND t.date >= $2::date AND t.date < ($2::date + interval '1 month')
         GROUP BY c.id ORDER BY amount DESC`,
        [req.user.id, `${month}-01`],
      ),
    ]);
    return res.json({
      month,
      accounts: accounts.rows,
      categories: categories.rows,
      transactions: transactions.rows,
      schedules: schedules.rows,
      totals: totals.rows[0],
      report: report.rows,
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/investment-profile', requireUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `WITH financial_activity AS (
        SELECT type, SUM(amount) AS total_amount, MIN(date) AS first_activity
        FROM transactions
        WHERE user_id = $1 AND type IN ('income', 'expense')
          AND date >= CURRENT_DATE - INTERVAL '12 months'
          AND date <= CURRENT_DATE
        GROUP BY type
      ),
      financial_estimates AS (
        SELECT
          COALESCE((
            SELECT total_amount * 12 / GREATEST(1, LEAST(12,
              date_part('year', age(CURRENT_DATE, first_activity)) * 12
              + date_part('month', age(CURRENT_DATE, first_activity)) + 1))
            FROM financial_activity WHERE type = 'income'
          ), 0) AS annual_income_usd,
          COALESCE((
            SELECT total_amount / GREATEST(1, LEAST(12,
              date_part('year', age(CURRENT_DATE, first_activity)) * 12
              + date_part('month', age(CURRENT_DATE, first_activity)) + 1))
            FROM financial_activity WHERE type = 'expense'
          ), 0) AS monthly_expenses_usd
      ),
      account_balances AS (
        SELECT a.id, a.type, a.starting_balance + COALESCE(SUM(
          CASE WHEN t.type = 'income' AND t.account_id = a.id THEN t.amount
               WHEN t.type = 'expense' AND t.account_id = a.id THEN -t.amount
               WHEN t.type = 'transfer' AND t.account_id = a.id THEN -t.amount
               WHEN t.type = 'transfer' AND t.to_account_id = a.id THEN t.amount
               ELSE 0 END
        ), 0) AS balance
        FROM accounts a LEFT JOIN transactions t
          ON (t.account_id = a.id OR t.to_account_id = a.id)
         AND t.user_id = a.user_id AND t.date <= CURRENT_DATE
        WHERE a.user_id = $1 GROUP BY a.id
      ),
      account_estimates AS (
        SELECT
          GREATEST(0, COALESCE(
            SUM(balance) FILTER (WHERE type = 'investment'), 0
          )) AS investment_portfolio_usd,
          COALESCE(SUM(ABS(balance)) FILTER (
            WHERE type IN ('credit', 'loan') AND balance < 0
          ), 0) AS total_debt_usd
        FROM account_balances
      )
      SELECT
        financial_estimates.annual_income_usd,
        financial_estimates.monthly_expenses_usd,
        COALESCE((
          SELECT LEAST(12, GREATEST(1,
            date_part('year', age(CURRENT_DATE, first_activity)) * 12
            + date_part('month', age(CURRENT_DATE, first_activity)) + 1))
          FROM financial_activity WHERE type = 'income'
        ), 0) AS income_history_months,
        COALESCE((
          SELECT LEAST(12, GREATEST(1,
            date_part('year', age(CURRENT_DATE, first_activity)) * 12
            + date_part('month', age(CURRENT_DATE, first_activity)) + 1))
          FROM financial_activity WHERE type = 'expense'
        ), 0) AS expense_history_months,
        account_estimates.investment_portfolio_usd,
        account_estimates.total_debt_usd,
        profile.age,
        profile.employment_status,
        profile.marital_status,
        profile.dependents_count,
        profile.credit_score,
        profile.emergency_fund_months,
        profile.primary_goal,
        profile.time_horizon_years,
        profile.target_amount_usd,
        profile.risk_tolerance_1_10,
        profile.trust_in_institutions_1_10
      FROM financial_estimates
      CROSS JOIN account_estimates
      LEFT JOIN investment_profiles profile ON profile.user_id = $1`,
      [req.user.id],
    );
    return res.json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/investment-prediction', requireUser, async (req, res, next) => {
  const input = req.body || {};
  const numericFields = [
    'age', 'annual_income_usd', 'dependents_count', 'credit_score', 'total_debt_usd',
    'monthly_expenses_usd', 'emergency_fund_months', 'investment_portfolio_usd',
    'time_horizon_years', 'target_amount_usd', 'risk_tolerance_1_10',
    'trust_in_institutions_1_10',
  ];
  const categoricalFields = ['employment_status', 'marital_status', 'primary_goal'];
  const allowedCategories = {
    employment_status: ['Retired', 'Salaried', 'Self-Employed', 'Student', 'Unemployed'],
    marital_status: ['Divorced', 'Married', 'Single', 'Widowed'],
    primary_goal: [
      'Business Investment', 'Debt Reduction', 'Education', 'Emergency Fund',
      'Estate Planning', 'Healthcare', 'Home Purchase', 'Retirement', 'Travel',
      'Wealth Accumulation',
    ],
  };
  if (numericFields.some((name) => typeof input[name] !== 'number' || !Number.isFinite(input[name]))
    || categoricalFields.some((name) => !allowedCategories[name].includes(input[name]))) {
    return res.status(400).json({ error: 'Complete all investment profile fields with valid values.' });
  }
  const ranges = [
    ['age', 0, 120], ['annual_income_usd', 0, 1000000000], ['dependents_count', 0, 100],
    ['credit_score', 300, 850], ['total_debt_usd', 0, 1000000000],
    ['monthly_expenses_usd', 0, 1000000000], ['emergency_fund_months', 0, 120],
    ['investment_portfolio_usd', 0, 1000000000], ['time_horizon_years', 0, 100],
    ['target_amount_usd', 0, 1000000000], ['risk_tolerance_1_10', 1, 10],
    ['trust_in_institutions_1_10', 1, 10],
  ];
  if (ranges.some(([name, min, max]) => input[name] < min || input[name] > max)
    || !Number.isInteger(input.age) || !Number.isInteger(input.dependents_count) || !Number.isInteger(input.credit_score)
    || !Number.isInteger(input.time_horizon_years) || !Number.isInteger(input.risk_tolerance_1_10)
    || !Number.isInteger(input.trust_in_institutions_1_10)) {
    return res.status(400).json({ error: 'One or more investment profile values are outside the allowed range.' });
  }
  const modelInput = Object.fromEntries([...numericFields, ...categoricalFields]
    .map((name) => [name, input[name]]));
  let response;
  try {
    response = await fetch(`${PREDICTOR_URL}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modelInput),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    console.error('Investment model request failed:', error);
    return res.status(503).json({ error: 'The investment prediction service is unavailable. Please try again.' });
  }
  let result;
  try {
    result = await response.json();
  } catch (error) {
    console.error('Investment model returned an invalid response:', error);
    return res.status(502).json({ error: 'The investment model returned an invalid response.' });
  }
  if (!response.ok) {
    return res.status(response.status === 400 ? 400 : 503)
      .json({ error: result?.error || 'The investment model could not make a prediction.' });
  }
  if (!result || typeof result !== 'object'
    || typeof result.recommendation !== 'string'
    || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1
    || !Array.isArray(result.alternatives)
    || result.alternatives.some((item) => !item || typeof item !== 'object'
      || typeof item.recommendation !== 'string'
      || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) {
    console.error('Investment model returned an unexpected prediction shape.');
    return res.status(502).json({ error: 'The investment model returned an invalid prediction.' });
  }
  try {
    await pool.query(
      `INSERT INTO investment_profiles (
        user_id, age, employment_status, marital_status, dependents_count, credit_score,
        emergency_fund_months, primary_goal, time_horizon_years, target_amount_usd,
        risk_tolerance_1_10, trust_in_institutions_1_10
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (user_id) DO UPDATE SET
        age = EXCLUDED.age,
        employment_status = EXCLUDED.employment_status,
        marital_status = EXCLUDED.marital_status,
        dependents_count = EXCLUDED.dependents_count,
        credit_score = EXCLUDED.credit_score,
        emergency_fund_months = EXCLUDED.emergency_fund_months,
        primary_goal = EXCLUDED.primary_goal,
        time_horizon_years = EXCLUDED.time_horizon_years,
        target_amount_usd = EXCLUDED.target_amount_usd,
        risk_tolerance_1_10 = EXCLUDED.risk_tolerance_1_10,
        trust_in_institutions_1_10 = EXCLUDED.trust_in_institutions_1_10,
        updated_at = now()`,
      [
        req.user.id, input.age, input.employment_status, input.marital_status,
        input.dependents_count, input.credit_score, input.emergency_fund_months,
        input.primary_goal, input.time_horizon_years, input.target_amount_usd,
        input.risk_tolerance_1_10, input.trust_in_institutions_1_10,
      ],
    );
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/accounts', requireUser, async (req, res, next) => {
  const { name, type = 'checking', startingBalance = 0 } = req.body || {};
  const balance = Number(startingBalance);
  if (!validText(name, 80) || !['checking', 'savings', 'credit', 'investment', 'loan', 'asset'].includes(type)
    || !Number.isFinite(balance) || Math.abs(balance) > 1000000000) {
    return res.status(400).json({ error: 'Enter a valid account name, type, and starting balance.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO accounts (user_id, name, type, starting_balance)
       VALUES ($1, $2, $3, $4) RETURNING id, name, type, starting_balance`,
      [req.user.id, name.trim(), type, balance],
    );
    return res.status(201).json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/accounts/:id', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Account not found.' });
    return res.json({ ok: true });
  } catch (error) {
    if (error.code === '23503') return res.status(409).json({ error: 'This account has transactions or schedules. Remove those first.' });
    return next(error);
  }
});

app.post('/api/categories', requireUser, async (req, res, next) => {
  const { name, group = 'Usual Expenses', type = 'expense' } = req.body || {};
  if (!validText(name, 80) || !validText(group, 80) || !['expense', 'income'].includes(type)) {
    return res.status(400).json({ error: 'Enter a valid category name, group, and type.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO categories (user_id, name, group_name, type) VALUES ($1, $2, $3, $4)
       RETURNING id, name, group_name, type`,
      [req.user.id, name.trim(), group.trim(), type],
    );
    return res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That category already exists in this group.' });
    return next(error);
  }
});

app.post('/api/budgets', requireUser, async (req, res, next) => {
  const { categoryId, month, amount } = req.body || {};
  if (!validMonth(month) || !positiveAmount(amount)) {
    return res.status(400).json({ error: 'Choose a valid month and a positive budget amount.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO budgets (user_id, category_id, month, amount)
       SELECT $1, c.id, $3::date, $4 FROM categories c
       WHERE c.id = $2 AND c.user_id = $1 AND c.type = 'expense'
       ON CONFLICT (category_id, month) DO UPDATE SET amount = EXCLUDED.amount
       RETURNING id, category_id, month, amount`,
      [req.user.id, categoryId, `${month}-01`, amount],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Expense category not found.' });
    return res.status(201).json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/transactions', requireUser, async (req, res, next) => {
  const { description, amount, type, date, categoryId = null, accountId, toAccountId = null } = req.body || {};
  if (!validText(description, 160) || !positiveAmount(amount) || !validDate(date)
    || !['expense', 'income', 'transfer'].includes(type) || !accountId
    || (type === 'transfer' && (!toAccountId || String(accountId) === String(toAccountId)))
    || (type !== 'transfer' && !categoryId)) {
    return res.status(400).json({ error: 'Enter a description, positive amount, date, type, account, and category (transfers need two different accounts).' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const accounts = await client.query(
      'SELECT id FROM accounts WHERE user_id = $1 AND id = ANY($2::bigint[]) FOR UPDATE',
      [req.user.id, type === 'transfer' ? [accountId, toAccountId] : [accountId]],
    );
    if (accounts.rowCount !== (type === 'transfer' ? 2 : 1)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Select account(s) belonging to your account.' });
    }
    if (categoryId) {
      const category = await client.query(
        'SELECT id FROM categories WHERE id = $1 AND user_id = $2 AND type = $3',
        [categoryId, req.user.id, type],
      );
      if (!category.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Choose a category matching the transaction type.' });
      }
    }
    const { rows } = await client.query(
      `INSERT INTO transactions (user_id, description, amount, type, date, category_id, account_id, to_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, description, amount, type, date, category_id, account_id, to_account_id`,
      [req.user.id, description.trim(), amount, type, date, categoryId, accountId, type === 'transfer' ? toAccountId : null],
    );
    await client.query('COMMIT');
    return res.status(201).json(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

app.delete('/api/transactions/:id', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Transaction not found.' });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/schedules', requireUser, async (req, res, next) => {
  const { name, amount, type, dueDay, categoryId = null, accountId } = req.body || {};
  if (!validText(name, 120) || !positiveAmount(amount) || !['expense', 'income'].includes(type)
    || !Number.isInteger(Number(dueDay)) || Number(dueDay) < 1 || Number(dueDay) > 31 || !accountId || !categoryId) {
    return res.status(400).json({ error: 'Enter a schedule name, amount, type, due day (1-31), category, and account.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO schedules (user_id, name, amount, type, due_day, category_id, account_id)
       SELECT $1, $2, $3, $4, $5, c.id, a.id
       FROM categories c, accounts a
       WHERE c.id = $6 AND c.user_id = $1 AND c.type = $4 AND a.id = $7 AND a.user_id = $1
       RETURNING id, name, amount, type, due_day, category_id, account_id`,
      [req.user.id, name.trim(), amount, type, Number(dueDay), categoryId, accountId],
    );
    if (!rows[0]) return res.status(400).json({ error: 'Choose a category and account that belong to you and match the schedule type.' });
    return res.status(201).json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/schedules/:id', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM schedules WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Schedule not found.' });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('checking', 'savings', 'credit', 'investment', 'loan', 'asset')),
      starting_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS categories (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      group_name TEXT NOT NULL DEFAULT 'Usual Expenses',
      type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
      UNIQUE (user_id, name, group_name)
    );
    CREATE TABLE IF NOT EXISTS budgets (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      month DATE NOT NULL,
      amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
      UNIQUE (category_id, month)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
      type TEXT NOT NULL CHECK (type IN ('expense', 'income', 'transfer')),
      date DATE NOT NULL,
      category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
      account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      to_account_id BIGINT REFERENCES accounts(id) ON DELETE RESTRICT,
      CHECK ((type = 'transfer' AND to_account_id IS NOT NULL AND category_id IS NULL)
        OR (type <> 'transfer' AND to_account_id IS NULL AND category_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
      type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
      due_day SMALLINT NOT NULL CHECK (due_day BETWEEN 1 AND 31),
      category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
      account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS investment_profiles (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      age SMALLINT NOT NULL CHECK (age BETWEEN 0 AND 120),
      employment_status TEXT NOT NULL CHECK (
        employment_status IN ('Retired', 'Salaried', 'Self-Employed', 'Student', 'Unemployed')
      ),
      marital_status TEXT NOT NULL CHECK (
        marital_status IN ('Divorced', 'Married', 'Single', 'Widowed')
      ),
      dependents_count SMALLINT NOT NULL CHECK (dependents_count BETWEEN 0 AND 100),
      credit_score SMALLINT NOT NULL CHECK (credit_score BETWEEN 300 AND 850),
      emergency_fund_months NUMERIC(6, 1) NOT NULL CHECK (emergency_fund_months BETWEEN 0 AND 120),
      primary_goal TEXT NOT NULL CHECK (primary_goal IN (
        'Business Investment', 'Debt Reduction', 'Education', 'Emergency Fund',
        'Estate Planning', 'Healthcare', 'Home Purchase', 'Retirement', 'Travel',
        'Wealth Accumulation'
      )),
      time_horizon_years SMALLINT NOT NULL CHECK (time_horizon_years BETWEEN 0 AND 100),
      target_amount_usd NUMERIC(14, 2) NOT NULL CHECK (target_amount_usd BETWEEN 0 AND 1000000000),
      risk_tolerance_1_10 SMALLINT NOT NULL CHECK (risk_tolerance_1_10 BETWEEN 1 AND 10),
      trust_in_institutions_1_10 SMALLINT NOT NULL CHECK (trust_in_institutions_1_10 BETWEEN 1 AND 10),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS transactions_user_date_idx ON transactions (user_id, date DESC);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
  `);
}

async function waitForPredictor(child) {
  const deadline = Date.now() + 120000;
  let spawnError;
  child.once('error', (error) => { spawnError = error; });

  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) {
      throw new Error(`Investment predictor exited with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`${PREDICTOR_URL}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // The predictor may still be loading the model.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Investment predictor did not become healthy within 120 seconds.');
}

async function start() {
  let predictor;
  try {
    if (process.env.PREDICTOR_AUTOSTART === 'true') {
      predictor = spawn(
        process.env.PYTHON_PATH || '/opt/predictor-venv/bin/python',
        ['-u', 'model/serve.py'],
        { stdio: 'inherit' },
      );
      await waitForPredictor(predictor);
      predictor.on('exit', (code, signal) => {
        console.error(`Investment predictor stopped (code ${code}, signal ${signal}).`);
        process.exit(1);
      });
    }

    await initializeDatabase();
    const server = app.listen(PORT, () => console.log(`Spendwise running on port ${PORT}`));
    const shutdown = async () => {
      server.close();
      if (predictor && predictor.exitCode === null) predictor.kill('SIGTERM');
      await pool.end();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (error) {
    if (predictor && predictor.exitCode === null) predictor.kill('SIGTERM');
    console.error('Could not start Spendwise:', error);
    await pool.end();
    process.exitCode = 1;
  }
}

start();
