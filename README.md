# Student Loan Calculator

A dashboard analysing how student loan repayments affect marginal tax rates, take-home pay, and lifetime costs for UK graduates.

## Key Features

- **Marginal deduction rates by income**: See how rates change across the income distribution
- **Tax position breakdown**: Compare deductions for workers with and without student loans
- **Take-home pay impact**: Visualise the annual cost of loan repayments
- **Age-based comparison**: Compare marginal rates across different age groups
- **Lifetime repayment analysis**: Project total repayments over the loan term

## Tech Stack

- **Frontend**: React + Vite + D3.js
- **Backend API**: Python with PolicyEngine UK (deployed on Google Cloud Run)
- **Hosting**: Vercel (frontend)

## Getting Started

### Frontend

```bash
npm install
npm run dev
```

### Python API (local development)

```bash
uv sync
uv run python src/uk_budget_data/api.py
```

### Generate tax parameters CSV

```bash
uv run python src/uk_budget_data/student_loan_effective_ni.py
```

This generates the `public/data/student_loan_parameters.csv` file with tax parameters for each year (read from PolicyEngine UK).

## Structure

```
├── src/
│   ├── components/
│   │   ├── StudentLoanCalculator.jsx   # Main React component
│   │   └── StudentLoanCalculator.css   # Styles
│   └── uk_budget_data/
│       ├── api.py                       # FastAPI backend
│       └── student_loan_effective_ni.py # PE UK calculations
├── public/
│   └── data/
│       └── student_loan_parameters.csv  # Generated tax parameters
└── package.json
```

## Data Sources

| Component | Source |
|-----------|--------|
| Tax parameters (thresholds, rates) | CSV file (pre-generated from PolicyEngine UK) |
| Marginal rates, tax breakdown, take-home pay | Client-side JavaScript calculations |
| Lifetime repayment projections | API (Python/PolicyEngine UK) |

## How It Works

The dashboard combines three tax/deduction components to show true marginal rates:

1. **Income Tax**: 20% basic, 40% higher, 45% additional (plus 60% effective in PA taper zone)
2. **National Insurance**: 8% main rate, 2% above UEL
3. **Student Loan**: 9% above threshold (varies by plan)

All parameters are read from PolicyEngine UK to ensure accuracy across tax years.
