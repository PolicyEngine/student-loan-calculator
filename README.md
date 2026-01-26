# Student Loan as Effective NI

A dashboard showing how Plan 2 student loan repayments function as a de facto generational payroll tax, creating higher effective marginal rates for younger workers.

## Key Findings

- Workers under 32 with Plan 2 loans face marginal rates up to **51%** (or 71% in the PA taper zone)
- This is **9 percentage points higher** than older workers on the same salary
- The Autumn Budget 2024 freezes the Plan 2 threshold at £29,385 for three years from April 2027

## Tech Stack

- **Frontend**: React + Vite + D3.js
- **Backend calculations**: Python with PolicyEngine UK

## Getting Started

### Frontend

```bash
npm install
npm run dev
```

### Python calculations

```bash
uv sync
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
│       └── student_loan_effective_ni.py  # PE UK calculations
├── public/
│   └── data/
│       └── student_loan_parameters.csv   # Generated tax parameters
└── package.json
```

## How It Works

The dashboard combines three tax/deduction components to show true marginal rates:

1. **Income Tax**: 20% basic, 40% higher, 45% additional (plus 60% effective in PA taper zone)
2. **National Insurance**: 8% main rate, 2% above UEL
3. **Plan 2 Student Loan**: 9% above threshold (£29,385 in 2026)

All parameters are read from PolicyEngine UK to ensure accuracy across tax years.
