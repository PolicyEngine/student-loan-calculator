"""Student loan as effective NI: marginal deduction rates by age cohort.

This module models how Plan 2 student loan repayments function as a de facto
additional tax for younger workers, showing true marginal deduction rates
(income tax + NI + student loan) by age cohort.

Key insight: Workers born after ~1994 (started university 2012+) face a 9%
student loan repayment on income above the threshold, effectively creating
a generational tax disparity:
- Basic rate taxpayer without loan: 20% IT + 8% NI = 28%
- Basic rate taxpayer with Plan 2: 20% IT + 8% NI + 9% SL = 37%
- Higher rate taxpayer without loan: 40% IT + 2% NI = 42%
- Higher rate taxpayer with Plan 2: 40% IT + 2% NI + 9% SL = 51%

All rates are read directly from PolicyEngine UK parameters.
"""

from dataclasses import dataclass
from functools import lru_cache

import numpy as np
import pandas as pd
from policyengine_uk import CountryTaxBenefitSystem, Simulation


# Cache the TaxBenefitSystem globally - this is expensive to create
@lru_cache(maxsize=1)
def _get_tax_benefit_system() -> CountryTaxBenefitSystem:
    """Get cached TaxBenefitSystem instance."""
    return CountryTaxBenefitSystem()


@lru_cache(maxsize=10)
def get_tax_parameters(year: int = 2026) -> dict:
    """Load all relevant tax parameters from PolicyEngine UK.

    Args:
        year: Tax year for parameter lookup.

    Returns:
        Dict with all tax/NI/student loan parameters.
    """
    tbs = _get_tax_benefit_system()
    params = tbs.parameters
    date = f"{year}-01-01"

    # Income tax parameters
    it = params.gov.hmrc.income_tax
    pa_amount = it.allowances.personal_allowance.amount(date)

    # Tax bands (thresholds are cumulative in PE)
    basic_rate = it.rates.uk[0].rate(date)
    higher_rate = it.rates.uk[1].rate(date)
    additional_rate = it.rates.uk[2].rate(date)
    basic_band = it.rates.uk[0].threshold(date)  # Band width, not threshold
    higher_band = it.rates.uk[1].threshold(date)
    additional_threshold = it.rates.uk[2].threshold(date)

    # Calculate actual thresholds
    basic_rate_threshold = pa_amount + basic_band + higher_band
    higher_rate_threshold = additional_threshold

    # Personal allowance taper (PA reduced by £1 for every £2 above threshold)
    pa_taper_threshold = it.allowances.personal_allowance.maximum_ANI(date)
    pa_taper_rate = it.allowances.personal_allowance.reduction_rate(date)

    # National Insurance parameters
    ni = params.gov.hmrc.national_insurance.class_1
    # NI thresholds are weekly, convert to annual
    ni_primary_threshold = ni.thresholds.primary_threshold(date) * 52
    ni_uel = ni.thresholds.upper_earnings_limit(date) * 52
    ni_main_rate = ni.rates.employee.main(date)
    ni_higher_rate = ni.rates.employee.additional(date)

    # Student loan parameters
    sl = params.gov.hmrc.student_loans
    sl_repayment_rate = sl.repayment_rate(date)
    sl_plan2_threshold = sl.thresholds.plan_2(date)
    sl_plan1_threshold = sl.thresholds.plan_1(date)
    sl_plan4_threshold = sl.thresholds.plan_4(date)
    sl_plan5_threshold = sl.thresholds.plan_5(date)
    sl_postgrad_threshold = sl.thresholds.postgraduate(date)
    sl_postgrad_rate = sl.postgraduate_repayment_rate(date)

    # Student loan interest rates (from PolicyEngine UK parameters)
    # Plan 2 interest: RPI + 0-3% depending on income
    # Plan 1/4: RPI or Bank of England base rate + 1% (whichever is lower)
    # Plan 5: RPI only
    # Note: These are approximate current rates - actual rates vary
    try:
        sl_interest = params.gov.hmrc.student_loans.interest
        sl_plan1_interest = sl_interest.plan_1.rate(date)
        sl_plan2_interest_min = sl_interest.plan_2.rate_below_threshold(date)
        sl_plan2_interest_max = sl_interest.plan_2.rate_above_threshold(date)
        sl_plan4_interest = sl_interest.plan_4.rate(date)
        sl_plan5_interest = sl_interest.plan_5.rate(date)
    except (AttributeError, KeyError):
        # Fallback to typical values if not in PE params
        sl_plan1_interest = 0.045  # ~4.5%
        sl_plan2_interest_min = 0.045  # RPI
        sl_plan2_interest_max = 0.078  # RPI + 3%
        sl_plan4_interest = 0.045  # ~4.5%
        sl_plan5_interest = 0.045  # RPI

    # Write-off periods (years after graduation/first repayment)
    sl_plan1_writeoff = 25
    sl_plan2_writeoff = 30
    sl_plan4_writeoff = 30
    sl_plan5_writeoff = 40

    return {
        # Income tax
        "personal_allowance": pa_amount,
        "basic_rate": basic_rate,
        "higher_rate": higher_rate,
        "additional_rate": additional_rate,
        "basic_rate_threshold": basic_rate_threshold,
        "higher_rate_threshold": higher_rate_threshold,
        "pa_taper_threshold": pa_taper_threshold,
        "pa_taper_rate": pa_taper_rate,
        # National Insurance
        "ni_primary_threshold": ni_primary_threshold,
        "ni_upper_earnings_limit": ni_uel,
        "ni_main_rate": ni_main_rate,
        "ni_higher_rate": ni_higher_rate,
        # Student loans - thresholds and repayment rates
        "sl_repayment_rate": sl_repayment_rate,
        "sl_plan2_threshold": sl_plan2_threshold,
        "sl_plan1_threshold": sl_plan1_threshold,
        "sl_plan4_threshold": sl_plan4_threshold,
        "sl_plan5_threshold": sl_plan5_threshold,
        "sl_postgrad_threshold": sl_postgrad_threshold,
        "sl_postgrad_rate": sl_postgrad_rate,
        # Student loans - interest rates
        "sl_plan1_interest": sl_plan1_interest,
        "sl_plan2_interest_min": sl_plan2_interest_min,
        "sl_plan2_interest_max": sl_plan2_interest_max,
        "sl_plan4_interest": sl_plan4_interest,
        "sl_plan5_interest": sl_plan5_interest,
        # Student loans - write-off periods
        "sl_plan1_writeoff": sl_plan1_writeoff,
        "sl_plan2_writeoff": sl_plan2_writeoff,
        "sl_plan4_writeoff": sl_plan4_writeoff,
        "sl_plan5_writeoff": sl_plan5_writeoff,
    }


@dataclass
class AgeCohort:
    """Represents an age cohort with their student loan status."""

    name: str
    age: int
    has_plan2_loan: bool
    description: str


# Age cohorts for comparison
AGE_COHORTS = [
    AgeCohort(
        name="Under 30 (Plan 2)",
        age=28,
        has_plan2_loan=True,
        description="Started university 2015+, has Plan 2 student loan",
    ),
    AgeCohort(
        name="30-35 (Plan 2)",
        age=32,
        has_plan2_loan=True,
        description="Started university 2012-2014, has Plan 2 student loan",
    ),
    AgeCohort(
        name="40+ (No loan)",
        age=45,
        has_plan2_loan=False,
        description="Pre-2012 university or no student loan",
    ),
    AgeCohort(
        name="50+ (No loan)",
        age=55,
        has_plan2_loan=False,
        description="Pre-2012 university or no student loan",
    ),
]


def calculate_marginal_rate(
    gross_income: float,
    params: dict,
    has_student_loan: bool = False,
) -> dict:
    """Calculate marginal deduction rate using PE UK parameters.

    Args:
        gross_income: Annual gross employment income.
        params: Tax parameters from get_tax_parameters().
        has_student_loan: Whether the person has a Plan 2 student loan.

    Returns:
        Dict with breakdown of marginal rates.
    """
    # Determine income tax marginal rate
    if gross_income <= params["personal_allowance"]:
        it_rate = 0.0
    elif gross_income <= params["basic_rate_threshold"]:
        it_rate = params["basic_rate"]
    elif gross_income <= params["higher_rate_threshold"]:
        it_rate = params["higher_rate"]
    else:
        it_rate = params["additional_rate"]

    # Personal allowance taper adds effective 60% rate
    if (
        params["pa_taper_threshold"]
        < gross_income
        <= params["higher_rate_threshold"]
    ):
        # 40% + (20% from PA taper at 50% withdrawal rate)
        it_rate = params["higher_rate"] + (
            params["basic_rate"] * params["pa_taper_rate"]
        )

    # Determine NI marginal rate
    if gross_income <= params["ni_primary_threshold"]:
        ni_rate = 0.0
    elif gross_income <= params["ni_upper_earnings_limit"]:
        ni_rate = params["ni_main_rate"]
    else:
        ni_rate = params["ni_higher_rate"]

    # Student loan marginal rate (9% above threshold)
    if has_student_loan and gross_income > params["sl_plan2_threshold"]:
        sl_rate = params["sl_repayment_rate"]
    else:
        sl_rate = 0.0

    total_rate = it_rate + ni_rate + sl_rate

    return {
        "gross_income": gross_income,
        "income_tax_rate": it_rate,
        "ni_rate": ni_rate,
        "student_loan_rate": sl_rate,
        "total_marginal_rate": total_rate,
        "has_student_loan": has_student_loan,
    }


def calculate_marginal_rates_policyengine(
    age: int,
    has_student_loan: bool,
    year: int = 2026,
    income_range: tuple[int, int] = (0, 150_000),
    num_points: int = 301,
) -> pd.DataFrame:
    """Calculate marginal deduction rates using PolicyEngine UK simulation.

    Creates a single adult household and varies employment income to
    compute effective marginal rates including all interactions.

    Args:
        age: Age of the individual.
        has_student_loan: Whether they have a Plan 2 student loan.
        year: Tax year for calculation.
        income_range: (min, max) employment income range.
        num_points: Number of income points to calculate.

    Returns:
        DataFrame with income levels and marginal rate breakdowns.
    """
    situation = {
        "people": {
            "adult": {
                "age": {year: age},
                "employment_income": {year: 0},
            }
        },
        "benunits": {
            "benunit": {
                "members": ["adult"],
            }
        },
        "households": {
            "household": {
                "members": ["adult"],
                "region": {year: "LONDON"},
            }
        },
        "axes": [
            [
                {
                    "name": "employment_income",
                    "min": income_range[0],
                    "max": income_range[1],
                    "count": num_points,
                    "period": str(year),
                }
            ]
        ],
    }

    # Add student loan if applicable
    if has_student_loan:
        situation["people"]["adult"]["student_loan_plan"] = {year: "PLAN_2"}

    sim = Simulation(situation=situation)

    # Get values
    employment_income = sim.calculate("employment_income", year)
    income_tax = sim.calculate("income_tax", year)
    ni = sim.calculate("national_insurance", year)
    student_loan = sim.calculate("student_loan_repayment", year)

    # Calculate marginal rates (change in deduction per £1 of income)
    delta = employment_income[1] - employment_income[0]

    income_tax_marginal = np.gradient(income_tax, delta)
    ni_marginal = np.gradient(ni, delta)
    sl_marginal = np.gradient(student_loan, delta)
    total_marginal = income_tax_marginal + ni_marginal + sl_marginal

    return pd.DataFrame(
        {
            "employment_income": employment_income,
            "income_tax": income_tax,
            "national_insurance": ni,
            "student_loan_repayment": student_loan,
            "income_tax_marginal_rate": income_tax_marginal,
            "ni_marginal_rate": ni_marginal,
            "student_loan_marginal_rate": sl_marginal,
            "total_marginal_rate": total_marginal,
            "age": age,
            "has_student_loan": has_student_loan,
        }
    )


def generate_cohort_comparison(
    year: int = 2026,
    income_range: tuple[int, int] = (0, 150_000),
    num_points: int = 301,
) -> pd.DataFrame:
    """Generate marginal rate comparison across age cohorts.

    Args:
        year: Tax year for calculation.
        income_range: (min, max) employment income range.
        num_points: Number of income points.

    Returns:
        DataFrame with all cohorts' marginal rates.
    """
    all_results = []

    for cohort in AGE_COHORTS:
        df = calculate_marginal_rates_policyengine(
            age=cohort.age,
            has_student_loan=cohort.has_plan2_loan,
            year=year,
            income_range=income_range,
            num_points=num_points,
        )
        df["cohort_name"] = cohort.name
        df["cohort_description"] = cohort.description
        all_results.append(df)

    return pd.concat(all_results, ignore_index=True)


def generate_simple_comparison(
    year: int = 2026,
    income_range: tuple[int, int] = (0, 150_000),
    step: int = 1_000,
) -> pd.DataFrame:
    """Generate statutory rate comparison using PE UK parameters.

    Args:
        year: Tax year for parameter lookup.
        income_range: (min, max) employment income range.
        step: Income step size.

    Returns:
        DataFrame comparing with/without student loan.
    """
    params = get_tax_parameters(year)
    incomes = range(income_range[0], income_range[1] + 1, step)
    results = []

    for income in incomes:
        # With student loan
        with_sl = calculate_marginal_rate(income, params, has_student_loan=True)
        with_sl["scenario"] = "With Plan 2 loan (under 35)"
        results.append(with_sl)

        # Without student loan
        without_sl = calculate_marginal_rate(
            income, params, has_student_loan=False
        )
        without_sl["scenario"] = "No student loan (over 40)"
        results.append(without_sl)

    return pd.DataFrame(results)


def get_key_thresholds(year: int = 2026) -> list[dict]:
    """Return key income thresholds and their marginal rate implications.

    All values read from PolicyEngine UK parameters.

    Args:
        year: Tax year for parameter lookup.

    Returns:
        List of threshold dictionaries with rates.
    """
    p = get_tax_parameters(year)

    basic_rate_pct = int(p["basic_rate"] * 100)
    higher_rate_pct = int(p["higher_rate"] * 100)
    additional_rate_pct = int(p["additional_rate"] * 100)
    ni_main_pct = int(p["ni_main_rate"] * 100)
    ni_higher_pct = int(p["ni_higher_rate"] * 100)
    sl_rate_pct = int(p["sl_repayment_rate"] * 100)

    # PA taper effective rate
    pa_taper_it = int(
        (p["higher_rate"] + p["basic_rate"] * p["pa_taper_rate"]) * 100
    )

    return [
        {
            "threshold": int(p["personal_allowance"]),
            "description": "Personal allowance (income tax starts)",
            "rate_without_sl": f"{basic_rate_pct}% IT + {ni_main_pct}% NI = {basic_rate_pct + ni_main_pct}%",
            "rate_with_sl": f"{basic_rate_pct}% IT + {ni_main_pct}% NI = {basic_rate_pct + ni_main_pct}%",
        },
        {
            "threshold": int(p["sl_plan2_threshold"]),
            "description": "Plan 2 student loan threshold",
            "rate_without_sl": f"{basic_rate_pct}% IT + {ni_main_pct}% NI = {basic_rate_pct + ni_main_pct}%",
            "rate_with_sl": f"{basic_rate_pct}% IT + {ni_main_pct}% NI + {sl_rate_pct}% SL = {basic_rate_pct + ni_main_pct + sl_rate_pct}%",
        },
        {
            "threshold": int(p["basic_rate_threshold"]),
            "description": "Higher rate threshold / NI UEL",
            "rate_without_sl": f"{higher_rate_pct}% IT + {ni_higher_pct}% NI = {higher_rate_pct + ni_higher_pct}%",
            "rate_with_sl": f"{higher_rate_pct}% IT + {ni_higher_pct}% NI + {sl_rate_pct}% SL = {higher_rate_pct + ni_higher_pct + sl_rate_pct}%",
        },
        {
            "threshold": int(p["pa_taper_threshold"]),
            "description": "Personal allowance taper starts",
            "rate_without_sl": f"{pa_taper_it}% IT + {ni_higher_pct}% NI = {pa_taper_it + ni_higher_pct}%",
            "rate_with_sl": f"{pa_taper_it}% IT + {ni_higher_pct}% NI + {sl_rate_pct}% SL = {pa_taper_it + ni_higher_pct + sl_rate_pct}%",
        },
        {
            "threshold": int(p["higher_rate_threshold"]),
            "description": "Additional rate threshold (PA gone)",
            "rate_without_sl": f"{additional_rate_pct}% IT + {ni_higher_pct}% NI = {additional_rate_pct + ni_higher_pct}%",
            "rate_with_sl": f"{additional_rate_pct}% IT + {ni_higher_pct}% NI + {sl_rate_pct}% SL = {additional_rate_pct + ni_higher_pct + sl_rate_pct}%",
        },
    ]


def generate_lifetime_repayment_data(
    starting_salary: float = 50_000,
    loan_amount: float = 45_000,
    salary_growth_rate: float = 0.03,
    plan: str = "plan2",
    year: int = 2026,
    interest_rate_override: float = None,
) -> pd.DataFrame:
    """Generate year-by-year lifetime repayment analysis for a student loan.

    Models current law including Autumn Budget 2025 policy:
    - Plan 2 threshold frozen at £29,385 for 2027-2029
    - RPI uprating resumes from 2030

    Args:
        starting_salary: Starting annual salary.
        loan_amount: Initial loan balance.
        salary_growth_rate: Annual salary growth rate.
        plan: Student loan plan (plan1, plan2, plan4, plan5).
        year: Tax year for parameter lookup (starting year).
        interest_rate_override: Custom interest rate (overrides plan default if set).

    Returns:
        DataFrame with yearly repayment data including balance, interest, repayments.
    """
    params = get_tax_parameters(year)

    # Get plan-specific parameters
    plan_config = {
        "plan1": {
            "threshold": params["sl_plan1_threshold"],
            "interest": params["sl_plan1_interest"],
            "writeoff": params["sl_plan1_writeoff"],
        },
        "plan2": {
            "threshold": params["sl_plan2_threshold"],
            "interest": (params["sl_plan2_interest_min"] + params["sl_plan2_interest_max"]) / 2,  # Average
            "writeoff": params["sl_plan2_writeoff"],
        },
        "plan4": {
            "threshold": params["sl_plan4_threshold"],
            "interest": params["sl_plan4_interest"],
            "writeoff": params["sl_plan4_writeoff"],
        },
        "plan5": {
            "threshold": params["sl_plan5_threshold"],
            "interest": params["sl_plan5_interest"],
            "writeoff": params["sl_plan5_writeoff"],
        },
    }

    config = plan_config.get(plan, plan_config["plan2"])
    base_threshold = config["threshold"]
    interest_rate = interest_rate_override if interest_rate_override is not None else config["interest"]
    writeoff_years = config["writeoff"]
    repayment_rate = params["sl_repayment_rate"]

    results = []
    balance = loan_amount
    total_repaid = 0
    total_interest = 0
    salary = starting_salary
    threshold = base_threshold  # Will be updated based on Autumn Budget policy

    for yr in range(writeoff_years + 1):
        # Calculate calendar year for this repayment year
        calendar_year = year + yr

        if yr == 0:
            results.append({
                "year": 0,
                "calendar_year": calendar_year,
                "salary": starting_salary,
                "balance_start": loan_amount,
                "interest_charge": 0,
                "annual_repayment": 0,
                "total_repaid": 0,
                "total_interest": 0,
                "balance_end": loan_amount,
                "threshold": threshold,
            })
            continue

        # Update threshold based on Autumn Budget 2025 policy (Plan 2 only)
        # Frozen 2027-2029, RPI uprating resumes 2030+
        if plan == "plan2":
            if calendar_year >= 2030:
                # RPI uprating resumes from 2030
                rpi_rate = get_rpi_rate(calendar_year)
                threshold *= (1 + rpi_rate)
            # 2027-2029: threshold stays frozen at base_threshold (no update needed)
        else:
            # Other plans: assume RPI uprating continues
            if calendar_year >= 2027:
                rpi_rate = get_rpi_rate(calendar_year)
                threshold *= (1 + rpi_rate)

        balance_start = balance

        # Calculate repayment FIRST (matches UK Autumn Budget methodology)
        annual_repayment = max(0, (salary - threshold) * repayment_rate) if salary > threshold else 0
        actual_repayment = min(annual_repayment, balance)
        balance_after_repayment = max(0, balance - actual_repayment)
        total_repaid += actual_repayment

        # THEN apply interest on remaining balance
        interest_charge = balance_after_repayment * interest_rate
        balance = balance_after_repayment + interest_charge
        total_interest += interest_charge

        results.append({
            "year": yr,
            "calendar_year": calendar_year,
            "salary": salary,
            "balance_start": balance_start,
            "interest_charge": interest_charge,
            "annual_repayment": actual_repayment,
            "total_repaid": total_repaid,
            "total_interest": total_interest,
            "balance_end": balance,
            "threshold": threshold,
        })

        # Grow salary for next year
        salary *= (1 + salary_growth_rate)

        # If fully repaid, stop
        if balance <= 0:
            break

    df = pd.DataFrame(results)
    df["plan"] = plan
    df["starting_salary"] = starting_salary
    df["loan_amount"] = loan_amount
    df["interest_rate"] = interest_rate
    df["writeoff_years"] = writeoff_years
    df["written_off"] = df["balance_end"].iloc[-1] if len(df) > 0 else 0

    return df


def generate_interest_comparison_data(
    starting_salary: float = 50_000,
    loan_amount: float = 45_000,
    salary_growth_rate: float = 0.03,
    plan: str = "plan2",
    year: int = 2026,
    interest_rate_override: float = None,
) -> pd.DataFrame:
    """Compare loan balance evolution with and without interest.

    Args:
        starting_salary: Starting annual salary.
        loan_amount: Initial loan balance.
        salary_growth_rate: Annual salary growth rate.
        plan: Student loan plan.
        year: Tax year for parameter lookup.
        interest_rate_override: Custom interest rate (overrides plan default if set).

    Returns:
        DataFrame comparing with/without interest scenarios.
    """
    params = get_tax_parameters(year)

    plan_config = {
        "plan1": {
            "threshold": params["sl_plan1_threshold"],
            "interest": params["sl_plan1_interest"],
            "writeoff": params["sl_plan1_writeoff"],
        },
        "plan2": {
            "threshold": params["sl_plan2_threshold"],
            "interest": (params["sl_plan2_interest_min"] + params["sl_plan2_interest_max"]) / 2,
            "writeoff": params["sl_plan2_writeoff"],
        },
        "plan4": {
            "threshold": params["sl_plan4_threshold"],
            "interest": params["sl_plan4_interest"],
            "writeoff": params["sl_plan4_writeoff"],
        },
        "plan5": {
            "threshold": params["sl_plan5_threshold"],
            "interest": params["sl_plan5_interest"],
            "writeoff": params["sl_plan5_writeoff"],
        },
    }

    config = plan_config.get(plan, plan_config["plan2"])
    threshold = config["threshold"]
    interest_rate = interest_rate_override if interest_rate_override is not None else config["interest"]
    writeoff_years = config["writeoff"]
    repayment_rate = params["sl_repayment_rate"]

    results = []
    balance_with_interest = loan_amount
    balance_no_interest = loan_amount
    total_interest = 0
    total_repaid_with = 0
    total_repaid_no = 0
    salary = starting_salary

    for yr in range(writeoff_years + 1):
        if yr == 0:
            results.append({
                "year": 0,
                "balance_with_interest": loan_amount,
                "balance_no_interest": loan_amount,
                "total_interest_accrued": 0,
                "repaid_with_interest": 0,
                "repaid_no_interest": 0,
                "total_repaid_with": 0,
                "total_repaid_no": 0,
            })
            continue

        annual_repayment = max(0, (salary - threshold) * repayment_rate) if salary > threshold else 0

        # WITH INTEREST: repayment first, then interest (UK methodology)
        actual_with = min(annual_repayment, balance_with_interest)
        balance_after_repayment = max(0, balance_with_interest - actual_with)
        interest_charge = balance_after_repayment * interest_rate
        balance_with_interest = balance_after_repayment + interest_charge
        total_interest += interest_charge
        total_repaid_with += actual_with

        # WITHOUT INTEREST: just repayment
        actual_no = min(annual_repayment, balance_no_interest)
        balance_no_interest = max(0, balance_no_interest - actual_no)
        total_repaid_no += actual_no

        results.append({
            "year": yr,
            "balance_with_interest": balance_with_interest,
            "balance_no_interest": balance_no_interest,
            "total_interest_accrued": total_interest,
            "repaid_with_interest": actual_with,
            "repaid_no_interest": actual_no,
            "total_repaid_with": total_repaid_with,
            "total_repaid_no": total_repaid_no,
        })

        salary *= (1 + salary_growth_rate)

    df = pd.DataFrame(results)
    df["plan"] = plan
    df["interest_rate"] = interest_rate

    return df


# OBR RPI forecasts (from UK Autumn Budget dashboard)
RPI_FORECASTS = {
    2024: 0.0331,
    2025: 0.0416,
    2026: 0.0308,
    2027: 0.0300,
    2028: 0.0283,
    2029: 0.0283,
}
RPI_LONG_TERM = 0.0239  # 2.39% for years beyond 2029


def get_rpi_rate(calendar_year: int) -> float:
    """Get RPI inflation rate for a given calendar year."""
    return RPI_FORECASTS.get(calendar_year, RPI_LONG_TERM)


def generate_policy_comparison_data(
    starting_salary: float = 50_000,
    loan_amount: float = 45_000,
    salary_growth_rate: float = 0.03,
    plan: str = "plan2",
    year: int = 2026,
    interest_rate_override: float = None,
) -> pd.DataFrame:
    """Compare lifetime repayments under Autumn Budget 2025 vs RPI-linked threshold.

    Models the Autumn Budget 2025 policy which:
    - Freezes Plan 2 threshold at £29,385 for 2027-2029
    - Resumes RPI uprating from 2030

    Baseline counterfactual assumes RPI uprating every year from 2027.

    Args:
        starting_salary: Starting annual salary.
        loan_amount: Initial loan balance.
        salary_growth_rate: Annual salary growth rate.
        plan: Student loan plan.
        year: Tax year for parameter lookup (starting year).
        interest_rate_override: Custom interest rate (overrides plan default if set).

    Returns:
        DataFrame comparing Autumn Budget (frozen 2027-2029) vs RPI-linked scenarios.
    """
    params = get_tax_parameters(year)

    plan_config = {
        "plan1": {
            "threshold": params["sl_plan1_threshold"],
            "interest": params["sl_plan1_interest"],
            "writeoff": params["sl_plan1_writeoff"],
        },
        "plan2": {
            "threshold": params["sl_plan2_threshold"],
            "interest": (params["sl_plan2_interest_min"] + params["sl_plan2_interest_max"]) / 2,
            "writeoff": params["sl_plan2_writeoff"],
        },
        "plan4": {
            "threshold": params["sl_plan4_threshold"],
            "interest": params["sl_plan4_interest"],
            "writeoff": params["sl_plan4_writeoff"],
        },
        "plan5": {
            "threshold": params["sl_plan5_threshold"],
            "interest": params["sl_plan5_interest"],
            "writeoff": params["sl_plan5_writeoff"],
        },
    }

    config = plan_config.get(plan, plan_config["plan2"])
    base_threshold = config["threshold"]  # £29,385 for Plan 2 in 2026
    interest_rate = interest_rate_override if interest_rate_override is not None else config["interest"]
    writeoff_years = config["writeoff"]
    repayment_rate = params["sl_repayment_rate"]

    results = []
    balance_frozen = loan_amount
    balance_indexed = loan_amount
    total_repaid_frozen = 0
    total_repaid_indexed = 0
    salary = starting_salary

    # Track thresholds separately for each scenario
    threshold_frozen = base_threshold  # Autumn Budget scenario
    threshold_indexed = base_threshold  # Baseline counterfactual (RPI-linked)

    for yr in range(writeoff_years + 1):
        # Calculate calendar year for this repayment year
        calendar_year = year + yr

        if yr == 0:
            results.append({
                "year": 0,
                "calendar_year": calendar_year,
                "annual_repaid_frozen": 0,
                "annual_repaid_indexed": 0,
                "annual_impact": 0,
                "total_repaid_frozen": 0,
                "total_repaid_indexed": 0,
                "cumulative_impact": 0,
                "threshold_frozen": base_threshold,
                "threshold_indexed": base_threshold,
                "balance_frozen": loan_amount,
                "balance_indexed": loan_amount,
            })
            continue

        # Get RPI rate for this calendar year
        rpi_rate = get_rpi_rate(calendar_year)

        # AUTUMN BUDGET SCENARIO (frozen 2027-2029, RPI resumes 2030+)
        # Threshold stays frozen during 2027-2029, then grows with RPI from 2030
        if calendar_year >= 2030:
            threshold_frozen *= (1 + rpi_rate)

        repay_frozen = max(0, (salary - threshold_frozen) * repayment_rate) if salary > threshold_frozen else 0
        actual_frozen = min(repay_frozen, balance_frozen)
        balance_after_frozen = max(0, balance_frozen - actual_frozen)
        balance_frozen = balance_after_frozen + (balance_after_frozen * interest_rate)
        total_repaid_frozen += actual_frozen

        # BASELINE COUNTERFACTUAL (RPI-linked every year from 2027+)
        if calendar_year >= 2027:
            threshold_indexed *= (1 + rpi_rate)

        repay_indexed = max(0, (salary - threshold_indexed) * repayment_rate) if salary > threshold_indexed else 0
        actual_indexed = min(repay_indexed, balance_indexed)
        balance_after_indexed = max(0, balance_indexed - actual_indexed)
        balance_indexed = balance_after_indexed + (balance_after_indexed * interest_rate)
        total_repaid_indexed += actual_indexed

        # Annual impact = difference in repayment this year
        annual_impact = actual_frozen - actual_indexed

        results.append({
            "year": yr,
            "calendar_year": calendar_year,
            "annual_repaid_frozen": actual_frozen,
            "annual_repaid_indexed": actual_indexed,
            "annual_impact": annual_impact,
            "total_repaid_frozen": total_repaid_frozen,
            "total_repaid_indexed": total_repaid_indexed,
            "cumulative_impact": total_repaid_frozen - total_repaid_indexed,
            "threshold_frozen": threshold_frozen,
            "threshold_indexed": threshold_indexed,
            "balance_frozen": balance_frozen,
            "balance_indexed": balance_indexed,
        })

        salary *= (1 + salary_growth_rate)

        # Stop if both loans are fully paid off (balance reached 0 before interest)
        if balance_after_frozen <= 0 and balance_after_indexed <= 0:
            break

    df = pd.DataFrame(results)
    df["plan"] = plan

    return df


def export_lifetime_analysis_csv(
    starting_salaries: list[int] = None,
    loan_amounts: list[int] = None,
    plans: list[str] = None,
    year: int = 2026,
) -> str:
    """Export lifetime repayment analysis for multiple scenarios.

    Args:
        starting_salaries: List of starting salaries to model.
        loan_amounts: List of loan amounts to model.
        plans: List of plans to model.
        year: Tax year for parameters.

    Returns:
        Path to saved CSV file.
    """
    if starting_salaries is None:
        starting_salaries = [30000, 40000, 50000, 60000, 80000]
    if loan_amounts is None:
        loan_amounts = [30000, 45000, 60000]
    if plans is None:
        plans = ["plan1", "plan2", "plan4", "plan5"]

    all_data = []

    for plan in plans:
        for salary in starting_salaries:
            for loan in loan_amounts:
                df = generate_lifetime_repayment_data(
                    starting_salary=salary,
                    loan_amount=loan,
                    plan=plan,
                    year=year,
                )
                all_data.append(df)

    combined = pd.concat(all_data, ignore_index=True)
    output_path = "public/data/student_loan_lifetime_analysis.csv"
    combined.to_csv(output_path, index=False)
    print(f"Exported lifetime analysis to {output_path}")
    return output_path


def calculate_lifetime_additional_deductions(
    starting_salary: float = 30_000,
    salary_growth_rate: float = 0.03,
    years_of_work: int = 40,
    loan_forgiveness_year: int = 30,
    year: int = 2026,
) -> dict:
    """Calculate lifetime additional deductions from student loan.

    Estimates how much more a Plan 2 graduate pays vs someone without a loan
    over their working life, assuming the loan isn't paid off early.

    Args:
        starting_salary: Starting annual salary at age 22.
        salary_growth_rate: Annual salary growth rate.
        years_of_work: Years of employment.
        loan_forgiveness_year: Year when loan is forgiven (30 for Plan 2).
        year: Tax year for parameter lookup.

    Returns:
        Dict with lifetime totals and annual breakdown.
    """
    params = get_tax_parameters(year)
    annual_results = []
    total_extra_deductions = 0
    total_loan_repayments = 0

    for yr in range(years_of_work):
        salary = starting_salary * ((1 + salary_growth_rate) ** yr)

        # Calculate what they'd pay with vs without loan
        with_loan = calculate_marginal_rate(salary, params, has_student_loan=True)
        without_loan = calculate_marginal_rate(
            salary, params, has_student_loan=False
        )

        # Student loan repayment amount (if above threshold and within 30 years)
        if yr < loan_forgiveness_year and salary > params["sl_plan2_threshold"]:
            sl_repayment = (
                salary - params["sl_plan2_threshold"]
            ) * params["sl_repayment_rate"]
        else:
            sl_repayment = 0

        total_loan_repayments += sl_repayment

        # The "extra" they pay is the student loan repayment itself
        extra_this_year = sl_repayment
        total_extra_deductions += extra_this_year

        annual_results.append(
            {
                "year": yr + 1,
                "age": 22 + yr,
                "salary": salary,
                "student_loan_repayment": sl_repayment,
                "marginal_rate_with_loan": with_loan["total_marginal_rate"],
                "marginal_rate_without_loan": without_loan["total_marginal_rate"],
                "marginal_rate_difference": (
                    with_loan["total_marginal_rate"]
                    - without_loan["total_marginal_rate"]
                ),
            }
        )

    return {
        "total_student_loan_repayments": total_loan_repayments,
        "total_extra_deductions": total_extra_deductions,
        "average_annual_extra": total_extra_deductions
        / min(years_of_work, loan_forgiveness_year),
        "annual_breakdown": annual_results,
        "parameters_used": {
            "sl_threshold": params["sl_plan2_threshold"],
            "sl_rate": params["sl_repayment_rate"],
        },
    }


def calculate_complete_marginal_rates(
    year: int = 2026,
    student_loan_plan: str = "PLAN_2",
    num_children: int = 0,
    monthly_rent: float = 0,
    is_couple: bool = False,
    partner_income: float = 0,
    has_postgrad: bool = False,
    income_range: tuple[int, int] = (0, 80_000),
    num_points: int = 161,
    exact_income: float = None,
) -> pd.DataFrame:
    """Calculate complete marginal tax rates including UC using PolicyEngine UK.

    This function calculates the true marginal deduction rate including:
    - Income tax
    - National Insurance
    - Student loan repayments
    - Postgraduate loan repayments (if has_postgrad is True)
    - Universal Credit taper (55% withdrawal rate)

    For UC recipients, marginal rates can reach 80%+ due to the UC taper
    interacting with income tax and NI.

    Args:
        year: Tax year for calculation.
        student_loan_plan: Student loan plan (NONE, PLAN_1, PLAN_2, PLAN_4, PLAN_5, POSTGRADUATE).
        num_children: Number of dependent children (affects UC eligibility and work allowance).
        monthly_rent: Monthly rent amount (affects UC housing element).
        is_couple: Whether the claimant has a partner (affects UC standard allowance).
        has_postgrad: Whether borrower has postgraduate loan (6% above threshold).
        partner_income: Partner's annual employment income (if couple).
        income_range: (min, max) employment income range.
        num_points: Number of income points to calculate.
        exact_income: Optional exact income point to include in calculation.

    Returns:
        DataFrame with income levels and complete marginal rate breakdown.
    """
    # Build the situation based on household composition
    people = {
        "adult": {
            "age": {year: 30},
            "employment_income": {year: 0},
        }
    }

    members = ["adult"]

    # Add partner if couple
    if is_couple:
        people["partner"] = {
            "age": {year: 30},
            "employment_income": {year: partner_income},
        }
        members.append("partner")

    # Add children if specified
    for i in range(num_children):
        child_id = f"child_{i+1}"
        people[child_id] = {
            "age": {year: 5 + i * 2},  # Ages 5, 7, 9, etc.
        }
        members.append(child_id)

    # Add student loan plan if not NONE
    if student_loan_plan and student_loan_plan != "NONE":
        people["adult"]["student_loan_plan"] = {year: student_loan_plan}

    situation = {
        "people": people,
        "benunits": {
            "benunit": {
                "members": members,
            }
        },
        "households": {
            "household": {
                "members": members,
                "region": {year: "LONDON"},
            }
        },
        "axes": [
            [
                {
                    "name": "employment_income",
                    "min": income_range[0],
                    "max": income_range[1],
                    "count": num_points,
                    "period": str(year),
                }
            ]
        ],
    }

    # Add rent if specified (enables UC housing element)
    if monthly_rent > 0:
        situation["households"]["household"]["rent"] = {year: monthly_rent * 12}

    # Set UC claim status - claim UC if eligible (children or low income with housing)
    if num_children > 0 or monthly_rent > 0:
        situation["benunits"]["benunit"]["would_claim_uc"] = {year: True}

    sim = Simulation(situation=situation)

    # Get household-level values (these are already aggregated)
    universal_credit = sim.calculate("universal_credit", year)
    household_net_income = sim.calculate("household_net_income", year)

    # Get child benefit (benefit unit level)
    child_benefit = sim.calculate("child_benefit", year)
    child_benefit_less_tax_charge = sim.calculate("child_benefit_less_tax_charge", year)

    # Get TV licence (household level)
    tv_licence = sim.calculate("tv_licence", year)

    # Get person-level values and aggregate to household level
    # The axes create num_points variations, so we need to reshape and sum
    num_people = 1 + (1 if is_couple else 0) + num_children
    employment_income_raw = sim.calculate("employment_income", year)
    income_tax_raw = sim.calculate("income_tax", year)
    ni_raw = sim.calculate("national_insurance", year)
    student_loan_raw = sim.calculate("student_loan_repayment", year)

    # Reshape to (num_points, num_people) and get adult's income only (first person)
    # The adult is always the first person in the members list
    employment_income_reshaped = employment_income_raw.reshape(-1, num_people)
    adult_employment_income = employment_income_reshaped[:, 0]  # Adult's income only (the varying axis)

    # Sum taxes across all household members
    income_tax = income_tax_raw.reshape(-1, num_people).sum(axis=1)
    ni = ni_raw.reshape(-1, num_people).sum(axis=1)
    student_loan = student_loan_raw.reshape(-1, num_people).sum(axis=1)

    # Use adult's employment income for the x-axis
    employment_income = adult_employment_income

    # Calculate marginal rates using gradient
    delta = employment_income[1] - employment_income[0] if len(employment_income) > 1 else 500

    income_tax_marginal = np.gradient(income_tax, delta)
    ni_marginal = np.gradient(ni, delta)
    sl_marginal = np.gradient(student_loan, delta)

    # Calculate HICBC (High Income Child Benefit Charge) marginal rate
    # HICBC is included in income_tax, so we need to separate it
    hicbc = child_benefit - child_benefit_less_tax_charge  # Amount of CB clawed back
    hicbc_marginal = np.gradient(hicbc, delta)  # HICBC marginal rate
    hicbc_marginal = np.clip(hicbc_marginal, 0, 1)  # Clamp to valid range

    # Calculate PA (Personal Allowance) taper marginal rate
    # PA taper: £100k-£125,140, lose £1 PA for every £2 over £100k
    # Instead of hardcoding 20%, derive from PolicyEngine's actual rates

    # Get tax parameters to determine rate bands
    params = get_tax_parameters(year)
    basic_rate = params["basic_rate"]  # 0.20
    higher_rate = params["higher_rate"]  # 0.40
    additional_rate = params["additional_rate"]  # 0.45
    pa_amount = params["personal_allowance"]
    basic_threshold = pa_amount  # ~£12,570
    higher_threshold = params["basic_rate_threshold"]  # ~£50,270 (where higher rate starts)
    additional_threshold = params["higher_rate_threshold"]  # ~£125,140 (where additional rate starts)

    # Calculate expected "pure" income tax marginal rate based on income band
    # (without PA taper or HICBC effects)
    expected_it_marginal = np.select(
        [
            employment_income <= basic_threshold,  # Below PA
            employment_income <= higher_threshold,  # Basic rate band
            employment_income <= additional_threshold,  # Higher rate band
            employment_income > additional_threshold,  # Additional rate band
        ],
        [0.0, basic_rate, higher_rate, additional_rate],
        default=higher_rate
    )

    # Remove HICBC from PolicyEngine's rate first
    it_without_hicbc = income_tax_marginal - hicbc_marginal
    it_without_hicbc = np.clip(it_without_hicbc, 0, 1)

    # PA taper is the excess above expected rate (only in £100k-£125,140 range)
    pa_taper_start = 100000
    pa_taper_end = additional_threshold  # £125,140
    pa_taper_marginal = np.where(
        (employment_income > pa_taper_start) & (employment_income <= pa_taper_end),
        np.maximum(it_without_hicbc - expected_it_marginal, 0),  # Excess above expected
        0.0
    )

    # Use expected IT marginal rate based on tax bands (avoids gradient boundary effects)
    # This gives clean 20%/40%/45% rates instead of transitional values like 48.6%
    income_tax_pure_marginal = expected_it_marginal

    # Postgrad loan: 6% above threshold (calculated manually, not from PolicyEngine)
    # This allows having both undergrad AND postgrad loan simultaneously
    postgrad_threshold = params["sl_postgrad_threshold"]
    postgrad_rate = params["sl_postgrad_rate"]

    if has_postgrad:
        # Postgrad marginal rate is 6% (or configured rate) above threshold
        postgrad_marginal = np.where(employment_income > postgrad_threshold, postgrad_rate, 0.0)
    else:
        postgrad_marginal = np.zeros_like(employment_income)

    # UC marginal rate is negative (benefit withdrawal)
    # We want to show it as positive (deduction from net income)
    uc_change = np.gradient(universal_credit, delta)
    uc_marginal = -uc_change  # Negative change in UC = positive marginal rate

    # Total marginal rate = 1 - (change in net income / change in gross income)
    net_income_change = np.gradient(household_net_income, delta)
    total_marginal = 1 - net_income_change

    # Clamp values between 0 and 1
    total_marginal = np.clip(total_marginal, 0, 1)
    uc_marginal = np.clip(uc_marginal, 0, 1)

    df = pd.DataFrame({
        "employment_income": employment_income,
        "income_tax": income_tax,
        "national_insurance": ni,
        "student_loan_repayment": student_loan,
        "universal_credit": universal_credit,
        "child_benefit": child_benefit,
        "tv_licence": tv_licence,
        "household_net_income": household_net_income,
        "income_tax_marginal_rate": income_tax_pure_marginal,  # Pure IT without HICBC/PA taper
        "pa_taper_marginal_rate": pa_taper_marginal,  # Personal Allowance taper rate
        "hicbc_marginal_rate": hicbc_marginal,  # Child Benefit clawback rate
        "ni_marginal_rate": ni_marginal,
        "student_loan_marginal_rate": sl_marginal,
        "postgrad_marginal_rate": postgrad_marginal,
        "uc_marginal_rate": uc_marginal,
        "total_marginal_rate": total_marginal,
    })

    # If exact_income is provided, interpolate values from the grid (avoids expensive second simulation)
    if exact_income is not None and exact_income not in employment_income:
        # Find the position and interpolate
        idx = np.searchsorted(employment_income, exact_income)
        if idx == 0:
            idx = 1
        elif idx >= len(employment_income):
            idx = len(employment_income) - 1

        # Linear interpolation between neighboring points
        x0, x1 = employment_income[idx-1], employment_income[idx]
        t = (exact_income - x0) / (x1 - x0) if x1 != x0 else 0

        def interp(arr):
            return arr[idx-1] + t * (arr[idx] - arr[idx-1])

        # Use marginal rates from the closest point (they're step functions anyway)
        closest_idx = idx if abs(employment_income[idx] - exact_income) < abs(employment_income[idx-1] - exact_income) else idx - 1

        exact_row = pd.DataFrame([{
            "employment_income": exact_income,
            "income_tax": interp(income_tax),
            "national_insurance": interp(ni),
            "student_loan_repayment": interp(student_loan),
            "universal_credit": interp(universal_credit),
            "child_benefit": interp(child_benefit),
            "tv_licence": interp(tv_licence),
            "household_net_income": interp(household_net_income),
            "income_tax_marginal_rate": income_tax_pure_marginal[closest_idx],
            "pa_taper_marginal_rate": pa_taper_marginal[closest_idx],
            "hicbc_marginal_rate": hicbc_marginal[closest_idx],
            "ni_marginal_rate": ni_marginal[closest_idx],
            "student_loan_marginal_rate": sl_marginal[closest_idx],
            "postgrad_marginal_rate": postgrad_marginal[closest_idx],
            "uc_marginal_rate": uc_marginal[closest_idx],
            "total_marginal_rate": total_marginal[closest_idx],
        }])

        df = pd.concat([df, exact_row], ignore_index=True)
        df = df.sort_values("employment_income").reset_index(drop=True)

    # Add scalar metadata columns
    df["num_children"] = num_children
    df["monthly_rent"] = monthly_rent
    df["student_loan_plan"] = student_loan_plan
    df["has_postgrad"] = has_postgrad
    return df


def export_to_csv(
    df: pd.DataFrame,
    filename: str = "student_loan_effective_ni.csv",
) -> str:
    """Export results to CSV for frontend consumption.

    Args:
        df: DataFrame with marginal rate data.
        filename: Output filename.

    Returns:
        Path to the saved file.
    """
    output_path = f"public/data/{filename}"
    df.to_csv(output_path, index=False)
    return output_path


def export_parameters_csv(years: list[int] = None) -> str:
    """Export tax parameters for multiple years to CSV.

    Args:
        years: List of years to export. Defaults to 2025-2030.

    Returns:
        Path to the saved file.
    """
    if years is None:
        years = [2025, 2026, 2027, 2028, 2029, 2030]

    rows = []
    for year in years:
        params = get_tax_parameters(year)
        params["year"] = year
        rows.append(params)

    df = pd.DataFrame(rows)
    output_path = "public/data/student_loan_parameters.csv"
    df.to_csv(output_path, index=False)
    print(f"Exported parameters to {output_path}")
    return output_path


if __name__ == "__main__":
    print("Generating student loan as effective NI analysis...")
    print("(All rates read from PolicyEngine UK parameters)\n")

    # Export parameters for all years first
    export_parameters_csv()

    # Export lifetime analysis data
    print("\n=== Generating Lifetime Analysis Data ===")
    export_lifetime_analysis_csv()

    # Load and display parameters
    year = 2026
    params = get_tax_parameters(year)
    print(f"\n=== {year} Tax Parameters (from PE UK) ===")
    print(f"Personal allowance: £{params['personal_allowance']:,}")
    print(f"Basic rate: {params['basic_rate']*100:.0f}%")
    print(f"Higher rate: {params['higher_rate']*100:.0f}%")
    print(f"Additional rate: {params['additional_rate']*100:.0f}%")
    print(f"Basic rate threshold: £{params['basic_rate_threshold']:,.0f}")
    print(f"Higher rate threshold: £{params['higher_rate_threshold']:,}")
    print(f"PA taper threshold: £{params['pa_taper_threshold']:,}")
    print(f"\nNI primary threshold: £{params['ni_primary_threshold']:,.0f}")
    print(f"NI UEL: £{params['ni_upper_earnings_limit']:,.0f}")
    print(f"NI main rate: {params['ni_main_rate']*100:.0f}%")
    print(f"NI higher rate: {params['ni_higher_rate']*100:.0f}%")
    print(f"\nStudent loan Plan 2 threshold: £{params['sl_plan2_threshold']:,}")
    print(f"Student loan repayment rate: {params['sl_repayment_rate']*100:.0f}%")

    # Display interest rate info
    print(f"\n=== Student Loan Interest Rates ===")
    print(f"Plan 1 interest: {params['sl_plan1_interest']*100:.1f}%")
    print(f"Plan 2 interest (min): {params['sl_plan2_interest_min']*100:.1f}%")
    print(f"Plan 2 interest (max): {params['sl_plan2_interest_max']*100:.1f}%")
    print(f"Plan 4 interest: {params['sl_plan4_interest']*100:.1f}%")
    print(f"Plan 5 interest: {params['sl_plan5_interest']*100:.1f}%")

    print(f"\n=== Write-off Periods ===")
    print(f"Plan 1: {params['sl_plan1_writeoff']} years")
    print(f"Plan 2: {params['sl_plan2_writeoff']} years")
    print(f"Plan 4: {params['sl_plan4_writeoff']} years")
    print(f"Plan 5: {params['sl_plan5_writeoff']} years")

    # Simple comparison
    simple_df = generate_simple_comparison(year=year)
    print("\n=== Simple Rate Comparison ===")
    sample_incomes = [30_000, 50_000, 80_000, 120_000]
    for income in sample_incomes:
        row_with = simple_df[
            (simple_df["gross_income"] == income)
            & (simple_df["scenario"] == "With Plan 2 loan (under 35)")
        ].iloc[0]
        row_without = simple_df[
            (simple_df["gross_income"] == income)
            & (simple_df["scenario"] == "No student loan (over 40)")
        ].iloc[0]
        print(f"\n£{income:,}:")
        print(
            f"  Without loan: {row_without['total_marginal_rate']*100:.0f}% "
            f"(IT: {row_without['income_tax_rate']*100:.0f}%, "
            f"NI: {row_without['ni_rate']*100:.0f}%)"
        )
        print(
            f"  With Plan 2:  {row_with['total_marginal_rate']*100:.0f}% "
            f"(IT: {row_with['income_tax_rate']*100:.0f}%, "
            f"NI: {row_with['ni_rate']*100:.0f}%, "
            f"SL: {row_with['student_loan_rate']*100:.0f}%)"
        )

    # Key thresholds
    print("\n=== Key Marginal Rate Thresholds ===")
    for t in get_key_thresholds(year):
        print(f"\n£{t['threshold']:,}: {t['description']}")
        print(f"  Without loan: {t['rate_without_sl']}")
        print(f"  With Plan 2:  {t['rate_with_sl']}")

    # Lifetime impact
    print("\n=== Lifetime Additional Deductions (£30k start, 3% growth) ===")
    lifetime = calculate_lifetime_additional_deductions(year=year)
    print(
        f"Student loan threshold: £{lifetime['parameters_used']['sl_threshold']:,}"
    )
    print(
        f"Repayment rate: {lifetime['parameters_used']['sl_rate']*100:.0f}%"
    )
    print(
        f"Total student loan repayments over career: "
        f"£{lifetime['total_student_loan_repayments']:,.0f}"
    )
    print(
        f"Average annual repayment (first 30 years): "
        f"£{lifetime['average_annual_extra']:,.0f}"
    )

    # PolicyEngine simulation comparison
    try:
        print("\n=== PolicyEngine Full Simulation Comparison ===")
        cohort_df = generate_cohort_comparison(year=year, num_points=31)

        # Show rates at key income levels
        for income in sample_incomes:
            print(f"\nAt £{income:,} gross income:")
            subset = cohort_df[
                cohort_df["employment_income"].between(income - 2500, income + 2500)
            ]
            for cohort_name in subset["cohort_name"].unique():
                row = subset[subset["cohort_name"] == cohort_name].iloc[0]
                print(
                    f"  {cohort_name}: {row['total_marginal_rate']*100:.1f}% "
                    f"(IT: {row['income_tax_marginal_rate']*100:.1f}%, "
                    f"NI: {row['ni_marginal_rate']*100:.1f}%, "
                    f"SL: {row['student_loan_marginal_rate']*100:.1f}%)"
                )

        # Export for dashboard
        export_to_csv(cohort_df, "student_loan_marginal_rates.csv")
        print("\nExported to public/data/student_loan_marginal_rates.csv")

    except Exception as e:
        print(f"\nPolicyEngine simulation comparison failed: {e}")
        import traceback

        traceback.print_exc()
