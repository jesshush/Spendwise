const $ = (id) => document.getElementById(id);
const state = { mode: 'login', view: 'budget', data: null, user: null, month: new Date().toISOString().slice(0, 7), selectedCategory: null };
const currency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

function money(value) {
  return currency.format(Number(value) || 0);
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function setAuthMode(mode) {
  state.mode = mode;
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-signup').classList.toggle('active', mode === 'signup');
  $('name-row').hidden = mode === 'login';
  $('name').required = mode === 'signup';
  $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('auth-error').textContent = '';
}

function showApp(user) {
  state.user = user;
  $('auth-screen').hidden = true;
  $('app-screen').hidden = false;
  $('user-name').textContent = `${user.name}’s Budget`;
  $('month-picker').value = state.month;
  loadDashboard();
  loadInvestmentProfile(true);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (response.status === 401 && url !== '/api/login' && url !== '/api/signup') {
    $('app-screen').hidden = true;
    $('auth-screen').hidden = false;
    throw new Error('Your session expired. Please log in again.');
  }
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data;
}

async function loadDashboard() {
  try {
    state.data = await request(`/api/dashboard?month=${encodeURIComponent(state.month)}`);
    renderDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadInvestmentProfile(refreshFinancial = false) {
  try {
    const profile = await request('/api/investment-profile');
    const incomeMonths = Number(profile.income_history_months);
    const expenseMonths = Number(profile.expense_history_months);
    $('investment-coverage').textContent = incomeMonths || expenseMonths
      ? `Transaction history used: ${incomeMonths} month(s) for income and ${expenseMonths} month(s) for expenses.`
      : 'No income or expense transactions were found in the last 12 months; those estimates default to $0.';
    const financialFields = new Set([
      'annual_income_usd', 'monthly_expenses_usd',
      'investment_portfolio_usd', 'total_debt_usd',
    ]);
    for (const [name, value] of Object.entries(profile)) {
      const input = $('investment-form').elements.namedItem(name);
      if (input && value !== null && value !== undefined
        && (!input.value || (refreshFinancial && financialFields.has(name)))) {
        input.value = value;
      }
    }
  } catch (error) {
    showToast(error.message);
  }
}

function renderAccounts() {
  const accounts = state.data.accounts;
  $('account-list').innerHTML = accounts.length ? accounts.map((account) => `
    <div class="account-row"><span class="account-dot ${escapeHTML(account.type)}"></span>
      <span class="account-name">${escapeHTML(account.name)}</span><span class="account-balance">${money(account.balance)}</span>
      <button class="inline-delete" data-action="delete-account" data-id="${escapeHTML(account.id)}" aria-label="Delete ${escapeHTML(account.name)}">×</button>
    </div>`).join('') : '<p class="empty-note">Add an account to get started.</p>';
  $('accounts-total').textContent = money(accounts.reduce((sum, account) => sum + Number(account.balance), 0));
}

function renderBudgets() {
  const categories = state.data.categories.filter((category) => category.type === 'expense');
  const groups = new Map();
  for (const category of categories) {
    if (!groups.has(category.group_name)) groups.set(category.group_name, []);
    groups.get(category.group_name).push(category);
  }
  if (!categories.length) {
    $('budget-rows').innerHTML = '<tr><td colspan="5" class="empty-cell">No categories yet. Add a category to start planning.</td></tr>';
    return;
  }
  $('budget-rows').innerHTML = [...groups.entries()].map(([group, items]) => {
    const groupBudget = items.reduce((sum, item) => sum + Number(item.budgeted), 0);
    const groupSpent = items.reduce((sum, item) => sum + Number(item.spent), 0);
    return `<tr class="group-row"><td><span class="chevron">⌄</span>${escapeHTML(group)}</td><td>${money(groupBudget)}</td>
      <td>${money(groupSpent)}</td><td class="${groupBudget - groupSpent < 0 ? 'negative' : ''}">${money(groupBudget - groupSpent)}</td><td></td></tr>
      ${items.map((category) => {
        const budget = Number(category.budgeted);
        const spent = Number(category.spent);
        const remaining = budget - spent;
        const percent = budget > 0 ? Math.min(100, Math.max(0, (spent / budget) * 100)) : 0;
        return `<tr><td class="category-cell"><button class="category-action" data-action="budget-category" data-id="${escapeHTML(category.id)}">${escapeHTML(category.name)}</button></td>
          <td>${money(budget)}</td><td>${money(spent)}</td><td class="${remaining < 0 ? 'negative' : ''}">${money(remaining)}</td>
          <td><div class="progress-track" title="${Math.round(percent)}%"><span class="${spent > budget && budget > 0 ? 'over-budget' : ''}" style="width:${percent}%"></span></div></td></tr>`;
      }).join('')}`;
  }).join('');
}

function transactionMarkup(transaction) {
  const income = transaction.type === 'income';
  const transfer = transaction.type === 'transfer';
  const title = transfer
    ? `${transaction.account_name} → ${transaction.to_account_name}`
    : transaction.description;
  const detail = [transaction.category_name || (transfer ? 'Transfer' : 'Uncategorized'), transaction.account_name]
    .filter(Boolean).join(' · ');
  return `<div class="transaction-row"><div class="transaction-icon ${escapeHTML(transaction.type)}">${income ? '↙' : transfer ? '⇄' : '↗'}</div>
    <div class="transaction-copy"><strong>${escapeHTML(title)}</strong><small>${escapeHTML(detail)}</small></div>
    <time>${escapeHTML(new Date(`${transaction.date.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</time>
    <strong class="transaction-amount ${income ? 'positive' : transfer ? '' : 'negative'}">${income ? '+' : transfer ? '' : '−'}${money(transaction.amount)}</strong>
    <button class="inline-delete" data-action="delete-transaction" data-id="${escapeHTML(transaction.id)}" aria-label="Delete transaction">×</button></div>`;
}

function renderTransactions() {
  const transactions = state.data.transactions;
  const content = transactions.length
    ? transactions.map(transactionMarkup).join('')
    : '<div class="empty-state"><span>↕</span><strong>No transactions this month</strong><p>Add transactions to see your spending here.</p></div>';
  $('transaction-list').innerHTML = content;
  $('recent-transactions').innerHTML = transactions.length
    ? transactions.slice(0, 5).map(transactionMarkup).join('')
    : '<div class="empty-state compact"><strong>No activity yet</strong><p>Your latest transactions will appear here.</p></div>';
}

function renderSchedules() {
  $('schedule-list').innerHTML = state.data.schedules.length
    ? state.data.schedules.map((schedule) => `<div class="transaction-row">
      <div class="transaction-icon ${escapeHTML(schedule.type)}">◷</div>
      <div class="transaction-copy"><strong>${escapeHTML(schedule.name)}</strong>
        <small>${escapeHTML(schedule.category_name)} · ${escapeHTML(schedule.account_name)} · Due day ${schedule.due_day}</small></div>
      <strong class="transaction-amount ${schedule.type === 'income' ? 'positive' : ''}">${money(schedule.amount)} / month</strong>
      <button class="inline-delete" data-action="delete-schedule" data-id="${escapeHTML(schedule.id)}" aria-label="Delete schedule">×</button>
    </div>`).join('')
    : '<div class="empty-state"><span>◷</span><strong>No recurring schedules</strong><p>Keep regular bills and income in one place.</p></div>';
}

function renderReports() {
  const income = Number(state.data.totals.income);
  const spent = Number(state.data.totals.spent);
  $('report-income').textContent = money(income);
  $('report-spent').textContent = money(spent);
  $('report-net').textContent = money(income - spent);
  const expenses = state.data.report.filter((item) => item.type === 'expense');
  const maxAmount = Math.max(1, ...expenses.map((item) => Number(item.amount)));
  $('report-bars').innerHTML = expenses.length ? expenses.map((item) => `
    <div class="report-bar-row"><div class="report-bar-label"><span>${escapeHTML(item.name)}</span><strong>${money(item.amount)}</strong></div>
      <div class="progress-track report-track"><span style="width:${Math.max(2, (Number(item.amount) / maxAmount) * 100)}%"></span></div></div>`).join('')
    : '<div class="empty-state compact"><strong>No expense data yet</strong><p>Add an expense transaction to see a breakdown.</p></div>';
}

function renderDashboard() {
  const { categories, totals } = state.data;
  const budgeted = categories.reduce((sum, item) => sum + Number(item.budgeted), 0);
  const spent = Number(totals.spent);
  $('budget-total').textContent = money(budgeted);
  $('spent-total').textContent = money(spent);
  $('available-total').textContent = money(budgeted - spent);
  $('income-total').textContent = `${money(totals.income)} income this month`;
  renderAccounts();
  renderBudgets();
  renderTransactions();
  renderSchedules();
  renderReports();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.hidden = panel.id !== `view-${view}`;
  });
  $('page-title').textContent = ({
    budget: 'Monthly budget',
    transactions: 'Transactions',
    reports: 'Reports',
    schedules: 'Schedules',
    investment: 'Investment advice',
  })[view];
}

function renderInvestmentPrediction(result) {
  const products = result.recommendation.split(';').map((product) => product.trim()).filter(Boolean);
  $('investment-results').innerHTML = `
    <h3>Model recommendation</h3>
    <p>Most likely recommendation · ${Math.round(result.confidence * 100)}% model confidence</p>
    <ul class="investment-products">${products.map((product) => `<li>${escapeHTML(product)}</li>`).join('')}</ul>
    ${result.alternatives.length ? `<div class="investment-alternatives"><strong>Other model outputs</strong><ul>${result.alternatives.map((item) =>
      `<li>${escapeHTML(item.recommendation)} · ${Math.round(item.confidence * 100)}%</li>`).join('')}</ul></div>` : ''}
    <p class="muted">This is a machine-learning estimate based on the information entered, not personalized regulated financial advice.</p>`;
  $('investment-results').hidden = false;
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove('visible'), 3500);
}

function selectOptions(items, selectedId = '') {
  return items.map((item) => `<option value="${escapeHTML(item.id)}" ${String(item.id) === String(selectedId) ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('');
}

function field(label, name, type = 'text', value = '', attributes = '') {
  return `<label>${label}<input name="${name}" type="${type}" value="${escapeHTML(value)}" ${attributes}></label>`;
}

function selectField(label, name, items, selectedId = '', emptyLabel = 'Choose one') {
  const options = selectOptions(items, selectedId);
  return `<label>${label}<select name="${name}" required><option value="">${emptyLabel}</option>${options}</select></label>`;
}

function openDialog(kind, categoryId = null) {
  if (!state.data) return;
  state.selectedCategory = categoryId;
  const categories = state.data.categories;
  const expenseCategories = categories.filter((category) => category.type === 'expense');
  const incomeCategories = categories.filter((category) => category.type === 'income');
  const accounts = state.data.accounts;
  let fields = '';
  let title = '';

  if (kind === 'account') {
    title = 'Add account';
    fields = field('Account name', 'name', 'text', '', 'required maxlength="80" placeholder="e.g. Everyday checking"')
      + `<label>Account type<select name="type" required><option value="checking">Checking</option><option value="savings">Savings</option><option value="credit">Credit card</option><option value="investment">Investment</option><option value="loan">Loan</option><option value="asset">Other asset</option></select></label>`
      + field('Starting balance', 'startingBalance', 'number', '0', 'step="0.01" required')
      + '<p class="muted form-hint">Enter credit-card or loan amounts owed as a negative balance; these feed the debt estimate.</p>';
  } else if (kind === 'category') {
    title = 'Add category';
    fields = field('Category name', 'name', 'text', '', 'required maxlength="80"')
      + field('Group', 'group', 'text', 'Usual Expenses', 'required maxlength="80"')
      + '<label>Type<select name="type"><option value="expense">Expense</option><option value="income">Income</option></select></label>';
  } else if (kind === 'budget') {
    title = 'Set monthly budget';
    const selected = categoryId || '';
    fields = selectField('Expense category', 'categoryId', expenseCategories, selected)
      + field('Month', 'month', 'month', state.month, 'required')
      + field('Budget amount', 'amount', 'number', '', 'min="0.01" step="0.01" required placeholder="0.00"');
  } else if (kind === 'transaction') {
    if (!accounts.length) return showToast('Add an account before recording a transaction.');
    title = 'Add transaction';
    const date = new Date().toISOString().slice(0, 10);
    fields = field('Description', 'description', 'text', '', 'required maxlength="160" placeholder="e.g. Grocery shopping"')
      + field('Amount', 'amount', 'number', '', 'min="0.01" step="0.01" required placeholder="0.00"')
      + `<label>Type<select name="type" id="transaction-type" required><option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option></select></label>`
      + `<div id="transaction-category">${selectField('Category', 'categoryId', expenseCategories)}</div>`
      + selectField('From account', 'accountId', accounts)
      + `<div id="transaction-to-account" hidden>${selectField('To account', 'toAccountId', accounts)}</div>`
      + field('Date', 'date', 'date', date, 'required');
  } else if (kind === 'schedule') {
    if (!accounts.length) return showToast('Add an account before creating a schedule.');
    title = 'Add recurring schedule';
    fields = field('Name', 'name', 'text', '', 'required maxlength="120" placeholder="e.g. Monthly rent"')
      + field('Amount', 'amount', 'number', '', 'min="0.01" step="0.01" required placeholder="0.00"')
      + `<label>Type<select name="type" id="schedule-type"><option value="expense">Expense</option><option value="income">Income</option></select></label>`
      + `<div id="schedule-category">${selectField('Category', 'categoryId', expenseCategories)}</div>`
      + selectField('Account', 'accountId', accounts)
      + field('Due day of month', 'dueDay', 'number', '1', 'min="1" max="31" step="1" required');
  }

  $('dialog-title').textContent = title;
  $('dialog-fields').innerHTML = fields;
  $('dialog-error').textContent = '';
  $('entry-form').dataset.kind = kind;
  $('entry-dialog').showModal();
  const transactionType = $('transaction-type');
  if (transactionType) transactionType.addEventListener('change', updateTransactionFields);
  const scheduleType = $('schedule-type');
  if (scheduleType) scheduleType.addEventListener('change', updateScheduleFields);
}

function updateTransactionFields() {
  const type = $('transaction-type').value;
  const categoryItems = state.data.categories.filter((category) => category.type === type && type !== 'transfer');
  const wrapper = $('transaction-category');
  const toAccount = $('transaction-to-account');
  if (type === 'transfer') {
    wrapper.hidden = true;
    wrapper.querySelector('select').required = false;
    toAccount.hidden = false;
    toAccount.querySelector('select').required = true;
  } else {
    wrapper.hidden = false;
    wrapper.innerHTML = selectField('Category', 'categoryId', categoryItems);
    toAccount.hidden = true;
    toAccount.querySelector('select').required = false;
  }
}

function updateScheduleFields() {
  const type = $('schedule-type').value;
  $('schedule-category').innerHTML = selectField('Category', 'categoryId',
    state.data.categories.filter((category) => category.type === type));
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function submitEntry(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  const kind = form.dataset.kind;
  let url = '';
  let body = values;
  if (kind === 'account') {
    url = '/api/accounts';
    body.startingBalance = Number(body.startingBalance);
  } else if (kind === 'category') {
    url = '/api/categories';
  } else if (kind === 'budget') {
    url = '/api/budgets';
    body = { categoryId: values.categoryId, month: values.month, amount: Number(values.amount) };
  } else if (kind === 'transaction') {
    url = '/api/transactions';
    body = {
      description: values.description, amount: Number(values.amount), type: values.type,
      date: values.date, categoryId: values.categoryId || null,
      accountId: values.accountId, toAccountId: values.toAccountId || null,
    };
  } else if (kind === 'schedule') {
    url = '/api/schedules';
    body = {
      name: values.name, amount: Number(values.amount), type: values.type,
      dueDay: Number(values.dueDay), categoryId: values.categoryId, accountId: values.accountId,
    };
  }
  $('dialog-submit').disabled = true;
  $('dialog-error').textContent = '';
  try {
    await request(url, { method: 'POST', body: JSON.stringify(body) });
    $('entry-dialog').close();
    showToast('Saved successfully.');
    if (kind === 'budget' && values.month !== state.month) {
      state.month = values.month;
      $('month-picker').value = state.month;
    }
    await loadDashboard();
  } catch (error) {
    $('dialog-error').textContent = error.message;
  } finally {
    $('dialog-submit').disabled = false;
  }
}

async function deleteEntry(action, id) {
  const labels = { 'delete-account': 'account', 'delete-transaction': 'transaction', 'delete-schedule': 'schedule' };
  const label = labels[action];
  if (!label || !confirm(`Delete this ${label}? This cannot be undone.`)) return;
  const endpoint = {
    'delete-account': `/api/accounts/${encodeURIComponent(id)}`,
    'delete-transaction': `/api/transactions/${encodeURIComponent(id)}`,
    'delete-schedule': `/api/schedules/${encodeURIComponent(id)}`,
  }[action];
  try {
    await request(endpoint, { method: 'DELETE' });
    showToast(`${label[0].toUpperCase()}${label.slice(1)} deleted.`);
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

$('tab-login').addEventListener('click', () => setAuthMode('login'));
$('tab-signup').addEventListener('click', () => setAuthMode('signup'));
$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('auth-submit').disabled = true;
  $('auth-error').textContent = '';
  try {
    const user = await request(`/api/${state.mode}`, {
      method: 'POST',
      body: JSON.stringify({ name: $('name').value, email: $('email').value, password: $('password').value }),
    });
    showApp(user);
  } catch (error) {
    $('auth-error').textContent = error.message;
  } finally {
    $('auth-submit').disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  try {
    await request('/api/logout', { method: 'POST' });
  } finally {
    location.reload();
  }
});
$('month-picker').addEventListener('change', (event) => {
  if (!event.target.value) return;
  state.month = event.target.value;
  loadDashboard();
});
$('entry-form').addEventListener('submit', submitEntry);
$('refresh-investment-estimates').addEventListener('click', () => loadInvestmentProfile(true));
$('investment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('investment-error').textContent = '';
  $('predict-investment').disabled = true;
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  for (const name of [
    'age', 'annual_income_usd', 'dependents_count', 'credit_score', 'total_debt_usd',
    'monthly_expenses_usd', 'emergency_fund_months', 'investment_portfolio_usd',
    'time_horizon_years', 'target_amount_usd', 'risk_tolerance_1_10',
    'trust_in_institutions_1_10',
  ]) values[name] = Number(values[name]);
  $('investment-results').hidden = true;
  try {
    const result = await request('/api/investment-prediction', {
      method: 'POST',
      body: JSON.stringify(values),
    });
    renderInvestmentPrediction(result);
  } catch (error) {
    $('investment-error').textContent = error.message;
  } finally {
    $('predict-investment').disabled = false;
  }
});
$('dialog-close').addEventListener('click', () => $('entry-dialog').close());
$('dialog-cancel').addEventListener('click', () => $('entry-dialog').close());
document.querySelectorAll('.nav-link').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
document.addEventListener('click', (event) => {
  const viewLink = event.target.closest('[data-view-link]');
  if (viewLink) return setView(viewLink.dataset.viewLink);
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, id } = target.dataset;
  if (action === 'add-account') openDialog('account');
  if (action === 'add-category') openDialog('category');
  if (action === 'add-budget') openDialog('budget');
  if (action === 'budget-category') openDialog('budget', id);
  if (action === 'add-transaction') openDialog('transaction');
  if (action === 'add-schedule') openDialog('schedule');
  if (action.startsWith('delete-')) deleteEntry(action, id);
});

setAuthMode('login');
request('/api/me').then((user) => showApp(user)).catch((error) => {
  if (!error.message.includes('Please log in') && !error.message.includes('session expired')) {
    $('auth-error').textContent = error.message;
  }
});
